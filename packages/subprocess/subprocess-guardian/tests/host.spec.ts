import { describe, expect, it, vi } from 'vitest'
import {
  createNodeGuardianHostEndpoint,
  startGuardianHost,
  type GuardianHostIpcEndpoint,
  type GuardianOwnedSidecar,
} from '../src/host.ts'
import { GuardianProcessId } from '../src/protocol.ts'
import type { FramedGuardianPeer } from '../src/channel.ts'
import type { GuardianNativeSpawnSpec, GuardianPreparedProcess, GuardianProcessSupervisor } from '../src/supervisor.ts'

const limits = { maxBodyBytes: 1024, maxChunkBytes: 64, maxInflightBytes: 128 }

class RawEndpoint implements GuardianHostIpcEndpoint {
  private readonly messages = new Set<(value: unknown) => void>()
  private readonly disconnects = new Set<() => void>()
  peer: RawEndpoint | undefined
  sendFailure: unknown = undefined

  async send(value: unknown): Promise<void> {
    if (this.sendFailure !== undefined) throw this.sendFailure
    const target = this.peer
    if (target === undefined) throw new Error('raw endpoint disconnected')
    queueMicrotask(() => { for (const listener of target.messages) listener(structuredClone(value)) })
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.messages.add(listener)
    return () => { this.messages.delete(listener) }
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnects.add(listener)
    return () => { this.disconnects.delete(listener) }
  }

  disconnect(): void {
    const target = this.peer
    this.peer = undefined
    if (target !== undefined) target.peer = undefined
    for (const listener of this.disconnects) listener()
    for (const listener of target?.disconnects ?? []) listener()
  }
}

class NoopSupervisor implements GuardianProcessSupervisor {
  disposals = 0
  disposeFailure: unknown = undefined

  async prepare(_spec: GuardianNativeSpawnSpec, _signal: AbortSignal): Promise<GuardianPreparedProcess> {
    throw new Error('not used')
  }

  async dispose(): Promise<void> {
    this.disposals += 1
    if (this.disposeFailure !== undefined) throw this.disposeFailure
  }
}

function link(): readonly [RawEndpoint, RawEndpoint] {
  const left = new RawEndpoint()
  const right = new RawEndpoint()
  left.peer = right
  right.peer = left
  return [left, right]
}

function setup(): {
  readonly main: RawEndpoint
  readonly sidecar: RawEndpoint
  readonly owner: GuardianOwnedSidecar
  readonly supervisor: NoopSupervisor
  readonly terminated: () => number
} {
  const [main] = link()
  const [guardianSidecar, sidecar] = link()
  let terminations = 0
  const owner: GuardianOwnedSidecar = {
    pid: 41,
    ipc: guardianSidecar,
    terminateAndJoin: async () => { terminations += 1 },
  }
  return { main, sidecar, owner, supervisor: new NoopSupervisor(), terminated: () => terminations }
}

async function turns(count = 12): Promise<void> {
  for (let index = 0; index < count; index++) await new Promise<void>((resolve) => { queueMicrotask(resolve) })
}

