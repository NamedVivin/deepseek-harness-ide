import { RpcId, type ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { describe, expect, it, vi } from 'vitest'
import {
  ChildProcessDesktopIpcAdapter,
  DesktopBodyId,
  DesktopMainIpcPeer,
  DesktopRequestId,
  InMemoryDesktopIpcAdapter,
  type DesktopIpcHost,
  type DesktopMainMessageEndpoint,
  type DesktopMessageEndpoint,
  type DesktopRendererInvocation,
  type DesktopSidecarInboundFrame,
  type DesktopSidecarOutboundFrame,
} from '../src/index.ts'

interface EndpointHarness<Endpoint, Sent> {
  readonly endpoint: Endpoint
  readonly sent: Sent[]
  readonly emit: (value: unknown) => void
}

function sidecarEndpoint(): EndpointHarness<DesktopMessageEndpoint, DesktopSidecarOutboundFrame> {
  const sent: DesktopSidecarOutboundFrame[] = []
  let message: ((value: unknown) => void) | undefined
  const endpoint: DesktopMessageEndpoint = {
    send(frame) {
      sent.push(frame)
      if (frame.type === 'body-chunk') {
        queueMicrotask(() => {
          message?.({
            version: 1,
            type: 'body-ack',
            bodyId: frame.bodyId,
            sequence: frame.sequence,
            byteLength: frame.chunk.byteLength,
          })
        })
      }
    },
    onMessage(listener) {
      message = listener
      return () => { message = undefined }
    },
    onDisconnect() {
      return () => {}
    },
  }
  return { endpoint, sent, emit: (value) => { message?.(value) } }
}

function mainEndpoint(): EndpointHarness<DesktopMainMessageEndpoint, DesktopSidecarInboundFrame> {
  const sent: DesktopSidecarInboundFrame[] = []
  let message: ((value: unknown) => void) | undefined
  const endpoint: DesktopMainMessageEndpoint = {
    send(frame) {
      sent.push(frame)
      if (frame.type === 'body-chunk') {
        queueMicrotask(() => {
          message?.({
            version: 1,
            type: 'body-ack',
            bodyId: frame.bodyId,
            sequence: frame.sequence,
            byteLength: frame.chunk.byteLength,
          })
        })
      }
    },
    onMessage(listener) {
      message = listener
      return () => { message = undefined }
    },
    onDisconnect() {
      return () => {}
    },
  }
  return { endpoint, sent, emit: (value) => { message?.(value) } }
}

function emitBody(emit: (value: unknown) => void, id: string, value: unknown): ReturnType<typeof DesktopBodyId> {
  const bodyId = DesktopBodyId(id)
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  emit({ version: 1, type: 'body-start', bodyId, byteLength: bytes.byteLength })
  emit({ version: 1, type: 'body-chunk', bodyId, sequence: 0, chunk: bytes })
  emit({ version: 1, type: 'body-end', bodyId })
  return bodyId
}

async function waitForFrame<
  Frame extends DesktopSidecarInboundFrame | DesktopSidecarOutboundFrame,
  Type extends Frame['type'],
>(sent: readonly Frame[], type: Type, count = 1): Promise<Extract<Frame, { type: Type }>> {
  await vi.waitFor(() => { expect(sent.filter(frame => frame.type === type)).toHaveLength(count) })
  const frame = sent.filter(value => value.type === type).at(-1)
  if (frame === undefined) throw new Error(`${type} was not sent`)
  return frame as Extract<Frame, { type: Type }>
}

function rpcInvocation(id = 'request'): DesktopRendererInvocation {
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

function serverEvent(id = 'event'): ServerRequest {
  return {
    type: 'server-request',
    rpcId: RpcId(id),
    method: 'session/subscribed',
    payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 },
  }
}

function ipcHost(): DesktopIpcHost {
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
  }
}

