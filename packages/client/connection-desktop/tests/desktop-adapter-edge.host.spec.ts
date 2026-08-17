import { RpcId, type ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ConnectionRpcAccessError } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import {
  ChildProcessDesktopIpcAdapter,
  createNodeChildProcessEndpoint,
  createNodeParentProcessEndpoint,
  DesktopBodyId,
  DesktopBodyLimitError,
  DesktopMainIpcPeer,
  DesktopProtocolError,
  DesktopRequestId,
  InMemoryDesktopIpcAdapter,
  type DesktopIpcHost,
  type DesktopMainMessageEndpoint,
  type DesktopMessageEndpoint,
  type DesktopRendererInvocation,
  type DesktopSidecarInboundFrame,
  type DesktopSidecarOutboundFrame,
  type NodeIpcPeer,
} from '../src/index.ts'

interface SidecarEndpointHarness {
  readonly endpoint: DesktopMessageEndpoint
  readonly sent: DesktopSidecarOutboundFrame[]
  readonly emit: (value: unknown) => void
  readonly disconnect: () => void
}

interface MainEndpointHarness {
  readonly endpoint: DesktopMainMessageEndpoint
  readonly sent: DesktopSidecarInboundFrame[]
  readonly emit: (value: unknown) => void
  readonly disconnect: () => void
}

interface SidecarEndpointOptions {
  readonly onSend?: (frame: DesktopSidecarOutboundFrame) => void
  readonly afterAck?: (frame: Extract<DesktopSidecarOutboundFrame, { type: 'body-chunk' }>) => void
}

interface MainEndpointOptions {
  readonly onSend?: (frame: DesktopSidecarInboundFrame) => void
  readonly afterAck?: (frame: Extract<DesktopSidecarInboundFrame, { type: 'body-chunk' }>) => void
}

function sidecarEndpoint(options: SidecarEndpointOptions = {}): SidecarEndpointHarness {
  const sent: DesktopSidecarOutboundFrame[] = []
  let message: ((value: unknown) => void) | undefined
  let disconnected: (() => void) | undefined
  const endpoint: DesktopMessageEndpoint = {
    send(frame) {
      sent.push(frame)
      options.onSend?.(frame)
      if (frame.type === 'body-chunk') {
        queueMicrotask(() => {
          message?.({
            version: 1,
            type: 'body-ack',
            bodyId: frame.bodyId,
            sequence: frame.sequence,
            byteLength: frame.chunk.byteLength,
          })
          options.afterAck?.(frame)
        })
      }
    },
    onMessage(listener) {
      message = listener
      return () => { message = undefined }
    },
    onDisconnect(listener) {
      disconnected = listener
      return () => { disconnected = undefined }
    },
  }
  return {
    endpoint,
    sent,
    emit: (value) => { message?.(value) },
    disconnect: () => { disconnected?.() },
  }
}

function mainEndpoint(options: MainEndpointOptions = {}): MainEndpointHarness {
  const sent: DesktopSidecarInboundFrame[] = []
  let message: ((value: unknown) => void) | undefined
  let disconnected: (() => void) | undefined
  const endpoint: DesktopMainMessageEndpoint = {
    send(frame) {
      sent.push(frame)
      options.onSend?.(frame)
      if (frame.type === 'body-chunk') {
        queueMicrotask(() => {
          message?.({
            version: 1,
            type: 'body-ack',
            bodyId: frame.bodyId,
            sequence: frame.sequence,
            byteLength: frame.chunk.byteLength,
          })
          options.afterAck?.(frame)
        })
      }
    },
    onMessage(listener) {
      message = listener
      return () => { message = undefined }
    },
    onDisconnect(listener) {
      disconnected = listener
      return () => { disconnected = undefined }
    },
  }
  return {
    endpoint,
    sent,
    emit: (value) => { message?.(value) },
    disconnect: () => { disconnected?.() },
  }
}

function emitBody(
  emit: (value: unknown) => void,
  bodyIdValue: string,
  value: unknown,
): ReturnType<typeof DesktopBodyId> {
  const bodyId = DesktopBodyId(bodyIdValue)
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  emit({ version: 1, type: 'body-start', bodyId, byteLength: bytes.byteLength })
  emit({ version: 1, type: 'body-chunk', bodyId, sequence: 0, chunk: bytes })
  emit({ version: 1, type: 'body-end', bodyId })
  return bodyId
}