describe('GuardianHost', () => {
  it('relays non-guardian messages in both directions and keeps guardian frames local', async () => {
    const fixture = setup()
    const host = startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: fixture.owner,
      supervisor: fixture.supervisor,
      limits,
    })
    const atSidecar: unknown[] = []
    const atMain: unknown[] = []
    fixture.sidecar.onMessage((value) => { atSidecar.push(value) })
    fixture.main.onMessage((value) => { atMain.push(value) })
    await fixture.main.send({ type: 'desktop-runtime-dispose', sequence: 1 })
    await fixture.main.send({ type: 'desktop-runtime-dispose', sequence: 2 })
    await fixture.main.send('literal desktop frame')
    await fixture.main.send(null)
    await fixture.main.send([])
    await fixture.sidecar.send({ type: 'desktop-runtime-ready' })
    await fixture.sidecar.send({
      namespace: 'dsh.guardian',
      version: 1,
      type: 'process-settled',
      processId: 'process-1',
      settlement: { ok: true, outcome: { exitCode: 0, signal: null } },
    })
    await (host as unknown as { peer: FramedGuardianPeer }).peer.sendProcessSettled(
      GuardianProcessId('host-owned'),
      { ok: true, outcome: { exitCode: 0, signal: null } },
    )
    await turns()
    expect(atSidecar).toEqual([
      { type: 'desktop-runtime-dispose', sequence: 1 },
      { type: 'desktop-runtime-dispose', sequence: 2 },
      expect.objectContaining({
        namespace: 'dsh.guardian',
        type: 'process-settled',
        processId: 'host-owned',
      }),
      'literal desktop frame',
      null,
      [],
    ])
    expect(atMain).toEqual([{ type: 'desktop-runtime-ready' }])
    await host.dispose()
    expect(fixture.terminated()).toBe(1)
    expect(fixture.supervisor.disposals).toBe(1)
  })

  it('consumes app-owned parent control and kills on either physical disconnect', async () => {
    const fixture = setup()
    const controls: unknown[] = []
    const host = startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: fixture.owner,
      supervisor: fixture.supervisor,
      limits,
      isParentControlMessage: (value) => {
        if (typeof value !== 'object' || value === null || !('mirror' in value)) return false
        controls.push(value)
        return true
      },
    })
    const atSidecar: unknown[] = []
    fixture.sidecar.onMessage((value) => { atSidecar.push(value) })
    await fixture.main.send({ mirror: 'receipt' })
    await turns()
    expect(controls).toEqual([{ mirror: 'receipt' }])
    expect(atSidecar).toEqual([])
    const guardianDisconnects = (fixture.owner.ipc as unknown as {
      disconnects: Set<() => void>
    }).disconnects
    Array.from(guardianDisconnects).at(-1)?.()
    await host.done
    expect(fixture.terminated()).toBe(1)
    expect(fixture.supervisor.disposals).toBe(1)
  })

  it('rejects a reserved guardian frame from Electron main', async () => {
    const fixture = setup()
    const host = startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: fixture.owner,
      supervisor: fixture.supervisor,
      limits,
    })
    await fixture.main.send({ namespace: 'dsh.guardian', version: 1, type: 'spoof' })
    await host.done
    expect(fixture.terminated()).toBe(1)
  })

  it('owns logical guardian protocol failure from the sidecar', async () => {
    const fixture = setup()
    const host = startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: fixture.owner,
      supervisor: fixture.supervisor,
      limits,
    })
    await fixture.sidecar.send({
      namespace: 'dsh.guardian',
      version: 1,
      type: 'chunk',
      streamId: 'unknown',
      sequence: 0,
      data: Buffer.from('x'),
    })
    await host.done
    expect(fixture.terminated()).toBe(1)
  })

  it('rejects a non-positive sidecar pid before installing listeners', () => {
    const fixture = setup()
    expect(() => startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: { ...fixture.owner, pid: 0 },
      supervisor: fixture.supervisor,
      limits,
    })).toThrow('positive pid')
    expect(() => startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: { ...fixture.owner, pid: Number.NaN },
      supervisor: fixture.supervisor,
      limits,
    })).toThrow('positive pid')
  })

  it('rejects sidecar-owned control frames and parent-control classifier failures', async () => {
    const reserved = setup()
    const reservedHost = startGuardianHost({
      parent: reserved.main.peer as RawEndpoint,
      sidecar: reserved.owner,
      supervisor: reserved.supervisor,
      limits,
      isSidecarReservedMessage: value => value === 'guardian-control',
    })
    await reserved.sidecar.send('ordinary')
    await reserved.sidecar.send('guardian-control')
    await reservedHost.done
    expect(reserved.terminated()).toBe(1)

    const classifier = setup()
    const classifierHost = startGuardianHost({
      parent: classifier.main.peer as RawEndpoint,
      sidecar: classifier.owner,
      supervisor: classifier.supervisor,
      limits,
      isParentControlMessage: () => { throw 'classifier failed' },
    })
    await classifier.main.send({ control: true })
    await classifierHost.done
    expect(classifier.terminated()).toBe(1)
  })

  it('contains relay failures, preserves queued order after a failed send, and ignores late forwarding', async () => {
    const fixture = setup()
    const guardianSidecar = fixture.owner.ipc as RawEndpoint
    guardianSidecar.sendFailure = 'sidecar relay failed'
    const host = startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: fixture.owner,
      supervisor: fixture.supervisor,
      limits,
    })
    await fixture.main.send({ sequence: 1 })
    await fixture.main.send({ sequence: 2 })
    await host.done
    const internals = host as unknown as {
      forwardToSidecar(value: unknown): void
      forwardToParent(value: unknown): void
    }
    internals.forwardToSidecar('late')
    internals.forwardToParent('late')
    expect(fixture.terminated()).toBe(1)

    const parentFailure = setup()
    const hostParentFailure = startGuardianHost({
      parent: parentFailure.main.peer as RawEndpoint,
      sidecar: parentFailure.owner,
      supervisor: parentFailure.supervisor,
      limits,
    })
    ;(parentFailure.main.peer as RawEndpoint).sendFailure = new Error('parent relay failed')
    await parentFailure.sidecar.send({ from: 'sidecar' })
    await hostParentFailure.done
    expect(parentFailure.terminated()).toBe(1)
  })

  it('reports cleanup failures through both dispose and done and shares one disposal transaction', async () => {
    const fixture = setup()
    fixture.supervisor.disposeFailure = new Error('supervisor cleanup failed')
    const owner: GuardianOwnedSidecar = {
      ...fixture.owner,
      terminateAndJoin: async () => { throw new Error('sidecar cleanup failed') },
    }
    const host = startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: owner,
      supervisor: fixture.supervisor,
      limits,
    })
    const first = host.dispose(new Error('shutdown'))
    expect(host.dispose(new Error('ignored'))).toBe(first)
    await expect(first).rejects.toMatchObject({ name: 'AggregateError' })
    await expect(host.done).rejects.toMatchObject({ name: 'AggregateError' })
  })

  it('terminates when Electron main disconnects', async () => {
    const fixture = setup()
    const host = startGuardianHost({
      parent: fixture.main.peer as RawEndpoint,
      sidecar: fixture.owner,
      supervisor: fixture.supervisor,
      limits,
    })
    fixture.main.disconnect()
    await host.done
    expect(fixture.terminated()).toBe(1)
  })
})