async function expectSidecarControlRejection(value: unknown): Promise<void> {
  const harness = sidecarEndpoint()
  const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
  const remove = adapter.install(ipcHost())
  harness.emit(value)
  await expect(adapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
  await remove()
}

async function expectMainControlRejection(value: unknown): Promise<void> {
  const harness = mainEndpoint()
  const peer = new DesktopMainIpcPeer(harness.endpoint, {
    'directory.pick': async () => ({ path: null }),
  })
  harness.emit(value)
  await expect(peer.invoke(rpcInvocation())).rejects.toThrow('disconnected')
  await peer.dispose()
}

const invalidInboundControls: readonly (readonly [string, unknown])[] = [
  ['null base', null],
  ['array base', []],
  ['missing version', { type: 'renderer-cancel', requestId: 'request' }],
  ['wrong version', { version: 2, type: 'renderer-cancel', requestId: 'request' }],
  ['non-string type', { version: 1, type: 1 }],
  ['invoke extra field', { version: 1, type: 'renderer-invoke', requestId: 'request', bodyId: 'body', extra: true }],
  ['invoke non-string request', { version: 1, type: 'renderer-invoke', requestId: 1, bodyId: 'body' }],
  ['invoke empty request', { version: 1, type: 'renderer-invoke', requestId: '', bodyId: 'body' }],
  ['invoke non-string body', { version: 1, type: 'renderer-invoke', requestId: 'request', bodyId: 1 }],
  ['invoke empty body', { version: 1, type: 'renderer-invoke', requestId: 'request', bodyId: '' }],
  ['system extra field', {
    version: 1,
    type: 'renderer-system',
    requestId: 'request',
    method: 'desktop.bootManifest',
    bodyId: 'body',
    extra: true,
  }],
  ['system invalid request', {
    version: 1,
    type: 'renderer-system',
    requestId: 1,
    method: 'desktop.bootManifest',
    bodyId: 'body',
  }],
  ['system invalid body', {
    version: 1,
    type: 'renderer-system',
    requestId: 'request',
    method: 'desktop.bootManifest',
    bodyId: 1,
  }],
  ['system invalid method', {
    version: 1,
    type: 'renderer-system',
    requestId: 'request',
    method: 'desktop.unknown',
    bodyId: 'body',
  }],
  ['cancel extra field', { version: 1, type: 'renderer-cancel', requestId: 'request', extra: true }],
  ['cancel non-string request', { version: 1, type: 'renderer-cancel', requestId: 1 }],
  ['cancel empty request', { version: 1, type: 'renderer-cancel', requestId: '' }],
  ['subscribe extra field', {
    version: 1,
    type: 'renderer-subscribe',
    subscriptionId: 'subscription',
    stream: 'events.mux',
    extra: true,
  }],
  ['subscribe non-string id', { version: 1, type: 'renderer-subscribe', subscriptionId: 1, stream: 'events.mux' }],
  ['subscribe empty id', { version: 1, type: 'renderer-subscribe', subscriptionId: '', stream: 'events.mux' }],
  ['subscribe invalid stream', {
    version: 1,
    type: 'renderer-subscribe',
    subscriptionId: 'subscription',
    stream: 'events.unknown',
  }],
  ['unsubscribe extra field', {
    version: 1,
    type: 'renderer-unsubscribe',
    subscriptionId: 'subscription',
    extra: true,
  }],
  ['unsubscribe non-string id', { version: 1, type: 'renderer-unsubscribe', subscriptionId: 1 }],
  ['unsubscribe empty id', { version: 1, type: 'renderer-unsubscribe', subscriptionId: '' }],
  ['host response extra field', {
    version: 1,
    type: 'host-response',
    requestId: 'request',
    bodyId: 'body',
    extra: true,
  }],
  ['host response invalid request', { version: 1, type: 'host-response', requestId: 1, bodyId: 'body' }],
  ['host response invalid body', { version: 1, type: 'host-response', requestId: 'request', bodyId: 1 }],
  ['unknown type', { version: 1, type: 'unknown' }],
]

const invalidOutboundControls: readonly (readonly [string, unknown])[] = [
  ['null base', null],
  ['array base', []],
  ['missing version', { type: 'renderer-result', requestId: 'request', bodyId: 'body' }],
  ['wrong version', { version: 2, type: 'renderer-result', requestId: 'request', bodyId: 'body' }],
  ['non-string type', { version: 1, type: 1 }],
  ['result extra field', { version: 1, type: 'renderer-result', requestId: 'request', bodyId: 'body', extra: true }],
  ['result non-string request', { version: 1, type: 'renderer-result', requestId: 1, bodyId: 'body' }],
  ['result empty request', { version: 1, type: 'renderer-result', requestId: '', bodyId: 'body' }],
  ['result non-string body', { version: 1, type: 'renderer-result', requestId: 'request', bodyId: 1 }],
  ['result empty body', { version: 1, type: 'renderer-result', requestId: 'request', bodyId: '' }],
  ['event extra field', {
    version: 1,
    type: 'renderer-event',
    subscriptionId: 'subscription',
    sequence: 0,
    bodyId: 'body',
    extra: true,
  }],
  ['event non-string id', { version: 1, type: 'renderer-event', subscriptionId: 1, sequence: 0, bodyId: 'body' }],
  ['event empty id', { version: 1, type: 'renderer-event', subscriptionId: '', sequence: 0, bodyId: 'body' }],
  ['event non-number sequence', {
    version: 1,
    type: 'renderer-event',
    subscriptionId: 'subscription',
    sequence: '0',
    bodyId: 'body',
  }],
  ['event fractional sequence', {
    version: 1,
    type: 'renderer-event',
    subscriptionId: 'subscription',
    sequence: 0.5,
    bodyId: 'body',
  }],
  ['event negative sequence', {
    version: 1,
    type: 'renderer-event',
    subscriptionId: 'subscription',
    sequence: -1,
    bodyId: 'body',
  }],
  ['event non-string body', {
    version: 1,
    type: 'renderer-event',
    subscriptionId: 'subscription',
    sequence: 0,
    bodyId: 1,
  }],
  ['event empty body', {
    version: 1,
    type: 'renderer-event',
    subscriptionId: 'subscription',
    sequence: 0,
    bodyId: '',
  }],
  ['end extra field', {
    version: 1,
    type: 'renderer-end',
    subscriptionId: 'subscription',
    bodyId: 'body',
    extra: true,
  }],
  ['end non-string id', { version: 1, type: 'renderer-end', subscriptionId: 1, bodyId: 'body' }],
  ['end empty id', { version: 1, type: 'renderer-end', subscriptionId: '', bodyId: 'body' }],
  ['end non-string body', { version: 1, type: 'renderer-end', subscriptionId: 'subscription', bodyId: 1 }],
  ['end empty body', { version: 1, type: 'renderer-end', subscriptionId: 'subscription', bodyId: '' }],
  ['host request extra field', {
    version: 1,
    type: 'host-request',
    requestId: 'request',
    method: 'directory.pick',
    bodyId: 'body',
    extra: true,
  }],
  ['host request invalid request', {
    version: 1,
    type: 'host-request',
    requestId: 1,
    method: 'directory.pick',
    bodyId: 'body',
  }],
  ['host request invalid body', {
    version: 1,
    type: 'host-request',
    requestId: 'request',
    method: 'directory.pick',
    bodyId: 1,
  }],
  ['host request invalid method', {
    version: 1,
    type: 'host-request',
    requestId: 'request',
    method: 'directory.unknown',
    bodyId: 'body',
  }],
  ['host cancel extra field', { version: 1, type: 'host-cancel', requestId: 'request', extra: true }],
  ['host cancel non-string request', { version: 1, type: 'host-cancel', requestId: 1 }],
  ['host cancel empty request', { version: 1, type: 'host-cancel', requestId: '' }],
  ['unknown type', { version: 1, type: 'unknown' }],
]

describe('desktop adapter hostile control frames', () => {
  it.each(invalidInboundControls)('rejects sidecar inbound %s', async (_name, value) => {
    await expectSidecarControlRejection(value)
  })

  it.each(invalidOutboundControls)('rejects sidecar outbound %s', async (_name, value) => {
    await expectMainControlRejection(value)
  })

  it('ignores valid controls for unknown correlation and subscription ids', async () => {
    const sidecar = sidecarEndpoint()
    const adapter = new ChildProcessDesktopIpcAdapter(sidecar.endpoint)
    const remove = adapter.install(ipcHost())
    sidecar.emit({ version: 1, type: 'renderer-cancel', requestId: DesktopRequestId('unknown-invoke') })
    sidecar.emit({
      version: 1,
      type: 'renderer-unsubscribe',
      subscriptionId: DesktopRequestId('unknown-subscription'),
    })
    const hostResult = emitBody(sidecar.emit, 'unknown-host-result', { ok: true, value: { path: null } })
    sidecar.emit({
      version: 1,
      type: 'host-response',
      requestId: DesktopRequestId('unknown-host'),
      bodyId: hostResult,
    })
    const hostAbort = new AbortController()
    const hostRequest = adapter.requestHost('directory.pick', {}, hostAbort.signal)
    await waitForFrame(sidecar.sent, 'host-request')
    hostAbort.abort(new Error('done'))
    await expect(hostRequest).rejects.toThrow('done')
    await remove()

    const main = mainEndpoint()
    const peer = new DesktopMainIpcPeer(main.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const unknownResult = emitBody(main.emit, 'unknown-renderer-result', { ok: true, value: {} })
    main.emit({
      version: 1,
      type: 'renderer-result',
      requestId: DesktopRequestId('unknown-renderer'),
      bodyId: unknownResult,
    })
    const unknownEvent = emitBody(main.emit, 'unknown-renderer-event', serverEvent('unknown-event'))
    main.emit({
      version: 1,
      type: 'renderer-event',
      subscriptionId: DesktopRequestId('unknown-subscription'),
      sequence: 0,
      bodyId: unknownEvent,
    })
    const unknownEnd = emitBody(main.emit, 'unknown-renderer-end', { ok: true, value: {} })
    main.emit({
      version: 1,
      type: 'renderer-end',
      subscriptionId: DesktopRequestId('unknown-subscription'),
      bodyId: unknownEnd,
    })
    main.emit({ version: 1, type: 'host-cancel', requestId: DesktopRequestId('unknown-host') })
    const invokeAbort = new AbortController()
    const invocation = peer.invoke(rpcInvocation('still-connected'), invokeAbort.signal)
    await waitForFrame(main.sent, 'renderer-invoke')
    invokeAbort.abort(new Error('done'))
    await expect(invocation).rejects.toThrow('done')
    await peer.dispose()
  })
})

async function beginInvocation(
  peer: DesktopMainIpcPeer,
  harness: EndpointHarness<DesktopMainMessageEndpoint, DesktopSidecarInboundFrame>,
  id: string,
  count = 1,
): Promise<{
  readonly request: Extract<DesktopSidecarInboundFrame, { type: 'renderer-invoke' }>
  readonly result: Promise<unknown>
}> {
  const result = peer.invoke(rpcInvocation(id))
  const request = await waitForFrame(harness.sent, 'renderer-invoke', count)
  return { request, result }
}

describe('desktop adapter hostile decoded bodies', () => {
  it.each([
    ['primitive', 1],
    ['rpc non-string channel', { kind: 'rpc', channel: 1, message: {} }],
    ['rpc invalid message', { kind: 'rpc', channel: '/api', message: {} }],
    ['respond invalid message', { kind: 'respond', message: {} }],
    ['unknown kind', { kind: 'unknown' }],
  ])('rejects invalid renderer invocation body %s', async (_name, value) => {
    const harness = sidecarEndpoint()
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost())
    const bodyId = emitBody(harness.emit, `invalid-invocation-${_name}`, value)
    harness.emit({
      version: 1,
      type: 'renderer-invoke',
      requestId: DesktopRequestId(`invalid-invocation-${_name}`),
      bodyId,
    })
    await expect(adapter.requestHost('directory.pick', {})).rejects.toThrow('disconnected')
    await remove()
  })

  it('accepts a valid renderer response invocation', async () => {
    const harness = sidecarEndpoint()
    const adapter = new ChildProcessDesktopIpcAdapter(harness.endpoint)
    const remove = adapter.install(ipcHost())
    const bodyId = emitBody(harness.emit, 'respond-invocation', {
      kind: 'respond',
      message: {
        type: 'client-response',
        rpcId: RpcId('respond-invocation'),
        result: { ok: true, value: {} },
      },
    })
    harness.emit({
      version: 1,
      type: 'renderer-invoke',
      requestId: DesktopRequestId('respond-invocation'),
      bodyId,
    })
    await waitForFrame(harness.sent, 'renderer-result')
    await remove()
  })

  it.each([
    ['primitive', 1],
    ['rpc invalid message', { kind: 'rpc', message: {} }],
    ['respond non-record receipt', { kind: 'respond', receipt: null }],
    ['respond non-boolean accepted', { kind: 'respond', receipt: { accepted: 'yes' } }],
    ['respond invalid rejection reason', { kind: 'respond', receipt: { accepted: false, reason: 'unknown' } }],
    ['unknown kind', { kind: 'unknown' }],
  ])('rejects invalid renderer result body %s', async (_name, value) => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const { request, result } = await beginInvocation(peer, harness, `invalid-result-${_name}`)
    const bodyId = emitBody(harness.emit, `invalid-result-${_name}`, { ok: true, value })
    harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId })
    await expect(result).rejects.toThrow(/renderer result/)
    await peer.dispose()
  })

  it('accepts a valid RPC renderer result body', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const { request, result } = await beginInvocation(peer, harness, 'valid-rpc-result')
    const bodyId = emitBody(harness.emit, 'valid-rpc-result', {
      ok: true,
      value: {
        kind: 'rpc',
        message: {
          type: 'server-response',
          rpcId: RpcId('valid-rpc-result'),
          result: { ok: true, value: {} },
        },
      },
    })
    harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId })
    await expect(result).resolves.toMatchObject({ kind: 'rpc', message: { rpcId: 'valid-rpc-result' } })
    await peer.dispose()
  })

  it('rejects an invalid boot manifest response', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const result = peer.system('desktop.bootManifest', {})
    const request = await waitForFrame(harness.sent, 'renderer-system')
    const bodyId = emitBody(harness.emit, 'invalid-boot-manifest', { ok: true, value: {} })
    harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId })
    await expect(result).rejects.toThrow('desktop.bootManifest response is invalid')
    await peer.dispose()
  })

  it('accepts a valid boot manifest response', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const result = peer.system('desktop.bootManifest', {})
    const request = await waitForFrame(harness.sent, 'renderer-system')
    const manifest = { rev: 'graph', entries: [] }
    const bodyId = emitBody(harness.emit, 'valid-boot-manifest', { ok: true, value: manifest })
    harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId })
    await expect(result).resolves.toEqual(manifest)
    await peer.dispose()
  })

  it.each([
    ['primitive', 1],
    ['missing ok', {}],
    ['non-boolean ok', { ok: 'yes' }],
  ])('rejects invalid correlated result %s', async (_name, value) => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const { request, result } = await beginInvocation(peer, harness, `invalid-wire-${_name}`)
    const bodyId = emitBody(harness.emit, `invalid-wire-${_name}`, value)
    harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId })
    await expect(result).rejects.toThrow('correlated result is invalid')
    await peer.dispose()
  })

  it.each([
    ['non-record error', { ok: false, error: null }],
    ['invalid code', { ok: false, error: { code: 'unknown', message: 'failed' } }],
    ['non-string message', { ok: false, error: { code: 'too-large', message: 1 } }],
  ])('rejects invalid correlated error %s', async (_name, value) => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const { request, result } = await beginInvocation(peer, harness, `invalid-error-${_name}`)
    const bodyId = emitBody(harness.emit, `invalid-error-${_name}`, value)
    harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId })
    await expect(result).rejects.toThrow('correlated error is invalid')
    await peer.dispose()
  })

  it.each([
    ['aborted', 'DesktopAbortedError'],
    ['bad-request', 'DesktopBadRequestError'],
    ['disconnected', 'DesktopDisconnectedError'],
    ['internal', 'DesktopInternalError'],
    ['not-authorized', 'DesktopNotAuthorizedError'],
    ['too-large', 'DesktopTooLargeError'],
  ] as const)('accepts correlated %s errors', async (code, name) => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const { request, result } = await beginInvocation(peer, harness, `wire-${code}`)
    const bodyId = emitBody(harness.emit, `wire-${code}`, {
      ok: false,
      error: { code, message: `${code} failure` },
    })
    harness.emit({ version: 1, type: 'renderer-result', requestId: request.requestId, bodyId })
    await expect(result).rejects.toMatchObject({ name, message: `${code} failure` })
    await peer.dispose()
  })

  it.each([
    ['primitive Host payload', 1],
    ['non-empty Host payload', { extra: true }],
  ])('rejects %s', async (_name, value) => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const bodyId = emitBody(harness.emit, `invalid-host-${_name}`, value)
    harness.emit({
      version: 1,
      type: 'host-request',
      requestId: DesktopRequestId(`invalid-host-${_name}`),
      method: 'directory.pick',
      bodyId,
    })
    await expect(peer.invoke(rpcInvocation())).rejects.toThrow('disconnected')
    await peer.dispose()
  })
})