function decodeBody(
  sent: readonly (DesktopSidecarInboundFrame | DesktopSidecarOutboundFrame)[],
  bodyId: ReturnType<typeof DesktopBodyId>,
): unknown {
  type ChunkFrame = Extract<
    DesktopSidecarInboundFrame | DesktopSidecarOutboundFrame,
    { type: 'body-chunk' }
  >
  const chunks = sent.filter((frame): frame is ChunkFrame => frame.type === 'body-chunk' && frame.bodyId === bodyId)
    .sort((left, right) => left.sequence - right.sequence)
  const byteLength = chunks.reduce((sum, frame) => sum + frame.chunk.byteLength, 0)
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const frame of chunks) {
    bytes.set(frame.chunk, offset)
    offset += frame.chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

async function waitForFrame<
  F extends DesktopSidecarInboundFrame | DesktopSidecarOutboundFrame,
  T extends F['type'],
>(sent: readonly F[], type: T, count = 1): Promise<Extract<F, { type: T }>> {
  await vi.waitFor(() => { expect(sent.filter(frame => frame.type === type)).toHaveLength(count) })
  const frame = sent.filter(value => value.type === type).at(-1)
  if (frame === undefined) throw new Error(`${type} was not sent`)
  return frame as Extract<F, { type: T }>
}

function rpcInvocation(id = 'rpc'): DesktopRendererInvocation {
  return {
    kind: 'rpc',
    channel: '/api',
    message: {
      type: 'client-request',
      rpcId: RpcId(id),
      method: 'session.list',
      payload: {},
    },
  }
}

function ipcHost(overrides: Partial<DesktopIpcHost> = {}): DesktopIpcHost {
  return {
    async invoke(invocation) {
      if (invocation.kind === 'respond') return { kind: 'respond', receipt: { accepted: true } }
      return {
        kind: 'rpc',
        message: {
          type: 'server-response',
          rpcId: invocation.message.rpcId,
          result: { ok: true, value: {} },
        },
      }
    },
    async system() {
      return { rev: 'graph', entries: [] }
    },
    subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    ...overrides,
  }
}

function rejectWithUnknown<T>(reason: unknown): Promise<T> {
  return new Promise((_resolve, reject) => {
    Reflect.apply(reject, undefined, [reason])
  })
}

describe('Node IPC endpoint adapters', () => {
  function fakePeer(values: { connected?: boolean; send?: NodeIpcPeer['send'] } = {}): {
    readonly peer: NodeIpcPeer
    readonly listeners: Map<string, Set<(...args: never[]) => void>>
  } {
    const listeners = new Map<string, Set<(...args: never[]) => void>>()
    const peer: NodeIpcPeer = {
      connected: values.connected,
      send: values.send,
      on(event, listener) {
        const current = listeners.get(event) ?? new Set()
        current.add(listener)
        listeners.set(event, current)
        return peer
      },
      off(event, listener) {
        listeners.get(event)?.delete(listener)
        return peer
      },
    }
    return { peer, listeners }
  }

  it('adapts child and parent peers and removes listeners', () => {
    const send = vi.fn()
    const child = fakePeer({ connected: true, send })
    const childEndpoint = createNodeChildProcessEndpoint(child.peer)
    const onMessage = vi.fn()
    const onDisconnect = vi.fn()
    const removeMessage = childEndpoint.onMessage(onMessage)
    const removeDisconnect = childEndpoint.onDisconnect(onDisconnect)
    childEndpoint.send({ version: 1, type: 'host-cancel', requestId: DesktopRequestId('id') })
    expect(send).toHaveBeenCalledOnce()
    expect(child.listeners.get('message')?.size).toBe(1)
    expect(child.listeners.get('disconnect')?.size).toBe(1)
    removeMessage()
    removeDisconnect()
    expect(child.listeners.get('message')?.size).toBe(0)
    expect(child.listeners.get('disconnect')?.size).toBe(0)

    const parent = fakePeer({ connected: true, send })
    expect(createNodeParentProcessEndpoint(parent.peer)).toBeDefined()
  })

  it('rejects missing and disconnected IPC senders at construction and send time', () => {
    expect(() => createNodeChildProcessEndpoint(fakePeer().peer)).toThrow('connected Node IPC')
    expect(() => createNodeChildProcessEndpoint(fakePeer({ connected: false, send: vi.fn() }).peer)).toThrow(
      'connected Node IPC',
    )

    const disconnected = fakePeer({ connected: true, send: vi.fn() })
    const disconnectedEndpoint = createNodeChildProcessEndpoint(disconnected.peer)
    Object.defineProperty(disconnected.peer, 'connected', { configurable: true, value: false })
    expect(() => { disconnectedEndpoint.send({} as never) }).toThrow('disconnected')

    const missing = fakePeer({ connected: true, send: vi.fn() })
    const missingEndpoint = createNodeChildProcessEndpoint(missing.peer)
    missing.peer.send = undefined
    expect(() => { missingEndpoint.send({} as never) }).toThrow('disconnected')
  })
})

describe('sidecar adapter edge cases', () => {
  it('enforces install lifecycle and pre-aborted Host requests', async () => {
    const harness = sidecarEndpoint()
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    await expect(adapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
    const remove = adapter.install(ipcHost())
    expect(() => adapter.install(ipcHost())).toThrow('already installed')
    for (const reason of [new Error('pre-aborted'), 'pre-aborted']) {
      const abort = new AbortController()
      abort.abort(reason)
      await expect(adapter.requestHost('directory.pick', {}, abort.signal)).rejects.toThrow(
        reason instanceof Error ? 'pre-aborted' : 'desktop operation aborted',
      )
    }
    await remove()
    await expect(adapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
    expect(() => adapter.install(ipcHost())).toThrow('disconnected')
  })

  it('settles successful, failed, malformed, and cancelled Host requests', async () => {
    const harness = sidecarEndpoint()
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost())
    try {
      const success = adapter.requestHost('directory.pick', {})
      const request = await waitForFrame(harness.sent, 'host-request')
      const successBody = emitBody(harness.emit, 'host-success', { ok: true, value: { path: '/picked' } })
      harness.emit({ version: 1, type: 'host-response', requestId: request.requestId, bodyId: successBody })
      await expect(success).resolves.toEqual({ path: '/picked' })

      const failed = adapter.requestHost('directory.pick', {})
      const failedRequest = await waitForFrame(harness.sent, 'host-request', 2)
      const failedBody = emitBody(harness.emit, 'host-failed', {
        ok: false,
        error: { code: 'not-authorized', message: 'denied' },
      })
      harness.emit({ version: 1, type: 'host-response', requestId: failedRequest.requestId, bodyId: failedBody })
      await expect(failed).rejects.toMatchObject({ name: 'DesktopNotAuthorizedError', message: 'denied' })

      const malformed = adapter.requestHost('directory.pick', {})
      const malformedRequest = await waitForFrame(harness.sent, 'host-request', 3)
      const malformedBody = emitBody(harness.emit, 'host-malformed', { ok: true, value: { path: 1 } })
      harness.emit({ version: 1, type: 'host-response', requestId: malformedRequest.requestId, bodyId: malformedBody })
      await expect(malformed).rejects.toThrow('directory.pick response is invalid')

      const abort = new AbortController()
      const cancelled = adapter.requestHost('directory.pick', {}, abort.signal)
      await waitForFrame(harness.sent, 'host-request', 4)
      abort.abort(new Error('picker cancelled'))
      await expect(cancelled).rejects.toThrow('picker cancelled')
      await waitForFrame(harness.sent, 'host-cancel')
    } finally {
      await remove()
    }
  })

  it.each([
    [new DesktopBodyLimitError(2, 1), 'too-large'],
    [new DesktopProtocolError('bad invocation'), 'bad-request'],
    [new ConnectionRpcAccessError('/api/blocked'), 'not-authorized'],
    [new Error('handler failed'), 'internal'],
    ['handler failed', 'internal'],
  ])('maps invocation failure %# to %s', async (failure, code) => {
    const harness = sidecarEndpoint()
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost({ invoke: () => rejectWithUnknown(failure) }))
    try {
      const bodyId = emitBody(harness.emit, `invoke-${code}`, rpcInvocation(code))
      harness.emit({
        version: 1,
        type: 'renderer-invoke',
        requestId: DesktopRequestId(code),
        bodyId,
      })
      const result = await waitForFrame(harness.sent, 'renderer-result')
      expect(decodeBody(harness.sent, result.bodyId)).toMatchObject({ ok: false, error: { code } })
    } finally {
      await remove()
    }
  })

  it('handles duplicate invokes and subscriptions plus finite and failed streams', async () => {
    const harness = sidecarEndpoint()
    let finishInvoke: (() => void) | undefined
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost({
      invoke: invocation => new Promise((resolve) => {
        finishInvoke = () => {
          if (invocation.kind === 'respond') resolve({ kind: 'respond', receipt: { accepted: true } })
          else {
            resolve({
              kind: 'rpc',
              message: {
                type: 'server-response',
                rpcId: invocation.message.rpcId,
                result: { ok: true, value: {} },
              },
            })
          }
        }
      }),
      subscribe: stream => ({
        async *[Symbol.asyncIterator]() {
          if (stream === 'events.host') throw new Error('stream failed')
          const value: ServerRequest = {
            type: 'server-request',
            rpcId: RpcId('event'),
            method: 'session/subscribed',
            payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 },
          }
          yield value
        },
      }),
    }))
    try {
      const requestId = DesktopRequestId('duplicate')
      for (const suffix of ['first', 'second']) {
        const bodyId = emitBody(harness.emit, suffix, rpcInvocation(suffix))
        harness.emit({ version: 1, type: 'renderer-invoke', requestId, bodyId })
      }
      const duplicate = await waitForFrame(harness.sent, 'renderer-result')
      expect(decodeBody(harness.sent, duplicate.bodyId)).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
      finishInvoke?.()
      await waitForFrame(harness.sent, 'renderer-result', 2)

      const subscriptionId = DesktopRequestId('subscription')
      harness.emit({ version: 1, type: 'renderer-subscribe', subscriptionId, stream: 'events.mux' })
      harness.emit({ version: 1, type: 'renderer-subscribe', subscriptionId, stream: 'events.mux' })
      await waitForFrame(harness.sent, 'renderer-event')
      await waitForFrame(harness.sent, 'renderer-end', 2)

      harness.emit({
        version: 1,
        type: 'renderer-subscribe',
        subscriptionId: DesktopRequestId('failed-stream'),
        stream: 'events.host',
      })
      const failedEnd = await waitForFrame(harness.sent, 'renderer-end', 3)
      expect(decodeBody(harness.sent, failedEnd.bodyId)).toMatchObject({
        ok: false,
        error: { code: 'internal' },
      })
    } finally {
      await remove()
    }
  })

  it('serves system requests and rejects malformed system payloads', async () => {
    const successHarness = sidecarEndpoint()
    const successAdapter = new ChildProcessDesktopIpcAdapter(successHarness.endpoint)
    const remove = successAdapter.install(ipcHost())
    const systemBody = emitBody(successHarness.emit, 'system', {})
    successHarness.emit({
      version: 1,
      type: 'renderer-system',
      requestId: DesktopRequestId('system'),
      method: 'desktop.bootManifest',
      bodyId: systemBody,
    })
    const result = await waitForFrame(successHarness.sent, 'renderer-result')
    expect(decodeBody(successHarness.sent, result.bodyId)).toMatchObject({ ok: true, value: { rev: 'graph' } })
    await remove()

    const malformedHarness = sidecarEndpoint()
    const malformedAdapter = new ChildProcessDesktopIpcAdapter(malformedHarness.endpoint)
    malformedAdapter.install(ipcHost())
    const malformedBody = emitBody(malformedHarness.emit, 'system-malformed', { extra: true })
    malformedHarness.emit({
      version: 1,
      type: 'renderer-system',
      requestId: DesktopRequestId('system-malformed'),
      method: 'desktop.bootManifest',
      bodyId: malformedBody,
    })
    await expect(malformedAdapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
  })

  it('rejects duplicate and failed system calls and closes a cancelled iterator', async () => {
    const harness = sidecarEndpoint()
    let rejectSystem: ((error: Error) => void) | undefined
    let iteratorReturned = false
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost({
      system: () => new Promise((_resolve, reject) => { rejectSystem = reject }),
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<ServerRequest>>(() => {}),
            return: () => {
              iteratorReturned = true
              return Promise.reject(new Error('source cancellation failed'))
            },
          }
        },
      }),
    }))
    try {
      const requestId = DesktopRequestId('duplicate-system')
      for (const bodyName of ['system-first', 'system-second']) {
        const bodyId = emitBody(harness.emit, bodyName, {})
        harness.emit({
          version: 1,
          type: 'renderer-system',
          requestId,
          method: 'desktop.bootManifest',
          bodyId,
        })
      }
      const duplicate = await waitForFrame(harness.sent, 'renderer-result')
      expect(decodeBody(harness.sent, duplicate.bodyId)).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
      rejectSystem?.(new Error('system failed'))
      const failed = await waitForFrame(harness.sent, 'renderer-result', 2)
      expect(decodeBody(harness.sent, failed.bodyId)).toMatchObject({
        ok: false,
        error: { code: 'internal', message: 'system failed' },
      })

      const subscriptionId = DesktopRequestId('cancelled-source')
      harness.emit({ version: 1, type: 'renderer-subscribe', subscriptionId, stream: 'events.mux' })
      harness.emit({ version: 1, type: 'renderer-unsubscribe', subscriptionId })
      await waitForFrame(harness.sent, 'renderer-end')
      await vi.waitFor(() => { expect(iteratorReturned).toBe(true) })
    } finally {
      await remove()
    }
  })

  it('handles cancellation during body send and a synchronously cancelled invocation', async () => {
    const abort = new AbortController()
    const harness = sidecarEndpoint({
      onSend(frame) {
        if (frame.type === 'body-chunk') {
          abort.abort(new Error('cancelled while sending'))
          throw new Error('body sender failed after cancellation')
        }
      },
    })
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost())
    const request = adapter.requestHost('directory.pick', {}, abort.signal)
    await expect(request).rejects.toThrow('cancelled while sending')
    await waitForFrame(harness.sent, 'host-cancel')
    await remove()

    const invokeHarness = sidecarEndpoint()
    const invokeAdapter = new ChildProcessDesktopIpcAdapter(invokeHarness.endpoint)
    const invokeId = DesktopRequestId('synchronous-cancel')
    const removeInvoke = invokeAdapter.install(ipcHost({
      invoke: async () => {
        invokeHarness.emit({ version: 1, type: 'renderer-cancel', requestId: invokeId })
        return { kind: 'respond', receipt: { accepted: true } }
      },
    }))
    const bodyId = emitBody(invokeHarness.emit, 'synchronous-cancel-body', {
      kind: 'respond',
      message: {
        type: 'client-response',
        rpcId: RpcId('synchronous-cancel'),
        result: { ok: true, value: {} },
      },
    })
    invokeHarness.emit({ version: 1, type: 'renderer-invoke', requestId: invokeId, bodyId })
    const result = await waitForFrame(invokeHarness.sent, 'renderer-result')
    expect(decodeBody(invokeHarness.sent, result.bodyId)).toMatchObject({ ok: false, error: { code: 'aborted' } })
    await removeInvoke()
  })

  it('settles Host request body-send failures and removes settled abort listeners', async () => {
    const failedHarness = sidecarEndpoint({
      onSend(frame) {
        if (frame.type === 'body-chunk') throw new Error('Host request body send failed')
      },
    })
    const failedAdapter = new ChildProcessDesktopIpcAdapter(failedHarness.endpoint)
    const removeFailed = failedAdapter.install(ipcHost())
    await expect(failedAdapter.requestHost('directory.pick', {})).rejects.toThrow('Host request body send failed')
    await removeFailed()

    const settledHarness = sidecarEndpoint()
    const settledAdapter = new ChildProcessDesktopIpcAdapter(settledHarness.endpoint)
    const removeSettled = settledAdapter.install(ipcHost())
    const abort = new AbortController()
    const request = settledAdapter.requestHost('directory.pick', {}, abort.signal)
    const control = await waitForFrame(settledHarness.sent, 'host-request')
    const bodyId = emitBody(settledHarness.emit, 'signalled-host-success', {
      ok: true,
      value: { path: null },
    })
    settledHarness.emit({ version: 1, type: 'host-response', requestId: control.requestId, bodyId })
    await expect(request).resolves.toEqual({ path: null })
    abort.abort(new Error('too late'))
    expect(settledHarness.sent.some(frame => frame.type === 'host-cancel')).toBe(false)
    await removeSettled()
  })

  it('suppresses Host request controls cancelled or disconnected after body acknowledgement', async () => {
    const abort = new AbortController()
    const cancelledHarness = sidecarEndpoint({ afterAck: () => { abort.abort(new Error('late cancellation')) } })
    const cancelledAdapter = new ChildProcessDesktopIpcAdapter(cancelledHarness.endpoint)
    const removeCancelled = cancelledAdapter.install(ipcHost())
    await expect(cancelledAdapter.requestHost('directory.pick', {}, abort.signal)).rejects.toThrow('late cancellation')
    expect(cancelledHarness.sent.some(frame => frame.type === 'host-request')).toBe(false)
    await removeCancelled()

    let disconnect = (): void => {}
    const disconnectedHarness = sidecarEndpoint({ afterAck: () => { disconnect() } })
    disconnect = disconnectedHarness.disconnect
    const disconnectedAdapter = new ChildProcessDesktopIpcAdapter(disconnectedHarness.endpoint)
    const removeDisconnected = disconnectedAdapter.install(ipcHost())
    await expect(disconnectedAdapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
    expect(disconnectedHarness.sent.some(frame => frame.type === 'host-request')).toBe(false)
    await removeDisconnected()
  })

  it('stops result controls when the endpoint disconnects after acknowledging their bodies', async () => {
    for (const kind of ['invoke', 'subscription'] as const) {
      let disconnect = (): void => {}
      const harness = sidecarEndpoint({ afterAck: () => { disconnect() } })
      disconnect = harness.disconnect
      const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
      const remove = adapter.install(ipcHost())
      if (kind === 'invoke') {
        const bodyId = emitBody(harness.emit, 'disconnect-result', rpcInvocation('disconnect-result'))
        harness.emit({
          version: 1,
          type: 'renderer-invoke',
          requestId: DesktopRequestId('disconnect-result'),
          bodyId,
        })
        await vi.waitFor(() => { expect(harness.sent.some(frame => frame.type === 'body-end')).toBe(true) })
        expect(harness.sent.some(frame => frame.type === 'renderer-result')).toBe(false)
      } else {
        harness.emit({
          version: 1,
          type: 'renderer-subscribe',
          subscriptionId: DesktopRequestId('disconnect-end'),
          stream: 'events.mux',
        })
        await vi.waitFor(() => { expect(harness.sent.some(frame => frame.type === 'body-end')).toBe(true) })
        expect(harness.sent.some(frame => frame.type === 'renderer-end')).toBe(false)
      }
      await remove()
    }
  })

  it('aborts every active sidecar operation on physical disconnect', async () => {
    const harness = sidecarEndpoint()
    let invoked = false
    let subscribed = false
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost({
      invoke: (_invocation, signal) => new Promise((_resolve, reject) => {
        invoked = true
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('invocation aborted'))
        }, { once: true })
      }),
      subscribe: (_stream, signal) => ({
        async *[Symbol.asyncIterator]() {
          subscribed = true
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('subscription aborted'))
            }, { once: true })
          })
        },
      }),
    }))
    const hostRequest = adapter.requestHost('directory.pick', {})
    await waitForFrame(harness.sent, 'host-request')
    const invocationBody = emitBody(harness.emit, 'active-invoke', rpcInvocation('active-invoke'))
    harness.emit({
      version: 1,
      type: 'renderer-invoke',
      requestId: DesktopRequestId('active-invoke'),
      bodyId: invocationBody,
    })
    harness.emit({
      version: 1,
      type: 'renderer-subscribe',
      subscriptionId: DesktopRequestId('active-subscription'),
      stream: 'events.mux',
    })
    await vi.waitFor(() => {
      expect(invoked).toBe(true)
      expect(subscribed).toBe(true)
    })
    harness.disconnect()
    await expect(hostRequest).rejects.toThrow('disconnected')
    await remove()
  })

  it('disconnects when an asynchronous sidecar response cannot be sent', async () => {
    const harness = sidecarEndpoint({
      onSend(frame) {
        if (frame.type === 'renderer-result') throw new Error('renderer result send failed')
      },
    })
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost())
    const bodyId = emitBody(harness.emit, 'failed-result-send', rpcInvocation('failed-result-send'))
    harness.emit({
      version: 1,
      type: 'renderer-invoke',
      requestId: DesktopRequestId('failed-result-send'),
      bodyId,
    })
    await waitForFrame(harness.sent, 'renderer-result')
    await vi.waitFor(async () => {
      await expect(adapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
    })
    await remove()

    let disconnect = (): void => {}
    const lateHarness = sidecarEndpoint({
      onSend(frame) {
        if (frame.type === 'renderer-result') {
          disconnect()
          throw new Error('late renderer result send failed')
        }
      },
    })
    disconnect = lateHarness.disconnect
    const lateAdapter = new ChildProcessDesktopIpcAdapter(lateHarness.endpoint)
    const removeLate = lateAdapter.install(ipcHost())
    const lateBody = emitBody(lateHarness.emit, 'late-failed-result-send', rpcInvocation('late-failed-result-send'))
    lateHarness.emit({
      version: 1,
      type: 'renderer-invoke',
      requestId: DesktopRequestId('late-failed-result-send'),
      bodyId: lateBody,
    })
    await waitForFrame(lateHarness.sent, 'renderer-result')
    await removeLate()
  })
})

