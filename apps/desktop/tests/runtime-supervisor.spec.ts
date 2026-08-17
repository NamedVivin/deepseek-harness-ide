import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRuntimeInboundFrame } from '../src/runtime-protocol.ts'
import type { DesktopRuntimeChild } from '../src/runtime-supervisor.ts'
import { DesktopRuntimeSupervisor } from '../src/runtime-supervisor.ts'

class FakeChild extends EventEmitter implements DesktopRuntimeChild {
  readonly pid = 42
  connected = true
  readonly sent: DesktopRuntimeInboundFrame[] = []
  readonly kill = vi.fn(() => true)

  send(message: DesktopRuntimeInboundFrame): boolean {
    this.sent.push(message)
    return true
  }
}

const config = {
  version: 1 as const,
  startupTimeoutMs: 100,
  gracefulShutdownMs: 100,
  forceShutdownMs: 100,
}

describe('desktop runtime supervisor', () => {
  it('publishes only a settled positive-PID runtime graph', async () => {
    const child = new FakeChild()
    const supervisor = new DesktopRuntimeSupervisor(child, config)
    const started = supervisor.start()
    child.emit('message', {
      version: 1,
      type: 'desktop-runtime-ready',
      graph: { rev: 'g1', entries: [] },
    })
    await expect(started).resolves.toEqual({ rev: 'g1', entries: [] })
  })

  it('gracefully disposes and joins exactly once', async () => {
    const child = new FakeChild()
    const supervisor = new DesktopRuntimeSupervisor(child, config)
    const started = supervisor.start()
    child.emit('message', {
      version: 1,
      type: 'desktop-runtime-ready',
      graph: { rev: 'g1', entries: [] },
    })
    await started
    const first = supervisor.shutdown('app-quit')
    const second = supervisor.shutdown('main-disconnect')
    expect(first).toBe(second)
    expect(child.sent).toEqual([{
      version: 1,
      type: 'desktop-runtime-dispose',
      reason: 'app-quit',
    }])
    child.emit('message', { version: 1, type: 'desktop-runtime-disposed' })
    child.emit('exit', 0, null)
    await first
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('force-kills and joins a runtime that misses the graceful deadline', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const supervisor = new DesktopRuntimeSupervisor(child, config)
      const started = supervisor.start()
      child.emit('message', {
        version: 1,
        type: 'desktop-runtime-ready',
        graph: { rev: 'g1', entries: [] },
      })
      await started
      const closing = supervisor.shutdown('app-quit')
      await vi.advanceTimersByTimeAsync(101)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      child.emit('exit', null, 'SIGKILL')
      await closing
    } finally {
      vi.useRealTimers()
    }
  })

  it('force-kills and joins a guardian whose IPC disconnected first', async () => {
    const child = new FakeChild()
    const supervisor = new DesktopRuntimeSupervisor(child, config)
    const started = supervisor.start()
    child.emit('message', {
      version: 1,
      type: 'desktop-runtime-ready',
      graph: { rev: 'g1', entries: [] },
    })
    await started
    child.connected = false
    child.emit('disconnect')
    const closing = supervisor.shutdown('main-disconnect')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('exit', null, 'SIGKILL')
    await closing
    expect(child.sent).toEqual([])
  })

  it('rejects startup failures and placeholder PIDs', async () => {
    const failed = new FakeChild()
    const supervisor = new DesktopRuntimeSupervisor(failed, config)
    const starting = supervisor.start()
    failed.emit('message', { version: 1, type: 'desktop-runtime-failed', message: 'bad config' })
    await expect(starting).rejects.toThrow('bad config')

    const invalid = new FakeChild()
    Object.defineProperty(invalid, 'pid', { value: -1 })
    await expect(new DesktopRuntimeSupervisor(invalid, config).start()).rejects.toThrow('positive PID')
  })
})
