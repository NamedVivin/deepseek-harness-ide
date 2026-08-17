import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
  DESKTOP_GUARDIAN_CONTROL_VERSION,
  DesktopGuardianMainOwner,
  isDesktopGuardianControlEnvelope,
  parseDesktopGuardianControlInboundFrame,
  parseDesktopGuardianControlOutboundFrame,
  type DesktopGuardianControlChild,
  type DesktopGuardianControlInboundFrame,
  type DesktopGuardianProcessControl,
} from '../src/guardian-control.ts'
import { parseDesktopGuardianArguments } from '../src/guardian.ts'

const commonArguments = [
  '--sidecar-entry=/signed/host/lib/sidecar.js',
  '--max-body-bytes=1024',
  '--max-chunk-bytes=64',
  '--max-inflight-bytes=128',
  '--native-poll-ms=5',
  '--graceful-shutdown-ms=100',
  '--force-shutdown-ms=50',
  '--mirror-timeout-ms=200',
]

class FakeGuardianChild extends EventEmitter implements DesktopGuardianControlChild {
  connected = true
  readonly sent: DesktopGuardianControlInboundFrame[] = []

  send(message: DesktopGuardianControlInboundFrame, callback: (error: Error | null) => void): boolean {
    this.sent.push(message)
    queueMicrotask(() => { callback(null) })
    return true
  }
}

class FakeProcessControl implements DesktopGuardianProcessControl {
  readonly processes = new Set<number>()
  readonly groups = new Set<number>()
  readonly signals: string[] = []
  keepAfterTerm = false

  processExists(pid: number): boolean { return this.processes.has(pid) }
  processGroupExists(processGroupId: number): boolean { return this.groups.has(processGroupId) }
  signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(`pid:${String(pid)}:${signal}`)
    if (signal === 'SIGKILL' || !this.keepAfterTerm) this.processes.delete(pid)
  }
  signalProcessGroup(processGroupId: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(`pgid:${String(processGroupId)}:${signal}`)
    if (signal === 'SIGKILL' || !this.keepAfterTerm) this.groups.delete(processGroupId)
  }
  delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(() => { resolve() }, milliseconds) })
  }
}

async function turns(count = 5): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  }
}

function mainOwner(child: FakeGuardianChild, control: FakeProcessControl): DesktopGuardianMainOwner {
  return new DesktopGuardianMainOwner(child, {
    gracefulShutdownMs: 1,
    forceShutdownMs: 5,
    nativeProcessPollMs: 1,
    platform: 'darwin',
    processControl: control,
  })
}

