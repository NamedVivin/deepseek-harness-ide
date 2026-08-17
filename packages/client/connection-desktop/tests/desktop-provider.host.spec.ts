import { Context } from '@deepseek-ai/cordis'
import { RpcId, type ServerRequest, type ServerResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  ConnectionRpcAccessError,
  type HostConnectionTransportHost,
} from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  DesktopConnectionTransport,
  DesktopHostBridge,
  InMemoryDesktopIpcAdapter,
  type DesktopIpcAdapter,
  type DesktopIpcHost,
} from '../src/index.ts'

const MEBIBYTE = 1024 * 1024

function response(rpcId: ReturnType<typeof RpcId>, value: unknown): ServerResponse {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: true, value },
  }
}

function transportHost(
  authorizeTarget?: Parameters<Parameters<HostConnectionTransportHost['invoke']>[0]['authorize']>[0],
): HostConnectionTransportHost {
  return {
    onChannel: () => async () => {},
    async invoke(request) {
      const target = authorizeTarget ?? {
        kind: 'api-proxy' as const,
        channel: '/api' as const,
        endpoint: request.message.method,
      }
      if (!request.authorize(target)) throw new ConnectionRpcAccessError(request.message.method)
      return response(request.message.rpcId, request.message.payload)
    },
    respond: async () => ({ accepted: true }),
    subscribe: stream => ({
      async *[Symbol.asyncIterator]() {
        const event: ServerRequest = stream === 'events.mux'
          ? {
            type: 'server-request',
            rpcId: RpcId('mux'),
            method: 'session/subscribed',
            payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 },
          }
          : {
            type: 'server-request',
            rpcId: RpcId('host'),
            method: 'host/remote-event',
            payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
          }
        yield event
      },
    }),
  }
}

function providerHarness(): {
  readonly ctx: Context
  readonly adapter: InMemoryDesktopIpcAdapter
  readonly transport: DesktopConnectionTransport
  readonly remove: () => void | Promise<void>
} {
  const ctx = new Context()
  ctx.provide('clientModules', {
    graph: () => ({ rev: 'graph-1', entries: [] }),
  } as never)
  const adapter = new InMemoryDesktopIpcAdapter({
    'directory.pick': async () => ({ path: '/picked' }),
  })
  const transport = new DesktopConnectionTransport(ctx, adapter)
  const remove = transport.install(transportHost())
  return { ctx, adapter, transport, remove }
}

async function disposeHarness(value: ReturnType<typeof providerHarness>): Promise<void> {
  await value.remove()
  await value.ctx.fiber.dispose()
}

async function awaitInvariantHost(ctx: Context): Promise<void> {
  await vi.waitFor(() => { expect(ctx.get('testInvariantReady')).toBe(true) })
}

