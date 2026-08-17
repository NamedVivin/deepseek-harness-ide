import { Context } from '@deepseek-ai/cordis'
import { RpcId, type ServerRequest, type ServerResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  ConnectionRpcAccessError,
  type HostConnectionTransportHost,
} from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import {
  ChildProcessDesktopIpcAdapter,
  DesktopBodyLimitError,
  DesktopBodyTransport,
  DesktopConnectionTransport,
  DesktopMainIpcPeer,
  DesktopProtocolError,
  InMemoryDesktopIpcAdapter,
  type DesktopBodyFrame,
  type DesktopIpcHost,
  type DesktopMainMessageEndpoint,
  type DesktopMessageEndpoint,
  type DesktopRendererSystemMethodMap,
  type DesktopSidecarInboundFrame,
  type DesktopSidecarOutboundFrame,
} from '../src/index.ts'

const SMALL_LIMITS = {
  maxDesktopBodyBytes: 4096,
  maxDesktopChunkBytes: 64,
  maxDesktopInflightBytes: 128,
}

interface EndpointPair {
  readonly sidecar: DesktopMessageEndpoint
  readonly main: DesktopMainMessageEndpoint
  readonly inbound: DesktopSidecarInboundFrame[]
  readonly outbound: DesktopSidecarOutboundFrame[]
  readonly disconnect: () => void
  onMainChunk?: () => void
}

function endpointPair(): EndpointPair {
  const sidecarMessages = new Set<(value: unknown) => void>()
  const mainMessages = new Set<(value: unknown) => void>()
  const sidecarDisconnects = new Set<() => void>()
  const mainDisconnects = new Set<() => void>()
  const inbound: DesktopSidecarInboundFrame[] = []
  const outbound: DesktopSidecarOutboundFrame[] = []
  const pair: EndpointPair = {
    sidecar: {
      send(frame) {
        outbound.push(frame)
        queueMicrotask(() => { for (const listener of mainMessages) listener(frame) })
      },
      onMessage(listener) {
        sidecarMessages.add(listener)
        return () => { sidecarMessages.delete(listener) }
      },
      onDisconnect(listener) {
        sidecarDisconnects.add(listener)
        return () => { sidecarDisconnects.delete(listener) }
      },
    },
    main: {
      send(frame) {
        inbound.push(frame)
        if (frame.type === 'body-chunk') pair.onMainChunk?.()
        queueMicrotask(() => { for (const listener of sidecarMessages) listener(frame) })
      },
      onMessage(listener) {
        mainMessages.add(listener)
        return () => { mainMessages.delete(listener) }
      },
      onDisconnect(listener) {
        mainDisconnects.add(listener)
        return () => { mainDisconnects.delete(listener) }
      },
    },
    inbound,
    outbound,
    disconnect: () => {
      for (const listener of sidecarDisconnects) listener()
      for (const listener of mainDisconnects) listener()
    },
  }
  return pair
}

function response(rpcId: ReturnType<typeof RpcId>, value: unknown): ServerResponse {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  }
}

function event(stream: 'events.mux' | 'events.host'): ServerRequest {
  return stream === 'events.mux'
    ? {
      type: 'server-request',
      rpcId: RpcId('mux-event'),
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 4 },
    }
    : {
      type: 'server-request',
      rpcId: RpcId('host-event'),
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    }
}

function ipcHost(overrides: Partial<DesktopIpcHost> = {}): DesktopIpcHost {
  return {
    async invoke(invocation) {
      if (invocation.kind === 'respond') return { kind: 'respond', receipt: { accepted: true } }
      return { kind: 'rpc', message: response(invocation.message.rpcId, invocation.message.payload) }
    },
    async system<K extends keyof DesktopRendererSystemMethodMap>(
      _method: K,
    ): Promise<DesktopRendererSystemMethodMap[K]['response']> {
      return {
        rev: 'graph-1',
        entries: [{ id: 'plugin', url: 'dsh-app://plugins/plugin/client.js?rev=1', rev: '1' }],
      } as DesktopRendererSystemMethodMap[K]['response']
    },
    async *subscribe(stream) {
      yield event(stream)
    },
    ...overrides,
  }
}

async function mountedPhysical(
  limits = SMALL_LIMITS,
  host = ipcHost(),
): Promise<{
  readonly pair: EndpointPair
  readonly adapter: ChildProcessDesktopIpcAdapter
  readonly peer: DesktopMainIpcPeer
  readonly dispose: () => Promise<void>
}> {
  const pair = endpointPair()
  const adapter = new ChildProcessDesktopIpcAdapter(pair.sidecar, limits)
  const peer = new DesktopMainIpcPeer(pair.main, {
    'directory.pick': async () => ({ path: '/picked' }),
  }, limits)
  const remove = adapter.install(host)
  return {
    pair,
    adapter,
    peer,
    dispose: async () => {
      await peer.dispose()
      await remove()
    },
  }
}

