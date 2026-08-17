import type {
  DesktopRendererBridge,
  DesktopRendererInvocation,
  DesktopRendererInvocationResult,
} from '@deepseek-ai/dsh-client-connection-desktop'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopMainRendererPortBridge,
  DesktopPreloadPortBridge,
  type DesktopPortEndpoint,
  type DesktopPortFrame,
} from '../src/electron-port-bridge.ts'

const SMALL_LIMITS = {
  maxDesktopBodyBytes: 4096,
  maxDesktopChunkBytes: 48,
  maxDesktopInflightBytes: 96,
}

const INVOCATION = {
  kind: 'rpc',
  channel: '/api',
  message: {
    type: 'client-request',
    rpcId: 'renderer-1',
    method: 'session.list',
    payload: {},
  },
} as DesktopRendererInvocation

const INVOCATION_RESULT = {
  kind: 'rpc',
  message: {
    type: 'server-response',
    rpcId: 'renderer-1',
    result: { ok: true, value: { sessions: [] } },
  },
} as DesktopRendererInvocationResult

interface PortPair {
  readonly main: DesktopPortEndpoint
  readonly preload: DesktopPortEndpoint
  readonly mainFrames: DesktopPortFrame[]
  readonly preloadFrames: DesktopPortFrame[]
  readonly disconnect: () => void
  readonly isClosed: () => boolean
}

function portPair(): PortPair {
  const mainMessages = new Set<(value: unknown) => void>()
  const preloadMessages = new Set<(value: unknown) => void>()
  const mainDisconnects = new Set<() => void>()
  const preloadDisconnects = new Set<() => void>()
  const mainFrames: DesktopPortFrame[] = []
  const preloadFrames: DesktopPortFrame[] = []
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    for (const listener of mainDisconnects) listener()
    for (const listener of preloadDisconnects) listener()
  }
  return {
    main: {
      send(frame) {
        if (closed) throw new Error('test port closed')
        mainFrames.push(frame)
        queueMicrotask(() => { for (const listener of preloadMessages) listener(frame) })
      },
      onMessage(listener) {
        mainMessages.add(listener)
        return () => { mainMessages.delete(listener) }
      },
      onDisconnect(listener) {
        mainDisconnects.add(listener)
        return () => { mainDisconnects.delete(listener) }
      },
      start() {},
      close,
    },
    preload: {
      send(frame) {
        if (closed) throw new Error('test port closed')
        preloadFrames.push(frame)
        queueMicrotask(() => { for (const listener of mainMessages) listener(frame) })
      },
      onMessage(listener) {
        preloadMessages.add(listener)
        return () => { preloadMessages.delete(listener) }
      },
      onDisconnect(listener) {
        preloadDisconnects.add(listener)
        return () => { preloadDisconnects.delete(listener) }
      },
      start() {},
      close,
    },
    mainFrames,
    preloadFrames,
    disconnect: close,
    isClosed: () => closed,
  }
}

function rendererBridge(): { bridge: DesktopRendererBridge; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => INVOCATION_RESULT)
  return {
    invoke,
    bridge: {
      invoke,
      system: vi.fn(async () => ({
        version: 1,
        entries: [],
        modules: [],
      } as never)),
      async *subscribe(stream) {
        yield {
          type: 'server-request',
          rpcId: `event-${stream}`,
          method: 'session/event',
          payload: { stream },
        } as never
      },
    },
  }
}

