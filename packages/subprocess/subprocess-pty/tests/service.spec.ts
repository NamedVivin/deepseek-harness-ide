import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessPtyRuntime } from '@deepseek-ai/dsh-subprocess-pty'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess-pty'
import { describe, expect, it } from 'vitest'

class StubSubprocessPtyRuntime extends SubprocessPtyRuntime {
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return {
      pid: spec.argv.length,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

describe('SubprocessPtyRuntime seam', () => {
  it('registers independently as ctx.subprocessPty', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessPtyRuntime)
    const handle = await ctx.subprocessPty.spawnTerminal({
      argv: ['shell'], cwd: '/stub', rows: 24, cols: 80, graceMs: 10,
    })
    expect(handle.pid).toBe(1)
    await expect(handle.inspectForeground()).resolves.toEqual({ processGroupId: 1, inputWaiting: true })
    await handle.terminate()
  })

  it('rejects a second PTY provider in the same context', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessPtyRuntime)
    class SecondService extends StubSubprocessPtyRuntime {}
    await expect(ctx.plugin(SecondService)).rejects.toThrow(/service "subprocessPty" has been registered/)
  })
})
