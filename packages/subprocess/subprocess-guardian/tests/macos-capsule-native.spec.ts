import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MacOsProcessCapsuleTransport } from '../src/macos-capsule.ts'

const native = describe.runIf(process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64'))

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} failed: ${String(code)} ${String(signal)}`))
    })
  })
}

async function fixture(): Promise<{
  readonly transport: MacOsProcessCapsuleTransport
  readonly closeMainLiveness: () => Promise<void>
  readonly disposeLiveness: () => Promise<void>
}> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-capsule-test-'))
  const helper = join(directory, 'process-capsule')
  await run(resolve('apps/desktop/native/process-capsule/build.sh'), [
    process.arch === 'arm64' ? 'arm64' : 'x86_64',
    helper,
  ])
  const keeper = spawn('/bin/sleep', ['30'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  })
  const nativeStdout = keeper.stdout as typeof keeper.stdout & {
    readonly _handle?: { readonly fd?: unknown }
  }
  const read = nativeStdout._handle?.fd
  if (typeof read !== 'number' || !Number.isSafeInteger(read) || read < 3) {
    keeper.kill('SIGKILL')
    throw new Error('native liveness pipe did not expose an inherited descriptor')
  }
  const keeperExited = new Promise<void>((resolvePromise, reject) => {
    keeper.once('error', reject)
    keeper.once('exit', () => { resolvePromise() })
  })
  const transport = new MacOsProcessCapsuleTransport({
    helperPath: helper,
    mainLivenessFd: read,
    maxSpecBytes: 1024 * 1024,
    groupPollMs: 5,
  })
  await transport.init()
  let keeperOpen = true
  let directoryPresent = true
  const closeKeeper = async (): Promise<void> => {
    if (!keeperOpen) return
    keeperOpen = false
    keeper.kill('SIGKILL')
    await keeperExited
  }
  const dispose = async (): Promise<void> => {
    await closeKeeper()
    if (!directoryPresent) return
    directoryPresent = false
    await rm(directory, { force: true, recursive: true })
  }
  return {
    transport,
    closeMainLiveness: closeKeeper,
    disposeLiveness: dispose,
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

native('native process capsule', () => {
  it('preserves real outcomes when quick targets empty the group before queued events are drained', async () => {
    const value = await fixture()
    try {
      for (let iteration = 0; iteration < 32; iteration++) {
        const prepared = await value.transport.prepare({
          argv: ['/usr/bin/true'],
          cwd: process.cwd(),
          env: { PATH: '/usr/bin:/bin' },
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 100,
        }, new AbortController().signal)
        await prepared.confirmOwnership('main-receipt')
        const owned = await prepared.resume()
        await expect(owned.done).resolves.toEqual({ exitCode: 0, signal: null })
        await expect(owned.waitForExit()).resolves.toBe(true)
        await owned.release()
      }
    } finally {
      await value.transport.dispose()
      await value.disposeLiveness()
    }
  }, 15_000)

  it('preserves a TERM handler exit outcome before reporting the process group empty', async () => {
    const value = await fixture()
    try {
      for (let iteration = 0; iteration < 8; iteration++) {
        const prepared = await value.transport.prepare({
          argv: [
            process.execPath,
            '-e',
            "process.on('SIGTERM', () => process.exit(42)); process.stdout.write('ready'); setInterval(() => {}, 1_000)",
          ],
          cwd: process.cwd(),
          env: { PATH: '/usr/bin:/bin' },
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 1_000,
        }, new AbortController().signal)
        const ready = Promise.withResolvers<undefined>()
        let output = ''
        prepared.stdout?.on('data', (chunk) => {
          output += String(chunk)
          if (output.includes('ready')) ready.resolve(undefined)
        })
        await prepared.confirmOwnership('main-receipt')
        const owned = await prepared.resume()
        await ready.promise
        await owned.terminate()
        await expect(owned.done).resolves.toEqual({ exitCode: 42, signal: null })
        await expect(owned.waitForExit()).resolves.toBe(true)
        await owned.release()
      }
    } finally {
      await value.transport.dispose()
      await value.disposeLiveness()
    }
  }, 15_000)

  it('synthesizes SIGKILL after initiated termination exhausts the capsule event source', async () => {
    const value = await fixture()
    try {
      const prepared = await value.transport.prepare({
        argv: [
          process.execPath,
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1_000)",
        ],
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 50,
      }, new AbortController().signal)
      const ready = Promise.withResolvers<undefined>()
      let output = ''
      prepared.stdout?.on('data', (chunk) => {
        output += String(chunk)
        if (output.includes('ready')) ready.resolve(undefined)
      })
      await prepared.confirmOwnership('main-receipt')
      const owned = await prepared.resume()
      await ready.promise
      await owned.terminate()
      await expect(owned.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
      await expect(owned.waitForExit()).resolves.toBe(true)
      await owned.release()
    } finally {
      await value.transport.dispose()
      await value.disposeLiveness()
    }
  })

  it('rejects an exhausted capsule event source without synthesizing a target outcome', async () => {
    const value = await fixture()
    try {
      const prepared = await value.transport.prepare({
        argv: ['/bin/sleep', '30'],
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 100,
      }, new AbortController().signal)
      const processGroupId = prepared.processGroupId
      await prepared.confirmOwnership('main-receipt')
      const owned = await prepared.resume()
      process.kill(-processGroupId, 'SIGKILL')
      await expect(owned.done).rejects.toThrow()
      await expect.poll(() => processGroupExists(processGroupId)).toBe(false)
      await expect.poll(() => (
        value.transport as unknown as { readonly connections: ReadonlySet<unknown> }
      ).connections.size).toBe(0)
    } finally {
      await value.transport.dispose()
      await value.disposeLiveness()
    }
  })

  it('publishes a stopped target, relays output, and joins a distinct process group', async () => {
    const value = await fixture()
    try {
      const prepared = await value.transport.prepare({
        argv: ['/bin/sh', '-c', 'printf capsule-native'],
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 100,
      }, new AbortController().signal)
      expect(prepared.pid).toBeGreaterThan(0)
      expect(prepared.processGroupId).toBeGreaterThan(0)
      expect(prepared.pid).not.toBe(prepared.processGroupId)
      let stdout = ''
      prepared.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      await prepared.confirmOwnership('main-receipt')
      const owned = await prepared.resume()
      await expect(owned.done).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(owned.waitForExit()).resolves.toBe(true)
      await owned.release()
      expect(stdout).toBe('capsule-native')
    } finally {
      await value.transport.dispose()
      await value.disposeLiveness()
    }
  })

  it('kills and joins a target that never receives resume', async () => {
    const value = await fixture()
    try {
      const prepared = await value.transport.prepare({
        argv: ['/bin/sleep', '30'],
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 50,
      }, new AbortController().signal)
      const processGroupId = prepared.processGroupId
      await prepared.rollback()
      expect(() => { process.kill(-processGroupId, 0) }).toThrow()
    } finally {
      await value.transport.dispose()
      await value.disposeLiveness()
    }
  })

  it('exits and removes the target process group when main liveness closes', async () => {
    const value = await fixture()
    try {
      const prepared = await value.transport.prepare({
        argv: ['/bin/sleep', '30'],
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 50,
      }, new AbortController().signal)
      const processGroupId = prepared.processGroupId
      await prepared.confirmOwnership('main-receipt')
      const owned = await prepared.resume()
      await value.closeMainLiveness()

      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('capsule did not exit after liveness loss')) }, 2_000)
        timer.unref()
      })
      try {
        await expect(Promise.race([owned.done, timeout])).rejects.toThrow('capsule exited unexpectedly')
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      expect(processGroupExists(processGroupId)).toBe(false)
    } finally {
      await value.transport.dispose()
      await value.disposeLiveness()
    }
  })
})