describe('main IPC peer edge cases', () => {
  it('round-trips respond results and rejects wire and parser failures', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    try {
      const responseAbort = new AbortController()
      const responding = peer.invoke({
        kind: 'respond',
        message: {
          type: 'client-response',
          rpcId: RpcId('respond'),
          result: { ok: true, value: {} },
        },
      }, responseAbort.signal)
      const request = await waitForFrame(harness.sent, 'renderer-invoke')
      const responseBody = emitBody(harness.emit, 'respond-result', {
        ok: true,
        value: { kind: 'respond', receipt: { accepted: false, reason: 'bad-response' } },
      })
      harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId: responseBody })
      await expect(responding).resolves.toMatchObject({ kind: 'respond', receipt: { accepted: false } })
      responseAbort.abort(new Error('too late'))
      expect(harness.sent.some(frame => frame.type === 'renderer-cancel')).toBe(false)

      const failed = peer.invoke(rpcInvocation('failed'))
      const failedRequest = await waitForFrame(harness.sent, 'renderer-invoke', 2)
      const failedBody = emitBody(harness.emit, 'failed-result', {
        ok: false,
        error: { code: 'disconnected', message: 'remote closed' },
      })
      harness.emit({ version: 1, type: 'renderer-result', requestId: failedRequest.requestId, bodyId: failedBody })
      await expect(failed).rejects.toMatchObject({ name: 'DesktopDisconnectedError' })

      const malformed = peer.invoke(rpcInvocation('malformed'))
      const malformedRequest = await waitForFrame(harness.sent, 'renderer-invoke', 3)
      const malformedBody = emitBody(harness.emit, 'malformed-result', { ok: true, value: { kind: 'rpc' } })
      harness.emit({ version: 1, type: 'renderer-result', requestId: malformedRequest.requestId, bodyId: malformedBody })
      await expect(malformed).rejects.toThrow('renderer result is invalid')
    } finally {
      await peer.dispose()
    }
  })

  it('handles queued events, success/error endings, and sequence violations', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    try {
      const iterator = peer.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
      const first = iterator.next()
      const subscription = await waitForFrame(harness.sent, 'renderer-subscribe')
      const event: ServerRequest = {
        type: 'server-request',
        rpcId: RpcId('event-1'),
        method: 'session/subscribed',
        payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 },
      }
      const firstBody = emitBody(harness.emit, 'event-1', event)
      harness.emit({
        version: 1,
        type: 'renderer-event',
        subscriptionId: subscription.subscriptionId,
        sequence: 0,
        bodyId: firstBody,
      })
      await expect(first).resolves.toMatchObject({ value: { rpcId: 'event-1' } })

      const secondBody = emitBody(harness.emit, 'event-2', { ...event, rpcId: RpcId('event-2') })
      harness.emit({
        version: 1,
        type: 'renderer-event',
        subscriptionId: subscription.subscriptionId,
        sequence: 1,
        bodyId: secondBody,
      })
      await expect(iterator.next()).resolves.toMatchObject({ value: { rpcId: 'event-2' } })
      const endBody = emitBody(harness.emit, 'end', { ok: true, value: {} })
      harness.emit({
        version: 1,
        type: 'renderer-end',
        subscriptionId: subscription.subscriptionId,
        bodyId: endBody,
      })
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })

      const failing = peer.subscribe('events.host', new AbortController().signal)[Symbol.asyncIterator]()
      const failedNext = failing.next()
      const failedSubscription = await waitForFrame(harness.sent, 'renderer-subscribe', 2)
      const failedEnd = emitBody(harness.emit, 'failed-end', {
        ok: false,
        error: { code: 'internal', message: 'stream failed' },
      })
      harness.emit({
        version: 1,
        type: 'renderer-end',
        subscriptionId: failedSubscription.subscriptionId,
        bodyId: failedEnd,
      })
      await expect(failedNext).rejects.toThrow('stream failed')

      const invalid = peer.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
      const invalidNext = invalid.next()
      const invalidSubscription = await waitForFrame(harness.sent, 'renderer-subscribe', 3)
      const invalidBody = emitBody(harness.emit, 'invalid-sequence', event)
      harness.emit({
        version: 1,
        type: 'renderer-event',
        subscriptionId: invalidSubscription.subscriptionId,
        sequence: 2,
        bodyId: invalidBody,
      })
      await expect(invalidNext).rejects.toThrow('expected sequence 0')
    } finally {
      await peer.dispose()
    }
  })

  it('rejects pre-aborted, cancelled, and disconnected renderer operations', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const preAbort = new AbortController()
    preAbort.abort('closed')
    await expect(peer.invoke(rpcInvocation(), preAbort.signal)).rejects.toThrow('desktop operation aborted')
    const preAbortedStream = peer.subscribe('events.mux', preAbort.signal)[Symbol.asyncIterator]()
    await expect(preAbortedStream.next()).rejects.toThrow('desktop operation aborted')

    const abort = new AbortController()
    const pending = peer.invoke(rpcInvocation('cancel'), abort.signal)
    await waitForFrame(harness.sent, 'renderer-invoke')
    abort.abort(new Error('renderer cancelled'))
    await expect(pending).rejects.toThrow('renderer cancelled')
    await waitForFrame(harness.sent, 'renderer-cancel')

    const streamAbort = new AbortController()
    const stream = peer.subscribe('events.mux', streamAbort.signal)[Symbol.asyncIterator]()
    const next = stream.next()
    await waitForFrame(harness.sent, 'renderer-subscribe')
    streamAbort.abort(new Error('stream cancelled'))
    await expect(next).rejects.toThrow('stream cancelled')
    await waitForFrame(harness.sent, 'renderer-unsubscribe')

    harness.disconnect()
    await expect(peer.invoke(rpcInvocation('disconnected'))).rejects.toThrow('disconnected')
    await expect(peer.subscribe('events.mux', new AbortController().signal).next()).rejects.toThrow('disconnected')
    await peer.dispose()
  })

  it('handles Host requests, cancellation, duplicates, and handler failures', async () => {
    const harness = mainEndpoint()
    let finish: (() => void) | undefined
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': (_payload, signal) => new Promise((resolve, reject) => {
        finish = () => { resolve({ path: '/picked' }) }
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Host request aborted'))
        }, { once: true })
      }),
    })
    try {
      const requestId = DesktopRequestId('host')
      const bodyId = emitBody(harness.emit, 'host-request', {})
      harness.emit({ version: 1, type: 'host-request', requestId, method: 'directory.pick', bodyId })
      const duplicateBodyId = emitBody(harness.emit, 'host-request-duplicate', {})
      harness.emit({
        version: 1,
        type: 'host-request',
        requestId,
        method: 'directory.pick',
        bodyId: duplicateBodyId,
      })
      const duplicate = await waitForFrame(harness.sent, 'host-response')
      expect(decodeBody(harness.sent, duplicate.bodyId)).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
      harness.emit({ version: 1, type: 'host-cancel', requestId })
      const cancelled = await waitForFrame(harness.sent, 'host-response', 2)
      expect(decodeBody(harness.sent, cancelled.bodyId)).toMatchObject({
        ok: false,
        error: { code: 'aborted' },
      })
      finish?.()
    } finally {
      await peer.dispose()
    }

    for (const failure of [new Error('picker failed')]) {
      const failedHarness = mainEndpoint()
      const failedPeer = new DesktopMainIpcPeer(failedHarness.endpoint, {
        'directory.pick': () => Promise.reject(failure),
      })
      const failedBody = emitBody(failedHarness.emit, `failed-${String(failure)}`, {})
      failedHarness.emit({
        version: 1,
        type: 'host-request',
        requestId: DesktopRequestId(`failed-${String(failure)}`),
        method: 'directory.pick',
        bodyId: failedBody,
      })
      const response = await waitForFrame(failedHarness.sent, 'host-response')
      expect(decodeBody(failedHarness.sent, response.bodyId)).toMatchObject({
        ok: false,
        error: { code: 'internal' },
      })
      await failedPeer.dispose()
    }
  })

  it('unsubscribes when the renderer closes a live stream', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const iterator = peer.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const subscription = await waitForFrame(harness.sent, 'renderer-subscribe')
    const event: ServerRequest = {
      type: 'server-request',
      rpcId: RpcId('early-return'),
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 },
    }
    const eventBody = emitBody(harness.emit, 'early-return', event)
    harness.emit({
      version: 1,
      type: 'renderer-event',
      subscriptionId: subscription.subscriptionId,
      sequence: 0,
      bodyId: eventBody,
    })
    await expect(first).resolves.toMatchObject({ done: false })
    await iterator.return?.(undefined)
    await waitForFrame(harness.sent, 'renderer-unsubscribe')
    await peer.dispose()
  })

  it('settles a pending stream reader when the sidecar ends successfully', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const iterator = peer.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const subscription = await waitForFrame(harness.sent, 'renderer-subscribe')
    const endBody = emitBody(harness.emit, 'pending-success-end', { ok: true, value: {} })
    harness.emit({
      version: 1,
      type: 'renderer-end',
      subscriptionId: subscription.subscriptionId,
      bodyId: endBody,
    })
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    await peer.dispose()
  })

  it('handles cancellation while sending a renderer request body', async () => {
    const abort = new AbortController()
    const harness = mainEndpoint({
      onSend(frame) {
        if (frame.type === 'body-chunk') {
          abort.abort(new Error('renderer body cancelled'))
          throw new Error('renderer body sender failed')
        }
      },
    })
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    await expect(peer.invoke(rpcInvocation('body-cancel'), abort.signal)).rejects.toThrow('renderer body cancelled')
    await waitForFrame(harness.sent, 'renderer-cancel')
    await peer.dispose()

    const lateAbort = new AbortController()
    const lateHarness = mainEndpoint({
      afterAck: () => { lateAbort.abort(new Error('cancelled after acknowledgement')) },
    })
    const latePeer = new DesktopMainIpcPeer(lateHarness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    await expect(latePeer.invoke(rpcInvocation('late-body-cancel'), lateAbort.signal)).rejects.toThrow(
      'cancelled after acknowledgement',
    )
    expect(lateHarness.sent.some(frame => frame.type === 'renderer-invoke')).toBe(false)
    await latePeer.dispose()
  })

  it('stops Host response controls after physical disconnect', async () => {
    let disconnectAfterAck = (): void => {}
    const postBodyHarness = mainEndpoint({ afterAck: () => { disconnectAfterAck() } })
    disconnectAfterAck = postBodyHarness.disconnect
    const postBodyPeer = new DesktopMainIpcPeer(postBodyHarness.endpoint, {
      'directory.pick': async () => ({ path: '/picked' }),
    })
    const bodyId = emitBody(postBodyHarness.emit, 'disconnect-after-host-body', {})
    postBodyHarness.emit({
      version: 1,
      type: 'host-request',
      requestId: DesktopRequestId('disconnect-after-host-body'),
      method: 'directory.pick',
      bodyId,
    })
    await vi.waitFor(() => { expect(postBodyHarness.sent.some(frame => frame.type === 'body-end')).toBe(true) })
    expect(postBodyHarness.sent.some(frame => frame.type === 'host-response')).toBe(false)
    await postBodyPeer.dispose()

    const earlyHarness = mainEndpoint()
    const earlyPeer = new DesktopMainIpcPeer(earlyHarness.endpoint, {
      'directory.pick': (_payload, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Host request aborted'))
        }, { once: true })
      }),
    })
    const earlyBody = emitBody(earlyHarness.emit, 'disconnect-before-host-body', {})
    earlyHarness.emit({
      version: 1,
      type: 'host-request',
      requestId: DesktopRequestId('disconnect-before-host-body'),
      method: 'directory.pick',
      bodyId: earlyBody,
    })
    earlyHarness.disconnect()
    await earlyPeer.dispose()
    expect(earlyHarness.sent.some(frame => frame.type === 'host-response')).toBe(false)
  })

  it('disconnects when an asynchronous Host response cannot be sent', async () => {
    const harness = mainEndpoint({
      onSend(frame) {
        if (frame.type === 'host-response') throw new Error('Host response send failed')
      },
    })
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const bodyId = emitBody(harness.emit, 'failed-host-response-send', {})
    harness.emit({
      version: 1,
      type: 'host-request',
      requestId: DesktopRequestId('failed-host-response-send'),
      method: 'directory.pick',
      bodyId,
    })
    await waitForFrame(harness.sent, 'host-response')
    await vi.waitFor(async () => {
      await expect(peer.invoke(rpcInvocation('after-send-failure'))).rejects.toThrow('disconnected')
    })
    await peer.dispose()

    let disconnect = (): void => {}
    const lateHarness = mainEndpoint({
      onSend(frame) {
        if (frame.type === 'host-response') {
          disconnect()
          throw new Error('late Host response send failed')
        }
      },
    })
    disconnect = lateHarness.disconnect
    const latePeer = new DesktopMainIpcPeer(lateHarness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const lateBody = emitBody(lateHarness.emit, 'late-failed-host-response-send', {})
    lateHarness.emit({
      version: 1,
      type: 'host-request',
      requestId: DesktopRequestId('late-failed-host-response-send'),
      method: 'directory.pick',
      bodyId: lateBody,
    })
    await waitForFrame(lateHarness.sent, 'host-response')
    await latePeer.dispose()
  })
})

