import { describe, expect, it, vi } from 'vitest'
import {
  parseDesktopRuntimeInboundFrame,
  parseDesktopRuntimeOutboundFrame,
} from '../src/runtime-protocol.ts'
import { DesktopSidecarLifecycle } from '../src/sidecar-lifecycle.ts'

describe('desktop runtime lifecycle protocol', () => {
  it('keeps lifecycle messages disjoint from Connection frames', () => {
    expect(parseDesktopRuntimeInboundFrame({
      version: 1,
      type: 'desktop-runtime-dispose',
      reason: 'app-quit',
    })).toEqual({ version: 1, type: 'desktop-runtime-dispose', reason: 'app-quit' })
    expect(parseDesktopRuntimeInboundFrame({
      version: 1,
      type: 'renderer-cancel',
      requestId: 'r1',
    })).toBeUndefined()
    expect(parseDesktopRuntimeInboundFrame({
      version: 1,
      type: 'desktop-runtime-dispose',
      reason: 'app-quit',
      extra: true,
    })).toBeUndefined()
  })

  it('validates ready graphs and stable failure frames', () => {
    expect(parseDesktopRuntimeOutboundFrame({
      version: 1,
      type: 'desktop-runtime-ready',
      graph: {
        rev: 'g1',
        entries: [{ id: 'plugin', url: 'dsh-app://plugins/plugin/client.js?rev=r1', rev: 'r1' }],
      },
    })).toMatchObject({ type: 'desktop-runtime-ready', graph: { rev: 'g1' } })
    expect(parseDesktopRuntimeOutboundFrame({
      version: 1,
      type: 'desktop-runtime-ready',
      graph: { rev: 'g1', entries: [{ id: 4 }] },
    })).toBeUndefined()
    expect(parseDesktopRuntimeOutboundFrame({
      version: 1,
      type: 'desktop-runtime-failed',
      message: 'boom',
    })).toEqual({ version: 1, type: 'desktop-runtime-failed', message: 'boom' })
  })

  it('disposes and disconnects exactly once across concurrent stop paths', async () => {
    const sent: unknown[] = []
    const disconnect = vi.fn()
    let release: (() => void) | undefined
    const dispose = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const lifecycle = new DesktopSidecarLifecycle({
      send(frame) { sent.push(frame); return true },
      disconnect,
    }, dispose)

    expect(lifecycle.handle({ version: 1, type: 'renderer-cancel', requestId: 'r1' })).toBe(false)
    expect(lifecycle.handle({
      version: 1,
      type: 'desktop-runtime-dispose',
      reason: 'app-quit',
    })).toBe(true)
    const second = lifecycle.shutdown()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(disconnect).not.toHaveBeenCalled()
    release?.()
    await second
    expect(sent).toEqual([{ version: 1, type: 'desktop-runtime-disposed' }])
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
