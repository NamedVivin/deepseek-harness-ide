import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { GuardianNativeSpawnSpec, MacOsCapsulePreparation, MacOsCapsuleProcess } from '../src/supervisor.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { MacOsProcessCapsuleTransport, type MacOsProcessCapsuleOptions } from '../src/macos-capsule.ts'

const MAGIC = 0x44534843
const VERSION = 1
const SPEC = 1
const CONFIRM = 2
const RESUME = 3
const TERMINATE = 4
const RELEASE = 5
const PREPARED = 101
const CONFIRMED = 102
const RESUMED = 103
const EXIT = 104
const GROUP_ZERO = 105
const RELEASED = 106
const NATIVE_ERROR = 255

interface FakeChildOptions {
  readonly pid?: number | undefined
  readonly preparedPid?: number
  readonly processGroupId?: number
  readonly preparedStatus?: number
  readonly commandStatus?: Partial<Record<number, number>>
  readonly writeErrors?: ReadonlySet<number>
  readonly splitEvents?: boolean
  readonly autoExit?: boolean
  readonly exitCode?: number
  readonly exitSignal?: number
  readonly autoGroupZero?: boolean
  readonly releaseExit?: 'already' | 'event' | 'error'
  readonly missingStdio?: number
  readonly malformedEvent?: boolean
  readonly controlCallbackUndefined?: boolean
}

class FakeCapsuleChild extends EventEmitter {
  readonly events = new PassThrough()
  readonly targetStdin = new PassThrough()
  readonly targetStdout = new PassThrough()
  readonly targetStderr = new PassThrough()
  readonly controlFrames: Buffer[] = []
  readonly stdio: unknown[]
  readonly pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private readonly options: FakeChildOptions

  constructor(options: FakeChildOptions = {}) {
    super()
    this.options = options
    this.pid = Object.hasOwn(options, 'pid') ? options.pid : 700
    const control = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const frame = Buffer.from(chunk)
        this.controlFrames.push(frame)
        const type = frame.readUInt16LE(6)
        if (options.writeErrors?.has(type) === true) {
          callback(new Error(`control write ${String(type)} failed`))
          return
        }
        callback()
        queueMicrotask(() => { this.respond(type) })
      },
    })
    control.on('error', () => undefined)
    const controlFace = options.controlCallbackUndefined === true
      ? {
        write: (chunk: Buffer, callback: (error?: Error | null) => void): boolean => {
          const frame = Buffer.from(chunk)
          this.controlFrames.push(frame)
          callback(undefined)
          queueMicrotask(() => { this.respond(frame.readUInt16LE(6)) })
          return true
        },
        end: () => undefined,
      }
      : control
    this.stdio = [controlFace, this.events, null, this.targetStdin, this.targetStdout, this.targetStderr, null]
    if (options.missingStdio !== undefined) this.stdio[options.missingStdio] = null
  }

  emitNative(type: number, fields: Partial<{
    status: number
    pid: number
    processGroupId: number
    exitCode: number
    signal: number
  }> = {}): void {
    const frame = Buffer.alloc(32)
    frame.writeUInt32LE(this.options.malformedEvent === true ? 0 : MAGIC, 0)
    frame.writeUInt16LE(VERSION, 4)
    frame.writeUInt16LE(type, 6)
    frame.writeInt32LE(fields.status ?? 0, 8)
    frame.writeInt32LE(fields.pid ?? 0, 12)
    frame.writeInt32LE(fields.processGroupId ?? 0, 16)
    frame.writeInt32LE(fields.exitCode ?? 0, 20)
    frame.writeInt32LE(fields.signal ?? 0, 24)
    if (this.options.splitEvents === true) {
      this.events.write(frame.subarray(0, 11))
      this.events.write(frame.subarray(11))
    } else {
      this.events.write(frame)
    }
  }

  private respond(type: number): void {
    if (type === SPEC) {
      this.emitNative(PREPARED, {
        ...(this.options.preparedStatus === undefined ? {} : { status: this.options.preparedStatus }),
        pid: this.options.preparedPid ?? 501,
        processGroupId: this.options.processGroupId ?? 502,
      })
      return
    }
    const status = this.options.commandStatus?.[type]
    const statusFields = status === undefined ? {} : { status }
    if (type === CONFIRM) this.emitNative(CONFIRMED, statusFields)
    if (type === RESUME) {
      this.emitNative(RESUMED, statusFields)
      if (status === undefined || status === 0) {
        if (this.options.autoExit !== false) {
          this.emitNative(EXIT, {
            exitCode: this.options.exitCode ?? 0,
            signal: this.options.exitSignal ?? 0,
          })
        }
        if (this.options.autoGroupZero !== false) this.emitNative(GROUP_ZERO)
      }
    }
    if (type === TERMINATE && this.options.autoGroupZero !== false) this.emitNative(GROUP_ZERO, statusFields)
    if (type === RELEASE) {
      if (this.options.releaseExit === 'already' || this.options.releaseExit === undefined) this.exitCode = 0
      this.emitNative(RELEASED, statusFields)
      if (this.options.releaseExit === 'event') {
        setTimeout(() => {
          this.exitCode = 0
          this.emit('exit', 0, null)
        }, 0)
      } else if (this.options.releaseExit === 'error') {
        setTimeout(() => { this.emit('error', new Error('capsule exit observation failed')) }, 0)
      }
    }
  }
}

