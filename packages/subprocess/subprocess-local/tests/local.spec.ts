import { describe, expect, it, vi } from 'vitest'
import { basename, dirname, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { childEnv } from '../src/spawn.ts'

function spec(command: string, overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', command],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
      stderr: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
    },
    graceMs: 200,
    ...overrides,
  }
}

describe('LocalSubprocessRuntime', () => {
  it('places the host-exit finalizer before listeners that predate the service', async () => {
    const baseline = new Set(process.listeners('exit'))
    const prior = vi.fn()
    process.on('exit', prior)
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const listeners = process.listeners('exit')
      const finalizer = listeners.find(candidate => !baseline.has(candidate) && candidate !== prior)
      expect(finalizer).toBeTypeOf('function')
      expect(listeners.indexOf(finalizer!)).toBeLessThan(listeners.indexOf(prior))
    } finally {
      process.off('exit', prior)
      await fiber.dispose()
    }
  })

  it('keeps the host-exit finalizer active until normal disposal reaches quiescence', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')

    let finishExit!: () => void
    const exited = new Promise<void>((resolve) => { finishExit = resolve })
    const terminate = vi.fn()
    const terminateForHostExit = vi.fn()
    const live = (ctx.subprocess as unknown as {
      live: Set<{
        done: Promise<{ exitCode: number; signal: null }>
        terminate(): void
        terminateForHostExit(): void
        waitForExit(): Promise<boolean>
      }>
    }).live
    live.add({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate,
      terminateForHostExit,
      waitForExit: async () => { await exited; return true },
    })

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    expect(live.size).toBe(1)
    listener?.(0)
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminateForHostExit).toHaveBeenCalledOnce()

    finishExit()
    await disposing
    expect(live.size).toBe(0)
    expect(process.listeners('exit')).not.toContain(listener)
  })

  it('contains each host-exit termination failure and continues with the other targets', async () => {
    const before = new Set(process.listeners('exit'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const listener = process.listeners('exit').find(candidate => !before.has(candidate))
    expect(listener).toBeTypeOf('function')
    const ordinaryFailure = vi.fn(() => { throw new Error('ordinary failed') })
    const ordinarySuccess = vi.fn()
    const service = ctx.subprocess as unknown as {
      live: Set<{ terminateForHostExit(): void }>
    }
    service.live.add({ terminateForHostExit: ordinaryFailure })
    service.live.add({ terminateForHostExit: ordinarySuccess })

    expect(() => { listener?.(0) }).not.toThrow()
    expect(ordinaryFailure).toHaveBeenCalledOnce()
    expect(ordinarySuccess).toHaveBeenCalledOnce()

    service.live.clear()
    await fiber.dispose()
  })

  it('resolves absolute and PATH executables and honors lookup cancellation', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    expect(await ctx.subprocess.resolveExecutable(process.execPath)).toBe(process.execPath)
    expect(await ctx.subprocess.resolveExecutable(basename(process.execPath), {
      PATH: dirname(process.execPath),
    })).toBe(process.execPath)
    expect(await ctx.subprocess.resolveExecutable(basename(process.execPath), {
      PATH: relative(process.cwd(), dirname(process.execPath)) || '.',
    })).toBe(process.execPath)
    await expect(ctx.subprocess.resolveExecutable('')).rejects.toThrow('must be non-empty')
    await expect(ctx.subprocess.resolveExecutable('./bin/tsserver'))
      .rejects.toThrow('is a relative path')
    await expect(ctx.subprocess.resolveExecutable('node_modules/.bin/server'))
      .rejects.toThrow('is a relative path')
    await expect(ctx.subprocess.resolveExecutable('dsh-command-that-does-not-exist', { PATH: '' }))
      .rejects.toThrow('was not found on PATH')
    await expect(ctx.subprocess.resolveExecutable('/dsh-absolute-command-that-does-not-exist'))
      .rejects.toThrow('is not an executable file')
    await expect(ctx.subprocess.resolveExecutable(process.cwd()))
      .rejects.toThrow('is not an executable file')
    await expect(ctx.subprocess.resolveExecutable(process.execPath, {}, AbortSignal.abort('stop')))
      .rejects.toBe('stop')
    await fiber.dispose()
  })

  it('builds Windows executable candidates with case-insensitive overrides', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const service = ctx.subprocess as LocalSubprocessRuntime
    const candidates = (service as unknown as {
      executableCandidates(command: string, env: NodeJS.ProcessEnv): string[]
    }).executableCandidates.bind(service)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      expect(Object.keys(childEnv()).filter(key => key.toUpperCase() === 'PATH')).toHaveLength(1)
      const explicit = childEnv({ Path: '/bin', PathExt: '.EXE;.CMD' })
      expect(Object.keys(explicit).filter(key => key.toUpperCase() === 'PATH')).toEqual(['Path'])
      expect(Object.keys(explicit).filter(key => key.toUpperCase() === 'PATHEXT')).toEqual(['PathExt'])
      expect(candidates('tool', explicit)).toEqual(['/bin/tool.EXE', '/bin/tool.CMD'])
      expect(candidates('tool', { Path: '/ambient', PATH: '/explicit', PATHEXT: '.EXE' }))
        .toEqual(['/explicit/tool.EXE'])
      expect(candidates('tool.exe', {})).toEqual([resolve(process.cwd(), 'tool.exe')])
      expect(candidates('tool', { PATH: '/bin' })).toHaveLength(4)
      await expect(ctx.subprocess.resolveExecutable(String.raw`bin\server.exe`))
        .rejects.toThrow('is a relative path')
    } finally {
      platform.mockRestore()
      await fiber.dispose()
    }
  })

  it('registers as ctx.subprocess and spawns managed handles', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = await ctx.subprocess.spawn(spec('echo managed'))
    expect(handle.pid).toBeGreaterThan(0)
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(handle.collected.stdout!.readFrom(0).text).toBe('managed\n')
    await fiber.dispose()
  })

  it('disposal kills still-running processes and awaits their exit', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = await ctx.subprocess.spawn(spec('sleep 60'))
    await fiber.dispose()
    const outcome = await handle.done
    expect(outcome.signal).toBe('SIGTERM')
  })

  it('a settled process leaves the live set (disposal does not re-kill it)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = await ctx.subprocess.spawn(spec('true'))
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    await fiber.dispose()
  })

  it('disposal tolerates a handle whose spawn already failed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.subprocess.spawn(spec('true', { cwd: '/nonexistent-dir-dsh-subprocess-test' })))
      .rejects.toThrow()
    await fiber.dispose()
  })

  it('disposal contains a spawn-failure rejection that races teardown', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    // Dispose before the rejection continuation removes the handle from the
    // live set, so teardown itself must swallow the rejected done.
    const spawning = ctx.subprocess.spawn(spec('true', { cwd: '/nonexistent-dir-dsh-subprocess-test' }))
    const rejected = expect(spawning).rejects.toThrow()
    await fiber.dispose()
    await rejected
  })

  it('withholds a handle when successful process creation races service disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const spawning = ctx.subprocess.spawn(spec('sleep 60'))
    const service = ctx.subprocess as unknown as {
      live: Set<{ done: Promise<unknown> }>
      spawn(spec: SubprocessSpawnSpec): Promise<SubprocessHandle>
    }
    const handle = [...service.live][0]
    if (handle === undefined) throw new Error('expected one pending handle')
    const rejectedDone = Promise.reject(new Error('late process observation failed'))
    void rejectedDone.catch(() => undefined)
    Reflect.set(handle, 'done', rejectedDone)
    const spawnOutcome = spawning.then(
      () => undefined,
      (error: unknown) => error,
    )
    const disposing = fiber.dispose()

    await vi.waitFor(() => {
      expect(Reflect.get(service, 'disposing')).toBe(true)
    })
    await expect(service.spawn(spec('true'))).rejects.toThrow('service is disposing')
    await expect(spawnOutcome).resolves.toMatchObject({ message: 'subprocess-local: service disposed during process setup' })
    await expect(disposing).resolves.toBeUndefined()
  })

  it('reports one failed cleanup and aggregates sibling cleanup failures', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const service = ctx.subprocess as unknown as {
      disposeManagedProcesses(): Promise<void>
      live: Set<{
        done: Promise<unknown>
        terminate(): void
        terminateForHostExit(): void
        waitForExit(): Promise<boolean>
      }>
    }
    const failed = (message: string) => ({
      done: Promise.resolve(),
      terminate: vi.fn(),
      terminateForHostExit: vi.fn(),
      waitForExit: vi.fn(async () => { throw new Error(message) }),
    })

    service.live.add(failed('one cleanup failed'))
    await expect(service.disposeManagedProcesses()).rejects.toThrow('one cleanup failed')

    service.live.add(failed('first cleanup failed'))
    service.live.add(failed('second cleanup failed'))
    await expect(service.disposeManagedProcesses()).rejects.toBeInstanceOf(AggregateError)

    await fiber.dispose()
  })

  it('loading a second implementation throws (one processes service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    class SecondManager extends LocalSubprocessRuntime {}
    await expect(ctx.plugin(SecondManager)).rejects.toThrow(/service "subprocess" has been registered/)
  })
})