describe('Electron persistent MessagePort bridge', () => {
  it('carries invoke and system bodies in bounded chunks without inline control payloads', async () => {
    const pair = portPair()
    const renderer = rendererBridge()
    const main = new DesktopMainRendererPortBridge(pair.main, renderer.bridge, SMALL_LIMITS)
    const preload = new DesktopPreloadPortBridge(pair.preload, SMALL_LIMITS)

    await expect(preload.invoke(INVOCATION)).resolves.toEqual(INVOCATION_RESULT)
    await expect(preload.system('desktop.bootManifest', {})).resolves.toMatchObject({ version: 1 })

    expect(renderer.invoke).toHaveBeenCalledWith(INVOCATION, expect.any(AbortSignal))
    expect(pair.preloadFrames.some(frame => frame.type === 'body-chunk')).toBe(true)
    expect(pair.mainFrames.some(frame => frame.type === 'body-chunk')).toBe(true)
    const controls = [...pair.preloadFrames, ...pair.mainFrames]
      .filter(frame => !frame.type.startsWith('body-'))
    expect(controls.every(frame => !('payload' in frame) && !('value' in frame))).toBe(true)
    expect(preload.inflightBytes).toBe(0)
    expect(main.inflightBytes).toBe(0)

    await preload.dispose()
    await main.dispose()
  })

  it('multiplexes both downlinks and the closed dirty-state lifecycle request', async () => {
    const pair = portPair()
    const main = new DesktopMainRendererPortBridge(pair.main, rendererBridge().bridge, SMALL_LIMITS)
    const preload = new DesktopPreloadPortBridge(pair.preload, SMALL_LIMITS)
    const remove = preload.handle('desktop.prepareQuit', async payload => ({
      ready: payload.reason !== 'window-close',
    }))

    const mux = preload.subscribe('events.mux', new AbortController().signal)[Symbol.asyncIterator]()
    const host = preload.subscribe('events.host', new AbortController().signal)[Symbol.asyncIterator]()
    await expect(mux.next()).resolves.toMatchObject({ value: { payload: { stream: 'events.mux' } } })
    await expect(host.next()).resolves.toMatchObject({ value: { payload: { stream: 'events.host' } } })
    await expect(mux.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(host.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(main.request('desktop.prepareQuit', { reason: 'window-close' }))
      .resolves.toEqual({ ready: false })
    remove()

    await preload.dispose()
    await main.dispose()
  })

  it('propagates renderer cancellation and physical disconnect', async () => {
    const pair = portPair()
    let delegatedSignal: AbortSignal | undefined
    const renderer = rendererBridge()
    renderer.bridge.invoke = vi.fn((_invocation: DesktopRendererInvocation, signal?: AbortSignal) => {
      delegatedSignal = signal
      return new Promise<DesktopRendererInvocationResult>(() => {})
    })
    const main = new DesktopMainRendererPortBridge(pair.main, renderer.bridge, SMALL_LIMITS)
    const preload = new DesktopPreloadPortBridge(pair.preload, SMALL_LIMITS)
    const abort = new AbortController()
    const invocation = preload.invoke(INVOCATION, abort.signal)
    await vi.waitFor(() => { expect(delegatedSignal).toBeDefined() })
    abort.abort(new Error('renderer stopped waiting'))

    await expect(invocation).rejects.toThrow('renderer stopped waiting')
    await vi.waitFor(() => { expect(delegatedSignal?.aborted).toBe(true) })

    const lifecycle = main.request('desktop.prepareQuit', { reason: 'application-quit' })
    pair.disconnect()
    await expect(lifecycle).rejects.toThrow('disconnected')
    await preload.dispose()
    await main.dispose()
  })

  it('settles disposal when a lifecycle body has reserved credit but receives no acknowledgement', async () => {
    const pair = portPair()
    const main = new DesktopMainRendererPortBridge(pair.main, rendererBridge().bridge, SMALL_LIMITS)
    const lifecycle = main.request('desktop.prepareQuit', { reason: 'application-quit' })

    await expect(main.dispose()).resolves.toBeUndefined()
    await expect(lifecycle).rejects.toThrow('disconnected')
    expect(main.inflightBytes).toBe(0)
  })

  it('closes the port on malformed sequence and oversized body declarations', async () => {
    const sequencePair = portPair()
    const sequencePreload = new DesktopPreloadPortBridge(sequencePair.preload, SMALL_LIMITS)
    sequencePair.main.send({
      version: 1,
      type: 'body-start',
      bodyId: 'bad-sequence' as never,
      byteLength: 1,
    })
    sequencePair.main.send({
      version: 1,
      type: 'body-chunk',
      bodyId: 'bad-sequence' as never,
      sequence: 1,
      chunk: new Uint8Array([123]),
    })
    await vi.waitFor(() => { expect(sequencePair.isClosed()).toBe(true) })
    await sequencePreload.dispose()

    const sizePair = portPair()
    const sizePreload = new DesktopPreloadPortBridge(sizePair.preload, SMALL_LIMITS)
    sizePair.main.send({
      version: 1,
      type: 'body-start',
      bodyId: 'too-large' as never,
      byteLength: SMALL_LIMITS.maxDesktopBodyBytes + 1,
    })
    await vi.waitFor(() => { expect(sizePair.isClosed()).toBe(true) })
    await sizePreload.dispose()
  })
})