function options(overrides: Partial<MacOsProcessCapsuleOptions> = {}): MacOsProcessCapsuleOptions {
  return {
    helperPath: '/signed/process-capsule',
    mainLivenessFd: 6,
    maxSpecBytes: 4096,
    groupPollMs: 5,
    ...overrides,
  }
}

function spec(overrides: Partial<GuardianNativeSpawnSpec> = {}): GuardianNativeSpawnSpec {
  return {
    argv: ['/bin/tool', '--flag'],
    cwd: '/workspace',
    env: { A: 'one' },
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 100,
    ...overrides,
  }
}

function useChild(settings: FakeChildOptions = {}): FakeCapsuleChild {
  const child = new FakeCapsuleChild(settings)
  spawnMock.mockReturnValueOnce(child)
  return child
}

function eventFrame(type: number, fields: Partial<{ status: number; signal: number }> = {}): Buffer {
  const frame = Buffer.alloc(32)
  frame.writeUInt32LE(MAGIC, 0)
  frame.writeUInt16LE(VERSION, 4)
  frame.writeUInt16LE(type, 6)
  frame.writeInt32LE(fields.status ?? 0, 8)
  frame.writeInt32LE(fields.signal ?? 0, 24)
  return frame
}

beforeEach(() => {
  spawnMock.mockReset()
})