describe('desktop physical IPC', () => {
  it('chunks unary request and response bodies while sharing one acknowledged credit pool', async () => {
    const mounted = await mountedPhysical()
    let maxInflight = 0
    mounted.pair.onMainChunk = () => {
      maxInflight = Math.max(maxInflight, mounted.peer.inflightBytes)
    }
    try {
      const calls = [0, 1, 2].map(index => mounted.peer.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId(`request-${String(index)}`),
          method: 'session.prompt',
          payload: { content: 'x'.repeat(300), index },
        },
      }))
      const results = await Promise.all(calls)
      expect(results).toHaveLength(3)
      expect(maxInflight).toBe(SMALL_LIMITS.maxDesktopInflightBytes)
      expect(mounted.peer.inflightBytes).toBe(0)
      expect(mounted.pair.inbound.filter(frame => frame.type === 'body-chunk').every(
        frame => frame.type !== 'body-chunk' || frame.chunk.byteLength <= SMALL_LIMITS.maxDesktopChunkBytes,
      )).toBe(true)
      const controls = mounted.pair.inbound.filter(frame => frame.type === 'renderer-invoke')
      expect(controls).toHaveLength(3)
      expect(controls.every(frame => !('invocation' in frame))).toBe(true)
    } finally {
      await mounted.dispose()
    }
  })

  it('carries both downlinks, the boot graph system method, and the separate Host capability', async () => {
    const mounted = await mountedPhysical()
    try {
      const graph = await mounted.peer.system('desktop.bootManifest', {})
      expect(graph.rev).toBe('graph-1')

      const mux = mounted.peer.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
      const host = mounted.peer.subscribe('events.host', new AbortController().signal)[Symbol.asyncIterator]()
      expect((await mux.next()).value).toMatchObject({ method: 'session/subscribed' })
      expect((await host.next()).value).toMatchObject({ method: 'host/remote-event' })
      expect(await mounted.adapter.requestHost('directory.pick', {})).toEqual({ path: '/picked' })

      expect(mounted.pair.inbound.some(frame => frame.type === 'renderer-system')).toBe(true)
      expect(mounted.pair.outbound.some(frame => frame.type === 'host-request')).toBe(true)
    } finally {
      await mounted.dispose()
    }
  })

  it('rejects an oversized body before emitting an invocation control frame', async () => {
    const mounted = await mountedPhysical({
      maxDesktopBodyBytes: 128,
      maxDesktopChunkBytes: 32,
      maxDesktopInflightBytes: 64,
    })
    try {
      await expect(mounted.peer.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('too-large'),
          method: 'session.prompt',
          payload: { content: 'x'.repeat(256) },
        },
      })).rejects.toBeInstanceOf(DesktopBodyLimitError)
      expect(mounted.pair.inbound.some(frame => frame.type === 'renderer-invoke')).toBe(false)
    } finally {
      await mounted.dispose()
    }
  })

  it('propagates request cancellation and rejects pending work on peer disconnect', async () => {
    let sawAbort = false
    const host = ipcHost({
      invoke: (_invocation, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('invocation aborted'))
        }, { once: true })
      }),
    })
    const mounted = await mountedPhysical(SMALL_LIMITS, host)
    try {
      const abort = new AbortController()
      const cancelled = mounted.peer.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('cancelled'),
          method: 'session.list',
          payload: {},
        },
      }, abort.signal)
      await vi.waitFor(() => {
        expect(mounted.pair.inbound.some(frame => frame.type === 'renderer-invoke')).toBe(true)
      })
      abort.abort(new Error('test cancelled'))
      await expect(cancelled).rejects.toThrow('test cancelled')
      await vi.waitFor(() => { expect(sawAbort).toBe(true) })

      const pending = mounted.peer.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('disconnected'),
          method: 'session.list',
          payload: {},
        },
      })
      await vi.waitFor(() => {
        expect(mounted.pair.inbound.filter(frame => frame.type === 'renderer-invoke')).toHaveLength(2)
      })
      mounted.pair.disconnect()
      await expect(pending).rejects.toThrow(/disconnected/)
    } finally {
      await mounted.dispose()
    }
  })

  it('propagates subscription and Host-capability cancellation without waiting for late handlers', async () => {
    let streamAborted = false
    let pickerAborted = false
    const pair = endpointPair()
    const adapter = new ChildProcessDesktopIpcAdapter(pair.sidecar, SMALL_LIMITS)
    const peer = new DesktopMainIpcPeer(pair.main, {
      'directory.pick': (_payload, signal) => new Promise((_resolve) => {
        signal.addEventListener('abort', () => { pickerAborted = true }, { once: true })
      }),
    }, SMALL_LIMITS)
    const remove = adapter.install(ipcHost({
      subscribe: (_stream, signal) => ({
        async *[Symbol.asyncIterator]() {
          try {
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          } finally {
            streamAborted = true
          }
        },
      }),
    }))
    try {
      const streamAbort = new AbortController()
      const next = peer.subscribe('events.mux', streamAbort.signal)[Symbol.asyncIterator]().next()
      await vi.waitFor(() => {
        expect(pair.inbound.some(frame => frame.type === 'renderer-subscribe')).toBe(true)
      })
      streamAbort.abort(new Error('stream cancelled'))
      await expect(next).rejects.toThrow('stream cancelled')
      await vi.waitFor(() => { expect(streamAborted).toBe(true) })

      const pickerAbort = new AbortController()
      const picker = adapter.requestHost('directory.pick', {}, pickerAbort.signal)
      await vi.waitFor(() => {
        expect(pair.outbound.some(frame => frame.type === 'host-request')).toBe(true)
      })
      pickerAbort.abort(new Error('picker cancelled'))
      await expect(picker).rejects.toThrow('picker cancelled')
      await vi.waitFor(() => { expect(pickerAborted).toBe(true) })
    } finally {
      await peer.dispose()
      await remove()
    }
  })
})