describe('desktop Host provider', () => {
  it('exposes the separate Electron-main capability service', async () => {
    const ctx = new Context()
    const adapter = new InMemoryDesktopIpcAdapter({
      'directory.pick': async (_payload, signal) => {
        expect(signal.aborted).toBe(false)
        return { path: '/picked' }
      },
    })
    const bridge = new DesktopHostBridge(ctx, adapter)
    await expect(bridge.request('directory.pick', {})).resolves.toEqual({ path: '/picked' })
    await ctx.fiber.dispose()
  })

  it('dispatches responses, system graph reads, and both downlinks', async () => {
    const value = providerHarness()
    try {
      await expect(value.adapter.invoke({
        kind: 'respond',
        message: {
          type: 'client-response',
          rpcId: RpcId('response'),
          result: { ok: true, value: {} },
        },
      })).resolves.toEqual({ kind: 'respond', receipt: { accepted: true } })
      await expect(value.adapter.system('desktop.bootManifest', {})).resolves.toEqual({
        rev: 'graph-1',
        entries: [],
      })
      const mux = value.adapter.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
      await expect(mux.next()).resolves.toMatchObject({ value: { rpcId: 'mux' } })
    } finally {
      await disposeHarness(value)
    }
  })

  it('rejects an already-aborted system graph read with both reason forms', async () => {
    for (const reason of [new Error('closed'), 'closed']) {
      const value = providerHarness()
      try {
        const abort = new AbortController()
        abort.abort(reason)
        await expect(value.adapter.system('desktop.bootManifest', {}, abort.signal)).rejects.toThrow(
          reason instanceof Error ? 'closed' : 'desktop operation aborted',
        )
      } finally {
        await disposeHarness(value)
      }
    }
  })

  it('normalizes a non-Error system cancellation at the transport handler', async () => {
    const ctx = new Context()
    ctx.provide('clientModules', {
      graph: () => ({ rev: 'graph-1', entries: [] }),
    } as never)
    let handlers: DesktopIpcHost | undefined
    const adapter: DesktopIpcAdapter = {
      install(host) {
        handlers = host
        return () => {}
      },
      async requestHost() {
        return { path: null }
      },
    }
    const transport = new DesktopConnectionTransport(ctx, adapter)
    const remove = transport.install(transportHost())
    const abort = new AbortController()
    abort.abort('closed')
    try {
      if (handlers === undefined) throw new Error('desktop handlers were not installed')
      await expect(handlers.system('desktop.bootManifest', {}, abort.signal)).rejects.toThrow(
        'desktop system request aborted',
      )
    } finally {
      await remove()
      await ctx.fiber.dispose()
    }
  })

  it('denies registered endpoints arriving on a non-API channel', async () => {
    const ctx = new Context()
    const adapter = new InMemoryDesktopIpcAdapter({
      'directory.pick': async () => ({ path: null }),
    })
    const transport = new DesktopConnectionTransport(ctx, adapter)
    const remove = transport.install(transportHost({
      kind: 'registered',
      channel: '/other',
      endpoint: 'commands/list',
      authority: 'trusted-host',
    }))
    try {
      await expect(adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('wrong-channel'),
          method: 'commands/list',
          payload: {},
        },
      })).rejects.toBeInstanceOf(ConnectionRpcAccessError)
    } finally {
      await remove()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    null,
    [],
    'workspace-1',
    {},
    { workspaceId: '' },
    { workspaceId: 1 },
    { workspaceId: 'workspace-1', extra: true },
    { workspaceId: 'workspace-1', sessionId: '' },
    { workspaceId: 'workspace-1', sessionId: 1 },
    { workspaceId: 'workspace-1', agentPreset: 'other' },
  ])('denies unsafe session.create payload %#', async (payload) => {
    const value = providerHarness()
    try {
      await expect(value.adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('unsafe-create'),
          method: 'session.create',
          payload,
        },
      })).rejects.toBeInstanceOf(ConnectionRpcAccessError)
    } finally {
      await disposeHarness(value)
    }
  })

  it('accepts optional session.create fields only in their desktop forms', async () => {
    const value = providerHarness()
    try {
      await expect(value.adapter.invoke({
        kind: 'rpc',
        channel: '/api',
        message: {
          type: 'client-request',
          rpcId: RpcId('safe-create'),
          method: 'session.create',
          payload: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        },
      })).resolves.toMatchObject({ kind: 'rpc' })
    } finally {
      await disposeHarness(value)
    }
  })
})

describe('desktop provider composition', () => {
  function suppliedContext(imageBytes?: number): Context {
    const ctx = new Context()
    ctx.provide('clientModules', {
      graph: () => ({ rev: 'graph-1', entries: [] }),
    } as never)
    ctx.provide('desktopIpcAdapter', new InMemoryDesktopIpcAdapter({
      'directory.pick': async () => ({ path: null }),
    }) as DesktopIpcAdapter)
    if (imageBytes !== undefined) {
      ctx.provide('attachments', { imageLimits: { maxMessageImageBytes: imageBytes } } as never)
    }
    return ctx
  }

  it('installs supplied services with no attachment provider', async () => {
    const ctx = suppliedContext()
    apply(ctx)
    expect(ctx.get('desktopHostBridge')).toBeInstanceOf(DesktopHostBridge)
    expect(ctx.get('connectionTransport')).toBeInstanceOf(DesktopConnectionTransport)
    await awaitInvariantHost(ctx)
    await ctx.fiber.dispose()
  })

  it('accepts an attachment capacity that fits and rejects both insufficient capacities', async () => {
    const enough = suppliedContext(50 * MEBIBYTE)
    apply(enough, { maxDesktopBodyBytes: 70 * MEBIBYTE })
    await awaitInvariantHost(enough)
    await enough.fiber.dispose()

    const textTooLarge = suppliedContext()
    expect(() =>{  apply(textTooLarge, { maxDesktopBodyBytes: 2 * MEBIBYTE }) }).toThrow('worst-case escaped text buffer')
    await textTooLarge.fiber.dispose()

    const imagesTooLarge = suppliedContext(60 * MEBIBYTE)
    expect(() =>{  apply(imagesTooLarge, { maxDesktopBodyBytes: 70 * MEBIBYTE }) }).toThrow('aggregate image limit')
    await imagesTooLarge.fiber.dispose()
  })

  it('constructs the real Node child endpoint when no adapter is supplied', async () => {
    const ctx = new Context()
    ctx.provide('clientModules', {
      graph: () => ({ rev: 'graph-1', entries: [] }),
    } as never)
    expect(typeof process.send).toBe('function')
    apply(ctx, {})
    expect(ctx.get('connectionTransport')).toBeInstanceOf(DesktopConnectionTransport)
    await awaitInvariantHost(ctx)
    await ctx.fiber.dispose()
  })
})
