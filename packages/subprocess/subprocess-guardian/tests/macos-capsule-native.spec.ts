import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
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
  const closeKeeper = async (): Promise<void> => {
    if (!keeperOpen) return
    keeperOpen = false
    keeper.kill('SIGKILL')
    await keeperExited
  }
  return {
    transport,
    closeMainLiveness: closeKeeper,
    disposeLiveness: closeKeeper,
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