describe('desktop body protocol', () => {
  it('rejects out-of-order and oversized physical chunks', () => {
    const sent: DesktopBodyFrame[] = []
    const transport = new DesktopBodyTransport((frame) => { sent.push(frame) }, {
      maxDesktopBodyBytes: 8,
      maxDesktopChunkBytes: 4,
      maxDesktopInflightBytes: 4,
    })
    transport.accept({ version: 1, type: 'body-start', bodyId: 'body' as never, byteLength: 4 })
    expect(() => {
      transport.accept({
        version: 1,
        type: 'body-chunk',
        bodyId: 'body' as never,
        sequence: 1,
        chunk: new Uint8Array([1]),
      })
    }).toThrow(DesktopProtocolError)
    expect(() => {
      transport.accept({ version: 1, type: 'body-start', bodyId: 'large' as never, byteLength: 9 })
    }).toThrow(DesktopBodyLimitError)
    expect(sent).toEqual([])
  })
})

describe('desktop dispatch policy', () => {
  it('keeps the renderer allowlist closed and validates session.create before dispatch', async () => {
    const ctx = new Context()
    const adapter = new InMemoryDesktopIpcAdapter({
      'directory.pick': async () => ({ path: null }),
    })
    const transport = new DesktopConnectionTransport(ctx, adapter)
    const dispatched: string[] = []
    const host: HostConnectionTransportHost = {
      onChannel: () => async () => {},
      async invoke(request) {
        const target = request.message.method.includes('/')
          ? {
            kind: 'registered' as const,
            channel: '/api',
            endpoint: request.message.method,
            authority: 'trusted-host' as const,
          }
          : {
            kind: 'api-proxy' as const,
            channel: '/api' as const,
            endpoint: request.message.method,
          }
        if (!request.authorize(target)) throw new ConnectionRpcAccessError(request.message.method)
        dispatched.push(request.message.method)
        return response(request.message.rpcId, {})
      },
      respond: async () => ({ accepted: true }),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    }
    const remove = transport.install(host)
    try {
      await expect(adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('denied'),
          method: 'agentPreset.read',
          payload: {},
        },
      })).rejects.toBeInstanceOf(ConnectionRpcAccessError)
      await expect(adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('unlisted-remote'),
          method: 'thirdParty/runProcess',
          payload: {},
        },
      })).rejects.toBeInstanceOf(ConnectionRpcAccessError)
      await adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('commands'),
          method: 'commands/list',
          payload: {},
        },
      })
      await adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('workspace-files'),
          method: 'workspaceFiles/read',
          payload: {},
        },
      })
      await expect(adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('cwd'),
          method: 'session.create',
          payload: { workspaceId: 'workspace-1', cwd: '/arbitrary' },
        },
      })).rejects.toBeInstanceOf(ConnectionRpcAccessError)
      await adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('allowed'),
          method: 'session.create',
          payload: { workspaceId: 'workspace-1', agentPreset: 'desktop-default' },
        },
      })
      expect(dispatched).toEqual(['commands/list', 'workspaceFiles/read', 'session.create'])
    } finally {
      await remove()
      await ctx.fiber.dispose()
    }
  })
})