describe('Node guardian host endpoint', () => {
  interface ListenerMap {
    readonly message: Set<(value: unknown) => void>
    readonly disconnect: Set<() => void>
  }

  function target(options: {
    connected?: boolean
    send?: (value: unknown, callback?: (error: Error | null) => void) => boolean
  } = {}): { face: unknown; listeners: ListenerMap } {
    const listeners: ListenerMap = { message: new Set(), disconnect: new Set() }
    const face = {
      connected: options.connected ?? true,
      send: options.send ?? ((_value: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null)
        return true
      }),
      on(event: keyof ListenerMap, listener: never): void {
        ;(listeners[event] as Set<never>).add(listener)
      },
      off(event: keyof ListenerMap, listener: never): void {
        ;(listeners[event] as Set<never>).delete(listener)
      },
    }
    return { face, listeners }
  }

  it('adapts sends and independently removable Node listeners', async () => {
    const fixture = target()
    const endpoint = createNodeGuardianHostEndpoint(fixture.face as never)
    const message = vi.fn()
    const disconnected = vi.fn()
    const removeMessage = endpoint.onMessage(message)
    const removeDisconnect = endpoint.onDisconnect(disconnected)
    for (const listener of fixture.listeners.message) listener({ ready: true })
    for (const listener of fixture.listeners.disconnect) listener()
    expect(message).toHaveBeenCalledWith({ ready: true })
    expect(disconnected).toHaveBeenCalledOnce()
    removeMessage()
    removeDisconnect()
    expect(fixture.listeners.message.size).toBe(0)
    expect(fixture.listeners.disconnect.size).toBe(0)
    await expect(endpoint.send({ hello: 'guardian' })).resolves.toBeUndefined()
  })

  it('rejects disconnected, callback, and synchronous Node send failures', async () => {
    const disconnected = target()
    const disconnectedEndpoint = createNodeGuardianHostEndpoint(disconnected.face as never)
    ;(disconnected.face as { connected: boolean }).connected = false
    await expect(disconnectedEndpoint.send('x')).rejects.toThrow('disconnected')

    const missing = target()
    const missingEndpoint = createNodeGuardianHostEndpoint(missing.face as never)
    ;(missing.face as { send?: unknown }).send = undefined
    await expect(missingEndpoint.send('x')).rejects.toThrow('disconnected')

    const absentAtConstruction = target()
    ;(absentAtConstruction.face as { send?: unknown }).send = undefined
    expect(() => createNodeGuardianHostEndpoint(absentAtConstruction.face as never)).toThrow('connected Node child IPC')

    const callbackFailure = target({
      send: (_value, callback) => {
        callback?.(new Error('callback failed'))
        return false
      },
    })
    await expect(createNodeGuardianHostEndpoint(callbackFailure.face as never).send('x')).rejects.toThrow('callback failed')

    const thrown = target({ send: () => { throw new Error('send threw') } })
    await expect(createNodeGuardianHostEndpoint(thrown.face as never).send('x')).rejects.toThrow('send threw')
  })
})
