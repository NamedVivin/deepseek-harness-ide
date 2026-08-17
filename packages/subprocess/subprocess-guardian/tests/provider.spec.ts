import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  GuardianSubprocessRuntime,
  type Config,
  type GuardianSubprocessClient,
} from '../src/index.ts'

const config: Config = { maxBodyBytes: 1024, maxChunkBytes: 64, maxInflightBytes: 128 }

class FakeClient implements GuardianSubprocessClient {
  readonly outcome = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  terminated = false
  exited = false
  disposed = false
  pid = 123
  rejectOnTerminate = false
  spawnBarrier: PromiseWithResolvers<undefined> | undefined
  readonly spawnEntered = Promise.withResolvers<undefined>()
  async resolveExecutable(command: string): Promise<string> { return `/resolved/${command}` }
  async spawn(_spec: SubprocessSpawnSpec): Promise<SubprocessHandle> {
    this.spawnEntered.resolve(undefined)
    await this.spawnBarrier?.promise
    return {
      pid: this.pid,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {},
      done: this.outcome.promise,
      terminate: () => {
        this.terminated = true
        this.exited = true
        if (this.rejectOnTerminate) this.outcome.reject(new Error('native wait failed'))
        else this.outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
      },
      waitForExit: async () => this.exited,
    }
  }
  async dispose(): Promise<void> { this.disposed = true }
}

function runtimeWith(client: FakeClient): new (ctx: Context, config: Config) => GuardianSubprocessRuntime {
  return class TestRuntime extends GuardianSubprocessRuntime {
    constructor(ctx: Context, configured: Config) { super(ctx, configured, client) }
  }
}

function spec(): SubprocessSpawnSpec {
  return {
    argv: ['node'],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    graceMs: 100,
  }
}

describe('GuardianSubprocessRuntime', () => {
  it('exposes guardian lookup and positive-pid handles, then reaches quiescence on Cordis disposal', async () => {
    const ctx = new Context()
    const client = new FakeClient()
    const fiber = await ctx.plugin(runtimeWith(client), config)
    await expect(ctx.subprocess.resolveExecutable('node')).resolves.toBe('/resolved/node')
    const handle = await ctx.subprocess.spawn(spec())
    expect(handle.pid).toBe(123)
    const disposing = fiber.dispose()
    await disposing
    expect(client.terminated).toBe(true)
    expect(client.disposed).toBe(true)
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('rolls back a non-positive native pid instead of publishing a placeholder handle', async () => {
    const ctx = new Context()
    const client = new FakeClient()
    client.pid = -1
    await ctx.plugin(runtimeWith(client), config)
    await expect(ctx.subprocess.spawn(spec())).rejects.toThrow('non-positive pid')
    expect(client.terminated).toBe(true)
  })

  it('rejects work after disposal begins', async () => {
    const ctx = new Context()
    const client = new FakeClient()
    const fiber = await ctx.plugin(runtimeWith(client), config)
    const runtime = ctx.subprocess
    await fiber.dispose()
    await expect(runtime.resolveExecutable('node')).rejects.toThrow('disposing')
    await expect(runtime.spawn(spec())).rejects.toThrow('disposing')
  })

  it('rolls back a handle if disposal wins the asynchronous spawn race', async () => {
    const ctx = new Context()
    const client = new FakeClient()
    client.spawnBarrier = Promise.withResolvers<undefined>()
    client.rejectOnTerminate = true
    const fiber = await ctx.plugin(runtimeWith(client), config)
    const spawning = ctx.subprocess.spawn(spec())
    await client.spawnEntered.promise
    await fiber.dispose()
    client.spawnBarrier.resolve(undefined)
    await expect(spawning).rejects.toThrow('disposed during process setup')
    expect(client.terminated).toBe(true)
    expect(client.exited).toBe(true)
  })

  it('forgets a published handle after its native settlement rejects', async () => {
    const ctx = new Context()
    const client = new FakeClient()
    const fiber = await ctx.plugin(runtimeWith(client), config)
    const handle = await ctx.subprocess.spawn(spec())
    client.outcome.reject(new Error('native settlement failed'))
    await expect(handle.done).rejects.toThrow('native settlement failed')
    await vi.waitFor(() => {
      expect((ctx.subprocess as unknown as { live: Set<SubprocessHandle> }).live.size).toBe(0)
    })
    await fiber.dispose()
  })

  it('validates capacity configuration before opening the process IPC channel', () => {
    const ctx = new Context()
    expect(() => new GuardianSubprocessRuntime(ctx, { ...config, maxChunkBytes: 129 }))
      .toThrow('must not exceed')
  })
})