describe('desktop adapter subscription queue endings', () => {
  it('delivers a queued stream error on the next pull', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const iterator = peer.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const subscription = await waitForFrame(harness.sent, 'renderer-subscribe')
    const eventBody = emitBody(harness.emit, 'queued-error-event', serverEvent('queued-error-event'))
    harness.emit({
      version: 1,
      type: 'renderer-event',
      subscriptionId: subscription.subscriptionId,
      sequence: 0,
      bodyId: eventBody,
    })
    await expect(first).resolves.toMatchObject({ done: false })
    const endBody = emitBody(harness.emit, 'queued-error-end', {
      ok: false,
      error: { code: 'internal', message: 'queued failure' },
    })
    harness.emit({
      version: 1,
      type: 'renderer-end',
      subscriptionId: subscription.subscriptionId,
      bodyId: endBody,
    })
    await expect(iterator.next()).rejects.toThrow('queued failure')
    await peer.dispose()
  })

  it('resolves a pending pull when the stream ends', async () => {
    const harness = mainEndpoint()
    const peer = new DesktopMainIpcPeer(harness.endpoint, {
      'directory.pick': async () => ({ path: null }),
    })
    const iterator = peer.subscribe('events.host', new AbortController().signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    const subscription = await waitForFrame(harness.sent, 'renderer-subscribe')
    const endBody = emitBody(harness.emit, 'pending-success-end', { ok: true, value: {} })
    harness.emit({
      version: 1,
      type: 'renderer-end',
      subscriptionId: subscription.subscriptionId,
      bodyId: endBody,
    })
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await peer.dispose()
  })
})

describe('desktop adapter abort helpers', () => {
  it('rejects an in-memory invocation through an already-aborted linked signal', async () => {
    const adapter = new InMemoryDesktopIpcAdapter({
      'directory.pick': async () => ({ path: null }),
    })
    const remove = adapter.install({
      ...ipcHost(),
      invoke: (_invocation, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('inner stopped')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    abort.abort(new Error('already stopped'))
    await expect(adapter.invoke(rpcInvocation('pre-aborted-memory'), abort.signal)).rejects.toThrow(
      'already stopped',
    )
    remove()
  })
})
