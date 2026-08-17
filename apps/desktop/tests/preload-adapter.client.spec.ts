// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { DesktopPreloadApi } from '@deepseek-ai/dsh-client-connection-desktop'
import { createDesktopRendererCapabilities } from '../src/renderer/preload-adapter.ts'

function fakePreload(overrides: Partial<DesktopPreloadApi> = {}): DesktopPreloadApi {
  const subscribe: DesktopPreloadApi['subscribe'] = (_id, _stream, onEvent, onEnd) => {
    onEvent({ id: 'event' } as never)
    onEnd({ ok: true })
  }
  return {
    invoke: vi.fn(() => Promise.resolve({ kind: 'respond', receipt: { ok: true } } as never)),
    system: vi.fn(() => Promise.resolve({ rev: 'graph', entries: [] })),
    cancel: vi.fn(),
    subscribe: vi.fn(subscribe),
    unsubscribe: vi.fn(),
    registerLifecycle: vi.fn(),
    settleLifecycle: vi.fn(),
    ...overrides,
  }
}

describe('desktop main-world preload adapter', () => {
  it('reconstructs system calls and ordered async downlinks', async () => {
    const unsubscribe = vi.fn()
    const preload = fakePreload({ unsubscribe })
    const capabilities = createDesktopRendererCapabilities(preload)
    await expect(capabilities.bridge.system('desktop.bootManifest', {})).resolves.toEqual({
      rev: 'graph', entries: [],
    })
    const abort = new AbortController()
    const events = []
    for await (const event of capabilities.bridge.subscribe('events.mux', abort.signal)) events.push(event)
    expect(events).toEqual([{ id: 'event' }])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('translates AbortSignal into a context-safe cancellation id', async () => {
    let rejectOperation: ((error: Error) => void) | undefined
    const cancel = vi.fn((_id: string) => { rejectOperation?.(new Error('cancelled')) })
    const preload = fakePreload({
      invoke: vi.fn(_id => new Promise((_resolve, reject) => { rejectOperation = reject })),
      cancel,
    })
    const capabilities = createDesktopRendererCapabilities(preload)
    const abort = new AbortController()
    const pending = capabilities.bridge.invoke({ kind: 'respond', message: {} as never }, abort.signal)
    abort.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('runs prepare-quit in the main world and returns only its boolean decision', async () => {
    let onRequest: ((id: string, payload: { reason: 'window-close' }) => void) | undefined
    const settleLifecycle = vi.fn()
    const preload = fakePreload({
      registerLifecycle: vi.fn((request) => { onRequest = request as typeof onRequest }),
      settleLifecycle,
    })
    const capabilities = createDesktopRendererCapabilities(preload)
    const dispose = capabilities.lifecycle.handle('desktop.prepareQuit', async payload => ({
      ready: payload.reason === 'window-close',
    }))
    onRequest?.('quit-1', { reason: 'window-close' })
    await vi.waitFor(() => {
      expect(settleLifecycle).toHaveBeenCalledWith('quit-1', { ready: true })
    })
    dispose()
  })
})