describe('MacOsProcessCapsuleTransport contract paths', () => {
  it.each([
    [{ mainLivenessFd: 2 }, 'mainLivenessFd'],
    [{ mainLivenessFd: Number.NaN }, 'mainLivenessFd'],
    [{ maxSpecBytes: 31 }, 'maxSpecBytes'],
    [{ maxSpecBytes: Number.NaN }, 'maxSpecBytes'],
    [{ groupPollMs: 0 }, 'groupPollMs'],
    [{ groupPollMs: Number.NaN }, 'groupPollMs'],
  ] as const)('rejects invalid transport option %#', (override, message) => {
    expect(() => new MacOsProcessCapsuleTransport(options(override))).toThrow(message)
  })

  it('validates platform, absolute helper path, and helper presence', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(new MacOsProcessCapsuleTransport(options()).init()).rejects.toThrow('requires macOS')
    platform.mockRestore()
    await expect(new MacOsProcessCapsuleTransport(options({ helperPath: 'relative' })).init()).rejects.toThrow('must be absolute')
    await expect(new MacOsProcessCapsuleTransport(options({ helperPath: '/definitely/missing/helper' })).init()).rejects.toThrow()
    await expect(new MacOsProcessCapsuleTransport(options({ helperPath: '/bin/sh' })).init()).resolves.toBeUndefined()
  })

  it('round-trips split events, pipe streams, success outcome, and immediate child exit', async () => {
    const child = useChild({ splitEvents: true })
    const transport = new MacOsProcessCapsuleTransport(options())
    const prepared = await transport.prepare(spec(), new AbortController().signal)
    expect(prepared.pid).toBe(501)
    expect(prepared.processGroupId).toBe(502)
    expect(prepared.stdin).toBe(child.targetStdin)
    expect(prepared.stdout).toBe(child.targetStdout)
    expect(prepared.stderr).toBe(child.targetStderr)
    await expect(prepared.confirmOwnership('')).rejects.toThrow('not valid')
    await prepared.confirmOwnership('main-receipt')
    await expect(prepared.confirmOwnership('second')).rejects.toThrow('not valid')
    const owned = await prepared.resume()
    await expect(prepared.resume()).rejects.toThrow('not confirmed')
    await expect(owned.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(owned.waitForExit()).resolves.toBe(true)
    await owned.release()
    await owned.release()
    await owned.terminate()
    await prepared.rollback()
    await transport.dispose()
    await transport.dispose()
    await expect(transport.prepare(spec(), new AbortController().signal)).rejects.toThrow('disposing')
    expect(child.controlFrames.map(value => value.readUInt16LE(6))).toEqual([SPEC, CONFIRM, RESUME, RELEASE])
  })

  it('maps a known signal and waits for a later child exit event during release', async () => {
    useChild({ exitSignal: 15, releaseExit: 'event' })
    const transport = new MacOsProcessCapsuleTransport(options())
    const prepared = await transport.prepare(spec({
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }), new AbortController().signal)
    expect(prepared.stdin).toBeUndefined()
    expect(prepared.stdout).toBeUndefined()
    expect(prepared.stderr).toBeUndefined()
    await prepared.confirmOwnership('receipt')
    const owned = await prepared.resume()
    await expect(owned.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await owned.release()
    await transport.dispose()
  })

  it('returns false for caller cancellation while preserving the native group wait', async () => {
    const child = useChild({ autoExit: false, autoGroupZero: false })
    const transport = new MacOsProcessCapsuleTransport(options())
    const prepared = await transport.prepare(spec(), new AbortController().signal)
    await prepared.confirmOwnership('receipt')
    const owned = await prepared.resume()
    const controller = new AbortController()
    const waiting = owned.waitForExit(controller.signal)
    controller.abort(new Error('stop waiting'))
    await expect(waiting).resolves.toBe(false)
    child.emitNative(EXIT, { exitCode: 0 })
    child.emitNative(GROUP_ZERO)
    await expect(owned.waitForExit()).resolves.toBe(true)
    await owned.release()
  })

  it.each([
    [{ preparedStatus: 7 }, 'prepare failed'],
    [{ preparedPid: 0 }, 'invalid target ownership'],
    [{ processGroupId: 0 }, 'invalid target ownership'],
  ] as const)('rolls back invalid preparation event %#', async (settings, message) => {
    useChild(settings)
    const transport = new MacOsProcessCapsuleTransport(options())
    await expect(transport.prepare(spec(), new AbortController().signal)).rejects.toThrow(message)
    await transport.dispose()
  })

  it('rejects command status, control-write, and native-event failures', async () => {
    useChild({ commandStatus: { [CONFIRM]: 9 } })
    const statusTransport = new MacOsProcessCapsuleTransport(options())
    const statusPrepared = await statusTransport.prepare(spec(), new AbortController().signal)
    await expect(statusPrepared.confirmOwnership('receipt')).rejects.toThrow('failed with 9')
    await statusTransport.dispose()

    useChild({ writeErrors: new Set([CONFIRM]) })
    const writeTransport = new MacOsProcessCapsuleTransport(options())
    const writePrepared = await writeTransport.prepare(spec(), new AbortController().signal)
    await expect(writePrepared.confirmOwnership('receipt')).rejects.toThrow('control write 2 failed')

    useChild({ writeErrors: new Set([SPEC]) })
    const initialWrite = new MacOsProcessCapsuleTransport(options())
    await expect(initialWrite.prepare(spec(), new AbortController().signal)).rejects.toThrow('control write 1 failed')

    const child = useChild({ autoExit: false, autoGroupZero: false })
    const transport = new MacOsProcessCapsuleTransport(options())
    const prepared = await transport.prepare(spec(), new AbortController().signal)
    child.emitNative(NATIVE_ERROR, { status: 31 })
    await expect((prepared as unknown as MacOsCapsuleProcess).done).rejects.toThrow('native error 31')
  })

  it('rejects malformed native records and unknown POSIX signals', async () => {
    useChild({ autoExit: false, autoGroupZero: false })
    const malformedTransport = new MacOsProcessCapsuleTransport(options())
    const malformed = await malformedTransport.prepare(spec(), new AbortController().signal)
    const malformedFrame = eventFrame(EXIT)
    malformedFrame.writeUInt32LE(0, 0)
    expect(() => { (malformed as unknown as { receive(value: Buffer): void }).receive(malformedFrame) })
      .toThrow('malformed capsule event')

    useChild({ autoExit: false, autoGroupZero: false })
    const signalTransport = new MacOsProcessCapsuleTransport(options())
    const unknownSignal = await signalTransport.prepare(spec(), new AbortController().signal)
    expect(() => { (unknownSignal as unknown as { receive(value: Buffer): void }).receive(eventFrame(EXIT, { signal: 999 })) })
      .toThrow('unknown signal')
  })

  it('rejects missing helper streams before publishing a preparation', async () => {
    for (const missingStdio of [0, 1, 3, 4, 5]) {
      useChild({ missingStdio })
      const transport = new MacOsProcessCapsuleTransport(options())
      await expect(transport.prepare(spec(), new AbortController().signal)).rejects.toThrow('helper omitted')
    }
  })

  it('rejects NUL and oversized specifications before sending native bytes', async () => {
    useChild()
    const nul = new MacOsProcessCapsuleTransport(options())
    await expect(nul.prepare(spec({ cwd: 'bad\0cwd' }), new AbortController().signal)).rejects.toThrow('contains NUL')

    useChild()
    const oversized = new MacOsProcessCapsuleTransport(options({ maxSpecBytes: 40 }))
    await expect(oversized.prepare(spec(), new AbortController().signal)).rejects.toThrow('exceeds 40 bytes')
  })

  it('propagates pre-launch and in-flight cancellation', async () => {
    const transport = new MacOsProcessCapsuleTransport(options())
    await expect(transport.prepare(spec(), AbortSignal.abort(new Error('already cancelled')))).rejects.toThrow('already cancelled')
    expect(spawnMock).not.toHaveBeenCalled()

    const child = useChild()
    const original = child.emitNative.bind(child)
    child.emitNative = (type, fields) => { if (type !== PREPARED) original(type, fields) }
    const controller = new AbortController()
    const preparing = transport.prepare(spec(), controller.signal)
    controller.abort(new Error('cancel preparation'))
    await expect(preparing).rejects.toThrow('cancel preparation')
  })

  it('aggregates rollback failures during transport disposal', async () => {
    useChild({ commandStatus: { [RELEASE]: 17 } })
    const transport = new MacOsProcessCapsuleTransport(options())
    await transport.prepare(spec(), new AbortController().signal)
    await expect(transport.dispose()).rejects.toMatchObject({ name: 'AggregateError' })
  })

  it('guards release when the group-empty predicate is false', async () => {
    useChild()
    const transport = new MacOsProcessCapsuleTransport(options())
    const prepared = await transport.prepare(spec(), new AbortController().signal)
    await prepared.confirmOwnership('receipt')
    const owned = await prepared.resume()
    ;(owned as { waitForExit(signal?: AbortSignal): Promise<boolean> }).waitForExit = async () => false
    await expect(owned.release()).rejects.toThrow('group is not empty')
  })

  it('accepts an undefined write callback status and contains terminate failure during rollback', async () => {
    useChild({ pid: undefined, controlCallbackUndefined: true })
    const transport = new MacOsProcessCapsuleTransport(options())
    const prepared = await transport.prepare(spec(), new AbortController().signal)
    ;(prepared as unknown as { terminate(): Promise<void> }).terminate = async () => { throw new Error('terminate failed') }
    ;(prepared as unknown as { waitForExit(): Promise<boolean> }).waitForExit = async () => true
    await expect(prepared.rollback()).resolves.toBeUndefined()
  })

  it('propagates child failure before release and errors while waiting for release exit', async () => {
    const unexpected = useChild({ autoExit: false, autoGroupZero: false })
    const first = new MacOsProcessCapsuleTransport(options())
    const preparing = first.prepare(spec(), new AbortController().signal)
    unexpected.emit('error', new Error('helper launch failed'))
    await expect(preparing).rejects.toThrow('helper launch failed')

    const releaseError = useChild({ releaseExit: 'error' })
    const second = new MacOsProcessCapsuleTransport(options())
    const prepared = await second.prepare(spec(), new AbortController().signal)
    await prepared.confirmOwnership('receipt')
    const owned = await prepared.resume()
    await expect(owned.release()).rejects.toThrow('capsule exit observation failed')
    releaseError.exitCode = 1
  })

  it('rejects an unexpected helper exit and wakes every waiter for the same native event', async () => {
    const child = useChild({ autoExit: false, autoGroupZero: false })
    const transport = new MacOsProcessCapsuleTransport(options())
    const prepared = await transport.prepare(spec(), new AbortController().signal)
    const connection = prepared as MacOsCapsulePreparation & MacOsCapsuleProcess & {
      waitEvent(type: number): Promise<unknown>
    }
    const first = connection.waitEvent(GROUP_ZERO)
    const second = connection.waitEvent(GROUP_ZERO)
    child.emitNative(777)
    child.emitNative(GROUP_ZERO)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    child.emit('exit', 2, 'SIGKILL')
    await expect(connection.done).rejects.toThrow('exited unexpectedly')
  })
})