describe('desktop guardian configuration and privileged control', () => {
  it('parses the closed Windows and macOS guardian command lines', () => {
    expect(parseDesktopGuardianArguments(commonArguments, 'win32')).toEqual({
      sidecarEntry: '/signed/host/lib/sidecar.js',
      maxBodyBytes: 1024,
      maxChunkBytes: 64,
      maxInflightBytes: 128,
      nativePollMs: 5,
      gracefulShutdownMs: 100,
      forceShutdownMs: 50,
      mirrorTimeoutMs: 200,
    })
    expect(parseDesktopGuardianArguments([
      ...commonArguments,
      '--capsule-helper=/signed/native/dsh-process-capsule',
      '--main-liveness-fd=4',
    ], 'darwin')).toMatchObject({
      capsuleHelper: '/signed/native/dsh-process-capsule',
      mainLivenessFd: 4,
    })
  })

  it('rejects unknown, duplicate, unsafe, and inconsistent guardian arguments', () => {
    expect(() => parseDesktopGuardianArguments([...commonArguments, '--extra=1'], 'win32')).toThrow('unknown')
    expect(() => parseDesktopGuardianArguments([...commonArguments, commonArguments[0] as string], 'win32')).toThrow('duplicate')
    expect(() => parseDesktopGuardianArguments(commonArguments.map(value => value === commonArguments[0]
      ? '--sidecar-entry=relative.js'
      : value), 'win32')).toThrow('absolute')
    expect(() => parseDesktopGuardianArguments(commonArguments.map(value => value === '--max-inflight-bytes=128'
      ? '--max-inflight-bytes=32'
      : value), 'win32')).toThrow('max chunk')
    expect(() => parseDesktopGuardianArguments([
      ...commonArguments,
      '--capsule-helper=/signed/native/dsh-process-capsule',
      '--main-liveness-fd=2',
    ], 'darwin')).toThrow('inherited descriptor')
  })

  it('validates every guardian-to-main ownership frame', () => {
    const header = {
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
    } as const
    expect(parseDesktopGuardianControlOutboundFrame({
      ...header,
      type: 'sidecar-started',
      sidecarPid: 41,
    })).toMatchObject({ type: 'sidecar-started', sidecarPid: 41 })
    expect(parseDesktopGuardianControlOutboundFrame({
      ...header,
      type: 'register',
      requestId: 'request-1',
      capsuleId: 'capsule-1',
      pid: 42,
      processGroupId: 43,
    })).toMatchObject({ type: 'register', pid: 42, processGroupId: 43 })
    expect(parseDesktopGuardianControlOutboundFrame({
      ...header,
      type: 'release',
      requestId: 'request-2',
      capsuleId: 'capsule-1',
    })).toMatchObject({ type: 'release' })
    expect(parseDesktopGuardianControlOutboundFrame({
      ...header,
      type: 'recover',
      requestId: 'request-3',
      capsuleId: 'capsule-1',
      reason: 'capsule helper crashed',
    })).toMatchObject({ type: 'recover' })
    expect(parseDesktopGuardianControlOutboundFrame({ type: 'connection-frame' })).toBeUndefined()
    expect(() => parseDesktopGuardianControlOutboundFrame({
      ...header,
      type: 'sidecar-started',
      sidecarPid: 0,
    })).toThrow('positive pid')
  })

  it('validates main acknowledgements and identifies the reserved namespace', () => {
    const header = {
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
    } as const
    expect(parseDesktopGuardianControlInboundFrame({
      ...header,
      type: 'registered',
      requestId: 'request-1',
      receipt: 'main-receipt',
    })).toMatchObject({ type: 'registered', receipt: 'main-receipt' })
    expect(parseDesktopGuardianControlInboundFrame({
      ...header,
      type: 'released',
      requestId: 'request-2',
    })).toMatchObject({ type: 'released' })
    expect(parseDesktopGuardianControlInboundFrame({
      ...header,
      type: 'recovered',
      requestId: 'request-2b',
    })).toMatchObject({ type: 'recovered' })
    expect(parseDesktopGuardianControlInboundFrame({
      ...header,
      type: 'failed',
      requestId: 'request-3',
      message: 'ownership failed',
    })).toMatchObject({ type: 'failed' })
    expect(isDesktopGuardianControlEnvelope(header)).toBe(true)
    expect(() => parseDesktopGuardianControlInboundFrame({
      ...header,
      type: 'registered',
      requestId: '',
      receipt: 'main-receipt',
    })).toThrow('requestId')
  })

  it('records mirrored groups, refuses an active release, and recovers ownership loss', async () => {
    const child = new FakeGuardianChild()
    const control = new FakeProcessControl()
    const owner = mainOwner(child, control)
    const header = {
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
    } as const
    control.groups.add(43)
    child.emit('message', {
      ...header,
      type: 'register',
      requestId: 'register-1',
      capsuleId: 'capsule-1',
      pid: 42,
      processGroupId: 43,
    })
    await turns()
    expect(child.sent.at(-1)).toMatchObject({ type: 'registered', requestId: 'register-1' })

    child.emit('message', {
      ...header,
      type: 'release',
      requestId: 'release-active',
      capsuleId: 'capsule-1',
    })
    await turns()
    expect(child.sent.at(-1)).toMatchObject({ type: 'failed', requestId: 'release-active' })

    child.emit('message', {
      ...header,
      type: 'recover',
      requestId: 'recover-1',
      capsuleId: 'capsule-1',
      reason: 'capsule helper crashed',
    })
    await turns()
    expect(control.signals).toEqual(['pgid:43:SIGTERM'])
    expect(child.sent.at(-1)).toMatchObject({ type: 'recovered', requestId: 'recover-1' })
    await owner.dispose()
  })

  it('kills and confirms every retained owner after unexpected guardian disconnect', async () => {
    const child = new FakeGuardianChild()
    const control = new FakeProcessControl()
    control.keepAfterTerm = true
    control.processes.add(41)
    control.groups.add(43)
    const owner = mainOwner(child, control)
    const header = {
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
    } as const
    child.emit('message', { ...header, type: 'sidecar-started', sidecarPid: 41 })
    child.emit('message', {
      ...header,
      type: 'register',
      requestId: 'register-1',
      capsuleId: 'capsule-1',
      pid: 42,
      processGroupId: 43,
    })
    await turns()
    child.connected = false
    child.emit('disconnect')
    const failure = await owner.failure
    expect(failure.message).toContain('disconnected')
    await owner.dispose()
    expect(control.signals).toEqual(expect.arrayContaining([
      'pid:41:SIGTERM',
      'pid:41:SIGKILL',
      'pgid:43:SIGTERM',
      'pgid:43:SIGKILL',
    ]))
    expect(control.processes.size).toBe(0)
    expect(control.groups.size).toBe(0)
  })

  it('keeps ownership listeners through expected shutdown without publishing a failure', async () => {
    const child = new FakeGuardianChild()
    const control = new FakeProcessControl()
    control.processes.add(41)
    const owner = mainOwner(child, control)
    const failures: Error[] = []
    owner.onFailure((error) => { failures.push(error) })
    child.emit('message', {
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
      type: 'sidecar-started',
      sidecarPid: 41,
    })
    await turns()
    owner.prepareShutdown()
    child.emit('exit', 0, null)
    await owner.dispose()
    expect(failures).toEqual([])
    expect(control.signals).toEqual(['pid:41:SIGTERM'])
  })

  it('publishes a relayed runtime failure and cleans retained ownership', async () => {
    const child = new FakeGuardianChild()
    const control = new FakeProcessControl()
    control.processes.add(41)
    const owner = mainOwner(child, control)
    child.emit('message', {
      namespace: DESKTOP_GUARDIAN_CONTROL_NAMESPACE,
      version: DESKTOP_GUARDIAN_CONTROL_VERSION,
      type: 'sidecar-started',
      sidecarPid: 41,
    })
    await turns()
    child.emit('message', { version: 1, type: 'desktop-runtime-failed', message: 'bad profile' })
    const failure = await owner.failure
    expect(failure.message).toContain('bad profile')
    await owner.dispose()
    expect(control.processes.size).toBe(0)
  })
})
