import { mkdtemp, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  MacOsCapsuleSupervisor,
  WindowsJobSupervisor,
  guardianChildEnv,
  resolveGuardianExecutable,
  type GuardianNativeSpawnSpec,
  type MacOsCapsuleNativeTransport,
  type MacOsCapsulePreparation,
  type MacOsCapsuleProcess,
  type MacOsOwnershipMirror,
  type WindowsJobNativeTransport,
  type WindowsNativeJob,
  type WindowsSuspendedProcess,
} from '../src/supervisor.ts'

function nativeSpec(): GuardianNativeSpawnSpec {
  return {
    argv: [process.execPath, '-e', ''],
    cwd: process.cwd(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 100,
    env: {},
  }
}

class FakeWindowsNative implements WindowsJobNativeTransport {
  readonly operations: string[] = []
  next = 0
  failAt: string | undefined
  activeZero = true
  childPid = 1001
  createBarrier: PromiseWithResolvers<undefined> | undefined
  readonly createEntered = Promise.withResolvers<undefined>()
  readonly rollbackFailures = new Set<string>()

  async createKillOnCloseJob(): Promise<WindowsNativeJob> {
    this.hit('create-job')
    return { id: `job-${++this.next}` }
  }

  async createSuspendedProcess(): Promise<WindowsSuspendedProcess> {
    this.hit('create-suspended')
    this.createEntered.resolve(undefined)
    await this.createBarrier?.promise
    const id = `child-${this.next}`
    return {
      id,
      pid: this.childPid + this.next - 1,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
    }
  }

  async assignProcess(job: WindowsNativeJob): Promise<void> { this.hit(`assign:${job.id}`) }
  async resumeProcess(child: WindowsSuspendedProcess): Promise<void> { this.hit(`resume:${child.id}`) }
  async terminateProcess(child: WindowsSuspendedProcess): Promise<void> {
    this.operations.push(`terminate-process:${child.id}`)
    if (this.rollbackFailures.has('terminate-process')) throw new Error('terminate-process cleanup failed')
  }
  async terminateJob(job: WindowsNativeJob): Promise<void> {
    this.operations.push(`terminate-job:${job.id}`)
    if (this.rollbackFailures.has('terminate-job')) throw new Error('terminate-job cleanup failed')
  }
  async waitForActiveProcessZero(job: WindowsNativeJob, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    this.operations.push(`active-zero:${job.id}`)
    if (this.rollbackFailures.has('active-zero')) throw new Error('active-zero cleanup failed')
    return this.activeZero
  }
  async closeProcess(child: WindowsSuspendedProcess): Promise<void> {
    this.operations.push(`close-process:${child.id}`)
    if (this.rollbackFailures.has('close-process')) throw new Error('close-process cleanup failed')
  }
  async closeJob(job: WindowsNativeJob): Promise<void> {
    this.operations.push(`close-job:${job.id}`)
    if (this.rollbackFailures.has('close-job')) throw new Error('close-job cleanup failed')
  }
  async dispose(): Promise<void> { this.operations.push('native-dispose') }

  private hit(operation: string): void {
    this.operations.push(operation)
    if (this.failAt !== undefined && operation.startsWith(this.failAt)) throw new Error(`failed ${operation}`)
  }
}

class FakeCapsulePreparation implements MacOsCapsulePreparation {
  readonly capsuleId = 'capsule-1'
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly operations: string[]
  readonly process: MacOsCapsuleProcess
  failOutcome = false
  failRollback = false
  failResume = false
  failConfirm = false
  failTerminate = false
  failWait = false
  failRelease = false
  waitResult = true

  constructor(
    readonly pid: number,
    readonly processGroupId: number,
    operations: string[],
  ) {
    this.operations = operations
    this.process = {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: async () => {
        operations.push('capsule-terminate')
        if (this.failTerminate) throw 'capsule terminate transport failed'
      },
      waitForExit: async (signal) => {
        signal?.throwIfAborted()
        operations.push('capsule-wait')
        if (this.failWait) throw 'capsule wait transport failed'
        return this.waitResult
      },
      release: async () => {
        operations.push('capsule-release')
        if (this.failRelease) throw 'capsule release transport failed'
      },
    }
  }

  async confirmOwnership(receipt: string): Promise<void> {
    this.operations.push(`confirm:${receipt}`)
    if (this.failConfirm) throw 'capsule confirmation failed'
  }
  async resume(): Promise<MacOsCapsuleProcess> {
    this.operations.push('capsule-resume')
    if (this.failResume) throw 'capsule resume failed'
    if (!this.failOutcome) return this.process
    const done = Promise.reject(new Error('capsule helper crashed'))
    void done.catch(() => undefined)
    return { ...this.process, done }
  }
  async rollback(): Promise<void> {
    this.operations.push('capsule-rollback')
    if (this.failRollback) throw new Error('capsule rollback transport failed')
  }
}

class FakeCapsuleTransport implements MacOsCapsuleNativeTransport {
  readonly operations: string[] = []
  preparation = new FakeCapsulePreparation(501, 501, this.operations)
  prepareBarrier: PromiseWithResolvers<undefined> | undefined
  readonly prepareEntered = Promise.withResolvers<undefined>()
  async prepare(): Promise<MacOsCapsulePreparation> {
    this.operations.push('capsule-prepare')
    this.prepareEntered.resolve(undefined)
    await this.prepareBarrier?.promise
    return this.preparation
  }
  async dispose(): Promise<void> { this.operations.push('capsule-dispose') }
}

class FakeMirror implements MacOsOwnershipMirror {
  readonly operations: string[]
  failRegistration = false
  failRelease: 'error' | 'undefined' | undefined
  failRecover = false
  constructor(operations: string[]) { this.operations = operations }
  async register(capsuleId: string, pid: number, pgid: number): Promise<string> {
    this.operations.push(`mirror-register:${capsuleId}:${pid}:${pgid}`)
    if (this.failRegistration) throw new Error('mirror unavailable')
    return 'main-receipt'
  }
  async release(capsuleId: string): Promise<void> {
    this.operations.push(`mirror-release:${capsuleId}`)
    if (this.failRelease === 'error') throw new Error('mirror release failed')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- native promises may reject without an Error.
    if (this.failRelease === 'undefined') return Promise.reject()
  }
  async recover(capsuleId: string, reason: Error): Promise<void> {
    this.operations.push(`mirror-recover:${capsuleId}:${reason.message}`)
    if (this.failRecover) throw new Error('mirror recovery failed')
  }
}

describe('WindowsJobSupervisor', () => {
  it('assigns a suspended child to a private kill-on-close Job before resume and waits active-zero before close', async () => {
    const native = new FakeWindowsNative()
    const supervisor = new WindowsJobSupervisor(native)
    const prepared = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    expect(prepared.pid).toBe(1001)
    expect(native.operations).toEqual(['create-job', 'create-suspended', 'assign:job-1'])
    const owned = await prepared.resume()
    expect(native.operations.at(-1)).toBe('resume:child-1')
    await owned.terminate()
    expect(native.operations.at(-1)).toBe('terminate-job:job-1')
    expect(await owned.waitForExit()).toBe(true)
    await owned.release()
    expect(native.operations.slice(-3)).toEqual(['active-zero:job-1', 'close-process:child-1', 'close-job:job-1'])
    await supervisor.dispose()
    expect(native.operations.at(-1)).toBe('native-dispose')
  })

  it.each(['create-suspended', 'assign'])('rolls back every acquired native handle when %s fails', async (failure) => {
    const native = new FakeWindowsNative()
    native.failAt = failure
    const supervisor = new WindowsJobSupervisor(native)
    await expect(supervisor.prepare(nativeSpec(), new AbortController().signal)).rejects.toThrow('failed')
    if (failure === 'create-suspended') {
      expect(native.operations).toEqual([
        'create-job', 'create-suspended', 'terminate-job:job-1', 'active-zero:job-1', 'close-job:job-1',
      ])
    } else {
      expect(native.operations.slice(-5)).toEqual([
        'terminate-process:child-1', 'terminate-job:job-1', 'active-zero:job-1',
        'close-process:child-1', 'close-job:job-1',
      ])
    }
  })

  it('rolls back a Job when native resume fails and refuses release before active-process zero', async () => {
    const native = new FakeWindowsNative()
    const supervisor = new WindowsJobSupervisor(native)
    const prepared = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    native.failAt = 'resume'
    await expect(prepared.resume()).rejects.toThrow('failed resume')
    expect(native.operations.slice(-6)).toEqual([
      'resume:child-1', 'terminate-process:child-1', 'terminate-job:job-1', 'active-zero:job-1',
      'close-process:child-1', 'close-job:job-1',
    ])

    native.failAt = undefined
    const second = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    const owned = await second.resume()
    native.activeZero = false
    await expect(owned.release()).rejects.toThrow('active-process zero')
  })

  it('keeps concurrent process handles in independent Jobs', async () => {
    const native = new FakeWindowsNative()
    const supervisor = new WindowsJobSupervisor(native)
    const first = await (await supervisor.prepare(nativeSpec(), new AbortController().signal)).resume()
    const second = await (await supervisor.prepare(nativeSpec(), new AbortController().signal)).resume()
    await first.terminate()
    expect(native.operations).toContain('terminate-job:job-1')
    expect(native.operations).not.toContain('terminate-job:job-2')
    await second.terminate()
    expect(native.operations).toContain('terminate-job:job-2')
    await supervisor.dispose()
  })

  it('rolls back stopped children and kills, joins, and releases resumed Jobs on disposal', async () => {
    const native = new FakeWindowsNative()
    const supervisor = new WindowsJobSupervisor(native)
    await supervisor.prepare(nativeSpec(), new AbortController().signal)
    await (await supervisor.prepare(nativeSpec(), new AbortController().signal)).resume()
    await supervisor.dispose()
    expect(native.operations).toContain('terminate-process:child-1')
    expect(native.operations).toContain('terminate-job:job-2')
    expect(native.operations).toContain('active-zero:job-2')
    expect(native.operations.at(-1)).toBe('native-dispose')
  })

  it('makes preparation, rollback, release, and supervisor disposal idempotent', async () => {
    const native = new FakeWindowsNative()
    const supervisor = new WindowsJobSupervisor(native)
    const rolledBack = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    await rolledBack.rollback()
    await rolledBack.rollback()
    await expect(rolledBack.resume()).rejects.toThrow('not resumable')

    const prepared = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    const owned = await prepared.resume()
    await expect(prepared.resume()).rejects.toThrow('not resumable')
    await owned.release()
    await owned.release()
    await supervisor.dispose()
    await supervisor.dispose()
    await expect(supervisor.prepare(nativeSpec(), new AbortController().signal)).rejects.toThrow('disposing')
  })

  it.each([0, Number.NaN])('rejects native child pid %s and releases every acquired handle', async (pid) => {
    const native = new FakeWindowsNative()
    native.childPid = pid
    const supervisor = new WindowsJobSupervisor(native)
    await expect(supervisor.prepare(nativeSpec(), new AbortController().signal)).rejects.toThrow('non-positive pid')
    expect(native.operations).toContain('close-job:job-1')
  })

  it('rolls back a preparation when disposal wins native setup', async () => {
    const native = new FakeWindowsNative()
    native.createBarrier = Promise.withResolvers<undefined>()
    const supervisor = new WindowsJobSupervisor(native)
    const preparing = supervisor.prepare(nativeSpec(), new AbortController().signal)
    await native.createEntered.promise
    await supervisor.dispose()
    native.createBarrier.resolve(undefined)
    await expect(preparing).rejects.toThrow('disposed during process setup')
    expect(native.operations).toContain('close-job:job-1')
  })

  it('contains every rollback cleanup failure without replacing the preparation failure', async () => {
    const native = new FakeWindowsNative()
    native.failAt = 'assign'
    native.rollbackFailures.add('terminate-process')
    native.rollbackFailures.add('terminate-job')
    native.rollbackFailures.add('active-zero')
    native.rollbackFailures.add('close-process')
    native.rollbackFailures.add('close-job')
    const supervisor = new WindowsJobSupervisor(native)
    await expect(supervisor.prepare(nativeSpec(), new AbortController().signal)).rejects.toThrow('failed assign')
    expect(native.operations.slice(-5)).toEqual([
      'terminate-process:child-1',
      'terminate-job:job-1',
      'active-zero:job-1',
      'close-process:child-1',
      'close-job:job-1',
    ])
  })

  it('does not run cleanup operations when Job creation itself fails', async () => {
    const native = new FakeWindowsNative()
    native.failAt = 'create-job'
    const supervisor = new WindowsJobSupervisor(native)
    await expect(supervisor.prepare(nativeSpec(), new AbortController().signal)).rejects.toThrow('failed create-job')
    expect(native.operations).toEqual(['create-job'])
  })
})

describe('MacOsCapsuleSupervisor', () => {
  it('requires Electron-main PGID mirroring and capsule confirmation before resume', async () => {
    const transport = new FakeCapsuleTransport()
    const mirror = new FakeMirror(transport.operations)
    const supervisor = new MacOsCapsuleSupervisor(transport, mirror)
    const prepared = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    expect(transport.operations).toEqual([
      'capsule-prepare',
      'mirror-register:capsule-1:501:501',
      'confirm:main-receipt',
    ])
    const owned = await prepared.resume()
    expect(transport.operations.at(-1)).toBe('capsule-resume')
    await owned.terminate()
    await owned.release()
    expect(transport.operations.slice(-4)).toEqual([
      'capsule-terminate', 'capsule-wait', 'capsule-release', 'mirror-release:capsule-1',
    ])
    await supervisor.dispose()
  })

  it('rolls back a non-positive PGID or failed main mirror without publishing a preparation', async () => {
    const transport = new FakeCapsuleTransport()
    transport.preparation = new FakeCapsulePreparation(501, 0, transport.operations)
    const mirror = new FakeMirror(transport.operations)
    await expect(new MacOsCapsuleSupervisor(transport, mirror).prepare(nativeSpec(), new AbortController().signal))
      .rejects.toThrow('non-positive process group')
    expect(transport.operations).toContain('capsule-rollback')

    const secondTransport = new FakeCapsuleTransport()
    const failingMirror = new FakeMirror(secondTransport.operations)
    failingMirror.failRegistration = true
    await expect(new MacOsCapsuleSupervisor(secondTransport, failingMirror).prepare(nativeSpec(), new AbortController().signal))
      .rejects.toThrow('mirror unavailable')
    expect(secondTransport.operations.slice(-2)).toEqual(['capsule-rollback', 'mirror-release:capsule-1'])
  })

  it('kills and joins both stopped and resumed capsules on guardian disposal', async () => {
    const firstTransport = new FakeCapsuleTransport()
    const firstSupervisor = new MacOsCapsuleSupervisor(firstTransport, new FakeMirror(firstTransport.operations))
    await firstSupervisor.prepare(nativeSpec(), new AbortController().signal)
    await firstSupervisor.dispose()
    expect(firstTransport.operations).toContain('capsule-rollback')
    expect(firstTransport.operations.at(-1)).toBe('capsule-dispose')

    const secondTransport = new FakeCapsuleTransport()
    const secondSupervisor = new MacOsCapsuleSupervisor(secondTransport, new FakeMirror(secondTransport.operations))
    await (await secondSupervisor.prepare(nativeSpec(), new AbortController().signal)).resume()
    await secondSupervisor.dispose()
    expect(secondTransport.operations).toContain('capsule-terminate')
    expect(secondTransport.operations).toContain('capsule-wait')
    expect(secondTransport.operations).toContain('capsule-release')
  })

  it('asks Electron main to recover a stopped group when native rollback loses the capsule', async () => {
    const transport = new FakeCapsuleTransport()
    const mirror = new FakeMirror(transport.operations)
    const supervisor = new MacOsCapsuleSupervisor(transport, mirror)
    const prepared = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    transport.preparation.failRollback = true
    await prepared.rollback()
    expect(transport.operations).toContain(
      'mirror-recover:capsule-1:capsule rollback transport failed',
    )
    expect(transport.operations).not.toContain('mirror-release:capsule-1')
  })

  it('asks Electron main to recover a resumed group when the capsule helper crashes', async () => {
    const transport = new FakeCapsuleTransport()
    transport.preparation.failOutcome = true
    const mirror = new FakeMirror(transport.operations)
    const supervisor = new MacOsCapsuleSupervisor(transport, mirror)
    const owned = await (await supervisor.prepare(nativeSpec(), new AbortController().signal)).resume()
    await expect(owned.done).rejects.toThrow('capsule helper crashed')
    expect(transport.operations).toContain(
      'mirror-recover:capsule-1:capsule helper crashed',
    )
    await expect(owned.waitForExit()).resolves.toBe(true)
  })

  it('makes preparation, rollback, release, and supervisor disposal idempotent', async () => {
    const transport = new FakeCapsuleTransport()
    const supervisor = new MacOsCapsuleSupervisor(transport, new FakeMirror(transport.operations))
    const rolledBack = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    await rolledBack.rollback()
    await rolledBack.rollback()
    await expect(rolledBack.resume()).rejects.toThrow('not resumable')

    transport.preparation = new FakeCapsulePreparation(502, 502, transport.operations)
    const prepared = await supervisor.prepare(nativeSpec(), new AbortController().signal)
    const owned = await prepared.resume()
    await expect(prepared.resume()).rejects.toThrow('not resumable')
    await owned.release()
    await owned.release()
    await owned.terminate()
    await expect(owned.waitForExit()).resolves.toBe(true)
    ;(owned as unknown as { finish(): void; recover(reason: Error): Promise<void> }).finish()
    await (owned as unknown as { recover(reason: Error): Promise<void> }).recover(new Error('late recovery'))
    await supervisor.dispose()
    await supervisor.dispose()
    await expect(supervisor.prepare(nativeSpec(), new AbortController().signal)).rejects.toThrow('disposing')
  })

  it.each([0, Number.NaN])('rejects native capsule pid %s', async (pid) => {
    const transport = new FakeCapsuleTransport()
    transport.preparation = new FakeCapsulePreparation(pid, 501, transport.operations)
    await expect(new MacOsCapsuleSupervisor(transport, new FakeMirror(transport.operations))
      .prepare(nativeSpec(), new AbortController().signal)).rejects.toThrow('non-positive pid')
  })

  it('rolls back when disposal wins capsule setup', async () => {
    const transport = new FakeCapsuleTransport()
    transport.prepareBarrier = Promise.withResolvers<undefined>()
    const supervisor = new MacOsCapsuleSupervisor(transport, new FakeMirror(transport.operations))
    const preparing = supervisor.prepare(nativeSpec(), new AbortController().signal)
    await transport.prepareEntered.promise
    await supervisor.dispose()
    transport.prepareBarrier.resolve(undefined)
    await expect(preparing).rejects.toThrow('disposed during process setup')
    expect(transport.operations).toContain('capsule-rollback')
  })

  it('rolls back confirmation and resume failures without publishing ownership', async () => {
    const confirmationTransport = new FakeCapsuleTransport()
    confirmationTransport.preparation.failConfirm = true
    const confirmationMirror = new FakeMirror(confirmationTransport.operations)
    await expect(new MacOsCapsuleSupervisor(confirmationTransport, confirmationMirror)
      .prepare(nativeSpec(), new AbortController().signal)).rejects.toBe('capsule confirmation failed')
    expect(confirmationTransport.operations).toContain('capsule-rollback')

    const resumeTransport = new FakeCapsuleTransport()
    resumeTransport.preparation.failResume = true
    const prepared = await new MacOsCapsuleSupervisor(resumeTransport, new FakeMirror(resumeTransport.operations))
      .prepare(nativeSpec(), new AbortController().signal)
    await expect(prepared.resume()).rejects.toBe('capsule resume failed')
    expect(resumeTransport.operations).toContain('capsule-rollback')
  })

  it('recovers terminate, wait, and release failures through Electron main', async () => {
    for (const failure of ['terminate', 'wait', 'wait-result', 'release'] as const) {
      const transport = new FakeCapsuleTransport()
      const mirror = new FakeMirror(transport.operations)
      const owned = await (await new MacOsCapsuleSupervisor(transport, mirror)
        .prepare(nativeSpec(), new AbortController().signal)).resume()
      if (failure === 'terminate') {
        transport.preparation.failTerminate = true
        await owned.terminate()
      } else if (failure === 'wait') {
        transport.preparation.failWait = true
        await expect(owned.waitForExit()).resolves.toBe(true)
      } else {
        transport.preparation.waitResult = failure !== 'wait-result'
        transport.preparation.failRelease = failure === 'release'
        await owned.release()
      }
      expect(transport.operations.some(value => value.startsWith('mirror-recover:capsule-1:'))).toBe(true)
    }
  })

  it('reports combined capsule and recovery failure and permits a later recovery retry', async () => {
    const outcomeTransport = new FakeCapsuleTransport()
    outcomeTransport.preparation.failOutcome = true
    const outcomeMirror = new FakeMirror(outcomeTransport.operations)
    outcomeMirror.failRecover = true
    const outcome = await (await new MacOsCapsuleSupervisor(outcomeTransport, outcomeMirror)
      .prepare(nativeSpec(), new AbortController().signal)).resume()
    await expect(outcome.done).rejects.toMatchObject({ name: 'AggregateError' })

    const retryTransport = new FakeCapsuleTransport()
    retryTransport.preparation.failTerminate = true
    const retryMirror = new FakeMirror(retryTransport.operations)
    retryMirror.failRecover = true
    const retry = await (await new MacOsCapsuleSupervisor(retryTransport, retryMirror)
      .prepare(nativeSpec(), new AbortController().signal)).resume()
    await expect(retry.terminate()).rejects.toThrow('mirror recovery failed')
    retryMirror.failRecover = false
    await expect(retry.terminate()).resolves.toBeUndefined()
    expect(retryTransport.operations.filter(value => value.startsWith('mirror-recover:'))).toHaveLength(2)
  })

  it.each(['error', 'undefined'] as const)('recovers when mirror release rejects with %s', async (failure) => {
    const transport = new FakeCapsuleTransport()
    const mirror = new FakeMirror(transport.operations)
    mirror.failRelease = failure
    const prepared = await new MacOsCapsuleSupervisor(transport, mirror)
      .prepare(nativeSpec(), new AbortController().signal)
    await prepared.rollback()
    expect(transport.operations.some(value => value.startsWith('mirror-recover:capsule-1:'))).toBe(true)
  })
})

describe('guardian execution world helpers', () => {
  it('applies explicit environment tombstones with platform key semantics', () => {
    const old = process.env.DSH_GUARDIAN_TEST_SECRET
    const oldPath = process.env.GuardianPathCase
    process.env.DSH_GUARDIAN_TEST_SECRET = 'hidden'
    process.env.GuardianPathCase = 'ambient'
    try {
      expect(guardianChildEnv({ GuardianPathCase: null })).not.toHaveProperty('GuardianPathCase')
      expect(guardianChildEnv({ guardianpathcase: 'explicit' }, 'win32')).not.toHaveProperty('GuardianPathCase')
      expect(guardianChildEnv({ guardianpathcase: 'explicit' }, 'win32')).toHaveProperty('guardianpathcase', 'explicit')
      expect(guardianChildEnv()).not.toHaveProperty('DSH_GUARDIAN_TEST_SECRET')
    } finally {
      if (old === undefined) delete process.env.DSH_GUARDIAN_TEST_SECRET
      else process.env.DSH_GUARDIAN_TEST_SECRET = old
      if (oldPath === undefined) delete process.env.GuardianPathCase
      else process.env.GuardianPathCase = oldPath
    }
  })

  it('resolves absolute and bare executable names and rejects unsafe relative names and cancellation', async () => {
    const signal = new AbortController().signal
    await expect(resolveGuardianExecutable(process.execPath, process.env as Record<string, string>, signal)).resolves.toBe(process.execPath)
    const environment = { PATH: process.env.PATH ?? '' }
    await expect(resolveGuardianExecutable(process.platform === 'win32' ? 'node.exe' : 'node', environment, signal))
      .resolves.toContain('node')
    await expect(resolveGuardianExecutable('./node', environment, signal)).rejects.toThrow('relative path')
    await expect(resolveGuardianExecutable('', environment, signal)).rejects.toThrow('non-empty')
    const abort = AbortSignal.abort(new Error('lookup cancelled'))
    await expect(resolveGuardianExecutable('node', environment, abort)).rejects.toThrow('lookup cancelled')
  })

  it('reports not-found, non-lookup, and non-file executable failures', async () => {
    const signal = new AbortController().signal
    await expect(resolveGuardianExecutable('missing-dsh-guardian-command', { PATH: '/definitely/missing' }, signal))
      .rejects.toThrow('was not found')
    await expect(resolveGuardianExecutable('\0', { PATH: '' }, signal)).rejects.toThrow()
    await expect(resolveGuardianExecutable(tmpdir(), {}, signal)).rejects.toThrow('not a regular file')
  })

  it('applies Windows PATHEXT entries and accepts both extensionless and explicit-extension commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-guardian-path-'))
    const executable = join(directory, 'runner.EXE')
    await writeFile(executable, '')
    const signal = new AbortController().signal
    const environment = { Path: directory, PATHEXT: 'EXE;;.CMD' }
    await expect(resolveGuardianExecutable('runner', environment, signal, 'win32')).resolves.toBe(executable)
    await expect(resolveGuardianExecutable('runner.EXE', environment, signal, 'win32')).resolves.toBe(executable)
    await expect(resolveGuardianExecutable('runner', { PATH: directory, Pathext: '.EXE' }, signal, 'win32'))
      .resolves.toBe(executable)
    await expect(resolveGuardianExecutable('runner', { PATH: directory }, signal, 'win32')).resolves.toBe(executable)
    await expect(resolveGuardianExecutable(basename(process.execPath), { path: dirname(process.execPath) }, signal))
      .resolves.toBe(process.execPath)
    await expect(resolveGuardianExecutable('missing-dsh-guardian-command', {}, signal)).rejects.toThrow('was not found')
  })
})
