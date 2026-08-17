import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess-pty'
import { describe, expect, it, vi } from 'vitest'
import LocalSubprocessPtyRuntime from '@deepseek-ai/dsh-subprocess-pty-local'

function spec(overrides: Partial<SubprocessTerminalSpawnSpec> = {}): SubprocessTerminalSpawnSpec {
  return {
    argv: ['shell'],
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
    graceMs: 10,
    ...overrides,
  }
}

function fakeHandle(terminate: () => Promise<void>): SubprocessTerminalHandle {
  return {
    pid: 1,
    output: new PassThrough(),
    done: Promise.resolve({ exitCode: 0, signal: null }),
    write: async () => {},
    inspectForeground: async () => undefined,
    signalForeground: async () => 1,
    terminate,
  }
}

describe('LocalSubprocessPtyRuntime', () => {
  it('validates terminal allocation before calling node-pty', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessPtyRuntime)
    await expect(ctx.subprocessPty.spawnTerminal(spec({ argv: [] }))).rejects.toThrow('must contain a program')
    await expect(ctx.subprocessPty.spawnTerminal(spec({ argv: [''] }))).rejects.toThrow('must contain a program')
    await expect(ctx.subprocessPty.spawnTerminal(spec({ graceMs: 0 }))).rejects.toThrow('graceMs must be')
    await expect(ctx.subprocessPty.spawnTerminal(spec({ signal: AbortSignal.abort('stop') }))).rejects.toBe('stop')
    const runtime = ctx.subprocessPty
    await fiber.dispose()
    await expect(runtime.spawnTerminal(spec())).rejects.toThrow('service is disposing')
  })

  it('waits for all owned terminals and aggregates teardown failures', async () => {
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(LocalSubprocessPtyRuntime)
    const first = new Error('first cleanup failure')
    const second = new Error('second cleanup failure')
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const terminals = (ctx.subprocessPty as unknown as {
      terminals: Set<SubprocessTerminalHandle & { terminateForHostExit?(): void }>
    }).terminals
    terminals.add(fakeHandle(async () => { throw first }))
    terminals.add(fakeHandle(async () => { throw second }))
    terminals.add(fakeHandle(() => pending))

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    release()
    await disposing
    expect(terminals.size).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      errors: [first, second],
      message: 'local subprocess PTY teardown failed',
    })
  })

  it('contains host-exit failures and finalizes every remaining terminal', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessPtyRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')
    const failed = vi.fn(() => { throw new Error('failed') })
    const succeeded = vi.fn()
    const terminals = (ctx.subprocessPty as unknown as {
      terminals: Set<{ terminate(): Promise<void>; terminateForHostExit(): void }>
    }).terminals
    terminals.add({ terminate: async () => {}, terminateForHostExit: failed })
    terminals.add({ terminate: async () => {}, terminateForHostExit: succeeded })
    expect(() => { listener?.(0) }).not.toThrow()
    expect(failed).toHaveBeenCalledOnce()
    expect(succeeded).toHaveBeenCalledOnce()
    terminals.clear()
    await fiber.dispose()
    expect(process.listeners('exit')).not.toContain(listener)
  })

  it('reports a single teardown failure without wrapping it in an aggregate', async () => {
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(LocalSubprocessPtyRuntime)
    const failure = new Error('single cleanup failure')
    const terminals = (ctx.subprocessPty as unknown as {
      terminals: Set<SubprocessTerminalHandle>
    }).terminals
    terminals.add(fakeHandle(async () => { throw failure }))

    await fiber.dispose()
    expect(errors).toContain(failure)
  })

  it('publishes only a positive node-pty process id', async () => {
    const kill = vi.fn()
    vi.resetModules()
    vi.doMock('node-pty', () => ({
      spawn: () => ({
        pid: -1,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        write: () => {},
        kill,
      }),
    }))
    try {
      const { default: IsolatedRuntime } = await import('../src/index.ts')
      const ctx = new Context()
      const fiber = await ctx.plugin(IsolatedRuntime)
      await expect(ctx.subprocessPty.spawnTerminal(spec())).rejects.toThrow('positive process id')
      expect(kill).toHaveBeenCalledWith('SIGKILL')
      await fiber.dispose()
    } finally {
      vi.doUnmock('node-pty')
      vi.resetModules()
    }
  })

  it('releases successful terminals with injected and lazily-created inspectors', async () => {
    type ExitListener = (event: { exitCode: number; signal?: number }) => void
    let exitListener: ExitListener | undefined
    const inspector = {
      foregroundPgid: () => undefined,
      isStdinWaiting: () => false,
      processTree: () => [],
      processSession: () => [],
      isAlive: () => false,
      signalGroup: () => {},
      signalProcess: () => {},
    }
    vi.resetModules()
    vi.doMock('node-pty', () => ({
      spawn: () => ({
        pid: 123,
        onData: () => ({ dispose: () => {} }),
        onExit: (listener: ExitListener) => {
          exitListener = listener
          return { dispose: () => {} }
        },
        write: () => {},
        kill: () => { exitListener?.({ exitCode: 0, signal: 15 }) },
      }),
    }))
    vi.doMock('../src/process-inspector.ts', () => ({ createProcessInspector: () => inspector }))
    try {
      const { default: IsolatedRuntime } = await import('../src/index.ts')
      const injectedContext = new Context()
      const injectedFiber = await injectedContext.plugin(IsolatedRuntime)
      const injectedRuntime = injectedContext.subprocessPty as unknown as { terminalInspector: typeof inspector }
      injectedRuntime.terminalInspector = inspector
      const injected = await injectedContext.subprocessPty.spawnTerminal(spec())
      exitListener?.({ exitCode: 0 })
      await injected.done
      await new Promise(resolve => setImmediate(resolve))
      await injectedFiber.dispose()

      const lazyContext = new Context()
      const lazyFiber = await lazyContext.plugin(IsolatedRuntime)
      const lazy = await lazyContext.subprocessPty.spawnTerminal(spec())
      const terminate = vi.spyOn(lazy, 'terminate').mockRejectedValueOnce(new Error('automatic cleanup failed'))
      exitListener?.({ exitCode: 0 })
      await lazy.done
      await new Promise(resolve => setImmediate(resolve))
      terminate.mockRestore()
      await lazyFiber.dispose()
    } finally {
      vi.doUnmock('node-pty')
      vi.doUnmock('../src/process-inspector.ts')
      vi.resetModules()
    }
  })
})