describe('in-memory adapter edges', () => {
  it('enforces installation and disconnection lifecycle', async () => {
    const adapter = new InMemoryDesktopIpcAdapter({
      'directory.pick': async () => ({ path: null }),
    })
    expect(() => adapter.invoke(rpcInvocation())).toThrow('disconnected')
    expect(() => adapter.system('desktop.bootManifest', {})).toThrow('disconnected')
    await expect(adapter.subscribe('events.mux', new AbortController().signal).next()).rejects.toThrow('disconnected')
    const remove = adapter.install(ipcHost())
    expect(() => adapter.install(ipcHost())).toThrow('already installed')
    remove()
    adapter.disconnect()
    await expect(adapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
    expect(() => adapter.install(ipcHost())).toThrow('disconnected')
  })

  it('completes finite streams and forwards external cancellation', async () => {
    let iteratorReturned = false
    const adapter = new InMemoryDesktopIpcAdapter({
      'directory.pick': async () => ({ path: null }),
    })
    const remove = adapter.install(ipcHost({
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          let sent = false
          return {
            next: async () => {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: {
                type: 'server-request',
                rpcId: RpcId('event'),
                method: 'session/subscribed',
                payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 },
              } satisfies ServerRequest }
            },
            return: async () => {
              iteratorReturned = true
              return { done: true, value: undefined }
            },
          }
        },
      }),
    }))
    const iterator = adapter.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(iteratorReturned).toBe(true)
    remove()

    const cancelling = new InMemoryDesktopIpcAdapter({
      'directory.pick': (_payload, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Host request aborted'))
        }, { once: true })
      }),
    })
    cancelling.install(ipcHost())
    const abort = new AbortController()
    const request = cancelling.requestHost('directory.pick', {}, abort.signal)
    abort.abort(new Error('external cancel'))
    await expect(request).rejects.toThrow('external cancel')
    cancelling.disconnect()
  })
})
