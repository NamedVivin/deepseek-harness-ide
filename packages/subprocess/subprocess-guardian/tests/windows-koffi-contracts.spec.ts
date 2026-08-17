import type { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createKoffiWindowsJobTransport,
  KoffiWindowsJobTransport,
} from '../src/windows-koffi.ts'
import type {
  GuardianNativeSpawnSpec,
  WindowsNativeJob,
  WindowsSuspendedProcess,
} from '../src/supervisor.ts'

interface ProcessInformation {
  readonly hProcess: bigint | null
  readonly hThread: bigint | null
  readonly dwProcessId: number
  readonly dwThreadId: number
}

interface ReadPlan {
  readonly result: number
  readonly count: number
  readonly data: string
  readonly errorCode: number
  readonly asyncError: unknown
}

interface WritePlan {
  readonly result: number
  readonly count: number
  readonly errorCode: number
  readonly asyncError: unknown
}

interface BindingState {
  readonly values: Map<object, unknown>
  readonly closed: bigint[]
  readonly terminatedProcesses: bigint[]
  readonly inherited: bigint[]
  readonly restored: bigint[]
  readonly readPlans: ReadPlan[]
  readonly writePlans: WritePlan[]
  readonly waitResults: number[]
  readonly activeCounts: number[]
  readonly failSetHandleCalls: Set<number>
  nextHandle: bigint
  lastError: number
  setHandleCalls: number
  jobHandle: bigint | null | undefined
  processInformation: ProcessInformation | undefined
  pipeReturnsNull: boolean
  pipeAliasesHandles: boolean
  createPipeResult: number
  stdHandle: bigint | null | undefined
  createProcessResult: number
  probeResult: number
  probeError: number
  attributeSize: unknown
  initializeResult: number
  updateResult: number
  setJobResult: number
  assignResult: number
  resumeResult: number
  terminateProcessResult: number
  terminateJobResult: number
  queryResult: number
  activeDefault: number
  exitResult: number
  exitCode: number
  waitAsyncError: unknown
  deleteAttributes: number
}

interface NativeFunction<Result> {
  (...args: unknown[]): Result
  async(...args: unknown[]): void
}

function native<Result>(run: (args: unknown[]) => Result): NativeFunction<Result> {
  const value = ((...args: unknown[]) => run(args)) as NativeFunction<Result>
  value.async = (...args: unknown[]): void => {
    const callback = args.pop() as (error: unknown, result: Result | undefined) => void
    queueMicrotask(() => {
      try {
        callback(null, run(args))
      } catch (error) {
        callback(error, undefined)
      }
    })
  }
  return value
}

function state(): BindingState {
  return {
    values: new Map(),
    closed: [],
    terminatedProcesses: [],
    inherited: [],
    restored: [],
    readPlans: [],
    writePlans: [],
    waitResults: [],
    activeCounts: [],
    failSetHandleCalls: new Set(),
    nextHandle: 10n,
    lastError: 87,
    setHandleCalls: 0,
    jobHandle: 200n,
    processInformation: { hProcess: 100n, hThread: 101n, dwProcessId: 4242, dwThreadId: 4343 },
    pipeReturnsNull: false,
    pipeAliasesHandles: false,
    createPipeResult: 1,
    stdHandle: 90n,
    createProcessResult: 1,
    probeResult: 0,
    probeError: 122,
    attributeSize: 64,
    initializeResult: 1,
    updateResult: 1,
    setJobResult: 1,
    assignResult: 1,
    resumeResult: 1,
    terminateProcessResult: 1,
    terminateJobResult: 1,
    queryResult: 1,
    activeDefault: 0,
    exitResult: 1,
    exitCode: 7,
    waitAsyncError: undefined,
    deleteAttributes: 0,
  }
}

function fakeBindings(value: BindingState): unknown {
  const allocate = (_type: unknown, _length = 1): object => ({ allocation: Symbol('native') })
  const encode = (target: object, _type: unknown, encoded: unknown): void => { value.values.set(target, encoded) }
  const decode = (target: object, _type: unknown): unknown => value.values.get(target)
  const waitForSingleObject = native<number>((args) => {
    if (value.waitAsyncError !== undefined) throw value.waitAsyncError
    void args
    return value.waitResults.shift() ?? 0
  })
  const readFile = native<number>((args) => {
    const plan = value.readPlans.shift() ?? {
      result: 0,
      count: 0,
      data: '',
      errorCode: 109,
      asyncError: undefined,
    }
    if (plan.asyncError !== undefined) throw plan.asyncError
    value.lastError = plan.errorCode
    if (plan.result !== 0) {
      const target = args[1] as Buffer
      const read = args[3] as Buffer
      Buffer.from(plan.data).copy(target)
      read.writeUInt32LE(plan.count)
    }
    return plan.result
  })
  const writeFile = native<number>((args) => {
    const data = args[1] as Buffer
    const plan = value.writePlans.shift() ?? {
      result: 1,
      count: data.length,
      errorCode: 0,
      asyncError: undefined,
    }
    if (plan.asyncError !== undefined) throw plan.asyncError
    value.lastError = plan.errorCode
    ;(args[3] as Buffer).writeUInt32LE(plan.count)
    return plan.result
  })
  return {
    types: {
      pointer: 'pointer',
      startupInfo: 'startup-info',
      startupInfoEx: 'startup-info-ex',
      processInformation: 'process-information',
      sizeT: 'size_t',
      uint8: 'uint8',
      pointerSize: 8,
    },
    createPipe: (read: object, write: object): number => {
      if (value.createPipeResult === 0) return 0
      const readHandle = value.pipeReturnsNull ? null : value.nextHandle++
      encode(read, 'pointer', readHandle)
      encode(write, 'pointer', value.pipeAliasesHandles ? readHandle : value.nextHandle++)
      return 1
    },
    setHandleInformation: (handle: bigint, _mask: number, flags: number): number => {
      value.setHandleCalls += 1
      if (value.failSetHandleCalls.has(value.setHandleCalls)) return 0
      ;(flags === 0 ? value.restored : value.inherited).push(handle)
      return 1
    },
    getStdHandle: (): bigint | null | undefined => value.stdHandle,
    createProcessW: (...args: unknown[]): number => {
      if (value.createProcessResult === 0) return 0
      if (value.processInformation !== undefined) encode(args[9] as object, 'process-information', value.processInformation)
      return 1
    },
    initializeProcThreadAttributeList: (list: object | null, _count: number, _flags: number, sizeSlot: object): number => {
      if (list === null) {
        encode(sizeSlot, 'size_t', value.attributeSize)
        value.lastError = value.probeError
        return value.probeResult
      }
      return value.initializeResult
    },
    updateProcThreadAttribute: (): number => value.updateResult,
    deleteProcThreadAttributeList: (): undefined => { value.deleteAttributes += 1; return undefined },
    createJobObjectW: (): bigint | null | undefined => value.jobHandle,
    setInformationJobObject: (): number => value.setJobResult,
    assignProcessToJobObject: (): number => value.assignResult,
    resumeThread: (): number => value.resumeResult,
    terminateProcess: (handle: bigint): number => {
      value.terminatedProcesses.push(handle)
      return value.terminateProcessResult
    },
    terminateJobObject: (): number => value.terminateJobResult,
    queryInformationJobObject: (_handle: bigint, _class: number, information: Buffer): number => {
      if (value.queryResult === 0) return 0
      information.writeUInt32LE(value.activeCounts.shift() ?? value.activeDefault, 40)
      return 1
    },
    waitForSingleObject,
    getExitCodeProcess: (_handle: bigint, code: Buffer): number => {
      if (value.exitResult !== 0) code.writeUInt32LE(value.exitCode)
      return value.exitResult
    },
    peekNamedPipe: (): number => 0,
    readFile,
    writeFile,
    closeHandle: (handle: bigint): number => { value.closed.push(handle); return 1 },
    getLastError: (): number => value.lastError,
    allocate,
    encode,
    decode,
    pointerArray: (length: number): string => `pointer-array:${String(length)}`,
  }
}

function transport(value = state()): KoffiWindowsJobTransport {
  return new KoffiWindowsJobTransport(fakeBindings(value) as never, {
    activeProcessPollMs: 1,
    pipeReadBytes: 4,
  })
}

function spawnSpec(
  stdio: GuardianNativeSpawnSpec['stdio'] = { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
): GuardianNativeSpawnSpec {
  return {
    argv: ['C:\\Program Files\\Node\\node.exe', '-e', 'process.exit(0)'],
    cwd: 'C:\\workspace',
    env: { PATH: 'C:\\Windows\\System32' },
    stdio,
    graceMs: 100,
  }
}

async function write(stream: Writable | undefined, data: string): Promise<void> {
  if (stream === undefined) throw new Error('test fixture omitted writable stream')
  await new Promise<void>((resolve, reject) => {
    stream.once('error', () => undefined)
    stream.write(Buffer.from(data), (error) => {
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
  })
}

async function collect(stream: Readable | undefined): Promise<string> {
  if (stream === undefined) throw new Error('test fixture omitted readable stream')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString()
}

function readPlan(overrides: Partial<ReadPlan> = {}): ReadPlan {
  return { result: 0, count: 0, data: '', errorCode: 109, asyncError: undefined, ...overrides }
}

function writePlan(overrides: Partial<WritePlan> = {}): WritePlan {
  return { result: 1, count: 1, errorCode: 0, asyncError: undefined, ...overrides }
}

describe('Windows Koffi native lifecycle failures', () => {
  it('validates every numeric transport option', () => {
    expect(() => new KoffiWindowsJobTransport({} as never, { activeProcessPollMs: Number.NaN, pipeReadBytes: 1 }))
      .toThrow('activeProcessPollMs')
    expect(() => new KoffiWindowsJobTransport({} as never, { activeProcessPollMs: 1, pipeReadBytes: 1.5 }))
      .toThrow('pipeReadBytes')
  })

  it.each([null, undefined, 0n, -1n, 0xFFFFFFFFFFFFFFFFn])(
    'rejects the Win32 null Job sentinel %s',
    async (handle) => {
      const value = state()
      value.jobHandle = handle
      await expect(transport(value).createKillOnCloseJob(new AbortController().signal)).rejects.toThrow('CreateJobObjectW')
    },
  )

  it('closes a Job when configuring it fails or cancellation wins creation', async () => {
    const configuration = state()
    configuration.setJobResult = 0
    await expect(transport(configuration).createKillOnCloseJob(new AbortController().signal))
      .rejects.toThrow('SetInformationJobObject')
    expect(configuration.closed).toContain(200n)

    const cancellation = state()
    const controller = new AbortController()
    controller.abort(new Error('cancelled after native creation'))
    await expect(transport(cancellation).createKillOnCloseJob(controller.signal)).rejects.toThrow('cancelled after native creation')
    expect(cancellation.closed).toContain(200n)
  })

  it('assigns, resumes, closes, and rejects stale native ownership records', async () => {
    const value = state()
    const subject = transport(value)
    const job = await subject.createKillOnCloseJob(new AbortController().signal)
    const child = await subject.createSuspendedProcess(spawnSpec(), new AbortController().signal)
    await subject.assignProcess(job, child)
    await subject.resumeProcess(child)
    await expect(subject.resumeProcess(child)).rejects.toThrow('already resumed')
    await subject.closeProcess(child)
    await expect(subject.closeProcess(child)).rejects.toThrow('unknown or closed')
    await subject.closeJob(job)
    await expect(subject.closeJob(job)).rejects.toThrow('unknown or closed')
    await expect(subject.assignProcess({ id: 'missing' }, child)).rejects.toThrow('unknown or closed Windows Job')
  })

  it('reports assignment and resume failures from Win32', async () => {
    const assignment = state()
    assignment.assignResult = 0
    const assignmentTransport = transport(assignment)
    const assignmentJob = await assignmentTransport.createKillOnCloseJob(new AbortController().signal)
    const assignmentChild = await assignmentTransport.createSuspendedProcess(spawnSpec(), new AbortController().signal)
    await expect(assignmentTransport.assignProcess(assignmentJob, assignmentChild)).rejects.toThrow('AssignProcessToJobObject')
    await assignmentTransport.closeProcess(assignmentChild)
    await assignmentTransport.closeJob(assignmentJob)

    const resume = state()
    resume.resumeResult = 0xFFFFFFFF
    const resumeTransport = transport(resume)
    const resumeChild = await resumeTransport.createSuspendedProcess(spawnSpec(), new AbortController().signal)
    await expect(resumeTransport.resumeProcess(resumeChild)).rejects.toThrow('ResumeThread')
    await resumeTransport.closeProcess(resumeChild)
  })
})

describe('Windows Koffi process creation defenses', () => {
  it.each([
    { ...spawnSpec(), argv: [] },
    { ...spawnSpec(), argv: ['bad\0command'] },
    { ...spawnSpec(), cwd: 'bad\0directory' },
  ])('rejects invalid spawn strings before allocating native resources', async (spec) => {
    await expect(transport().createSuspendedProcess(spec, new AbortController().signal)).rejects.toThrow('invalid Windows spawn strings')
  })

  it.each([
    { '': 'value' },
    { 'BAD=KEY': 'value' },
    { 'BAD\0KEY': 'value' },
    { GOOD: 'bad\0value' },
  ])('rejects invalid Windows environment entries', async (env) => {
    await expect(transport().createSuspendedProcess({ ...spawnSpec(), env }, new AbortController().signal))
      .rejects.toThrow('invalid Windows environment entry')
  })

  it('creates ignore/inherit stdio without exposing parent streams', async () => {
    const value = state()
    const subject = transport(value)
    const child = await subject.createSuspendedProcess(spawnSpec({
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    }), new AbortController().signal)
    expect(child).toMatchObject({ stdin: undefined, stdout: undefined, stderr: undefined })
    await expect(child.done).resolves.toEqual({ exitCode: 7, signal: null })
    await subject.closeProcess(child)
  })

  it('builds a single-argument command line and sorts a multi-entry environment', async () => {
    const subject = transport()
    const child = await subject.createSuspendedProcess({
      ...spawnSpec({ stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }),
      argv: ['C:\\node.exe'],
      env: { zebra: 'last', Alpha: 'first' },
    }, new AbortController().signal)
    await subject.closeProcess(child)
  })

  it('does not double-close an aliased pipe handle returned by Win32', async () => {
    const value = state()
    value.pipeAliasesHandles = true
    const subject = transport(value)
    const child = await subject.createSuspendedProcess(spawnSpec({
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    }), new AbortController().signal)
    await subject.closeProcess(child)
    expect(new Set(value.closed).size).toBe(value.closed.length)
  })

  it('streams full and empty reads, broken-pipe EOF, and complete writes', async () => {
    const value = state()
    value.readPlans.push(
      readPlan({ result: 1, count: 3, data: 'abc' }),
      readPlan({ result: 1, count: 0 }),
      readPlan(),
    )
    value.writePlans.push(writePlan({ count: 3 }))
    const subject = transport(value)
    const child = await subject.createSuspendedProcess(spawnSpec({
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    }), new AbortController().signal)
    await write(child.stdin, 'xyz')
    expect(await collect(child.stdout)).toBe('abc')
    await subject.closeProcess(child)
    expect(value.closed.length).toBeGreaterThan(0)
  })

  it.each([
    { plan: writePlan({ result: 0, count: 0, errorCode: 5 }), message: 'WriteFile failed' },
    { plan: writePlan({ count: 0 }), message: 'completed partially' },
    { plan: writePlan({ asyncError: 'native callback failed' }), message: 'native callback failed' },
  ])('surfaces writable-pipe failure: $message', async ({ plan, message }) => {
    const value = state()
    value.writePlans.push(plan)
    const subject = transport(value)
    const child = await subject.createSuspendedProcess(spawnSpec({
      stdin: 'pipe',
      stdout: 'inherit',
      stderr: 'inherit',
    }), new AbortController().signal)
    await expect(write(child.stdin, 'x')).rejects.toThrow(message)
    await subject.closeProcess(child)
  })

  it.each([
    { plan: readPlan({ result: 0, errorCode: 5 }), message: 'ReadFile failed' },
    { plan: readPlan({ asyncError: new Error('read callback failed') }), message: 'read callback failed' },
  ])('surfaces readable-pipe failure: $message', async ({ plan, message }) => {
    const value = state()
    value.readPlans.push(plan)
    const subject = transport(value)
    const child = await subject.createSuspendedProcess(spawnSpec({
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    }), new AbortController().signal)
    await expect(collect(child.stdout)).rejects.toThrow(message)
    await subject.closeProcess(child)
  })

  it('rejects pipe, standard-handle, and inheritance setup failures with cleanup', async () => {
    const pipe = state()
    pipe.createPipeResult = 0
    await expect(transport(pipe).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow('CreatePipe')

    const nullPipe = state()
    nullPipe.pipeReturnsNull = true
    await expect(transport(nullPipe).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow('null handle')

    const standard = state()
    standard.stdHandle = null
    await expect(transport(standard).createSuspendedProcess(spawnSpec({
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    }), new AbortController().signal)).rejects.toThrow('GetStdHandle')

    const inheritance = state()
    inheritance.failSetHandleCalls.add(1)
    await expect(transport(inheritance).createSuspendedProcess(spawnSpec(), new AbortController().signal))
      .rejects.toThrow('SetHandleInformation')
    expect(inheritance.closed.length).toBeGreaterThan(0)
  })

  it.each([
    { mutate: (value: BindingState): void => { value.probeResult = 1 }, message: 'InitializeProcThreadAttributeList(size)' },
    { mutate: (value: BindingState): void => { value.probeError = 5 }, message: 'InitializeProcThreadAttributeList(size)' },
    { mutate: (value: BindingState): void => { value.attributeSize = -1 }, message: 'invalid attribute list size' },
    { mutate: (value: BindingState): void => { value.attributeSize = 0 }, message: 'invalid process attribute-list size' },
    { mutate: (value: BindingState): void => { value.attributeSize = 1024 * 1024 + 1 }, message: 'invalid process attribute-list size' },
    { mutate: (value: BindingState): void => { value.initializeResult = 0 }, message: 'InitializeProcThreadAttributeList failed' },
    { mutate: (value: BindingState): void => { value.updateResult = 0 }, message: 'UpdateProcThreadAttribute failed' },
  ])('rejects invalid process attribute setup: $message', async ({ mutate, message }) => {
    const value = state()
    mutate(value)
    await expect(transport(value).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow(message)
  })

  it('accepts an integral native bigint attribute-list size', async () => {
    const value = state()
    value.attributeSize = 64n
    const subject = transport(value)
    const child = await subject.createSuspendedProcess(spawnSpec(), new AbortController().signal)
    await subject.closeProcess(child)
  })

  it('rejects a command that changes to contain NUL after initial spawn validation', async () => {
    const argv = ['C:\\node.exe']
    argv.some = () => false
    argv[0] = 'C:\\bad\0node.exe'
    await expect(transport().createSuspendedProcess({ ...spawnSpec(), argv }, new AbortController().signal))
      .rejects.toThrow('Windows string contains NUL')
  })

  it('makes startup-list release idempotent and rejects an empty handle whitelist', () => {
    interface StartupInternals {
      allocateStartupInfo(
        stdin: bigint,
        stdout: bigint,
        stderr: bigint,
        inherited: ReadonlySet<bigint>,
      ): { readonly release: () => void }
    }
    const value = state()
    const internals = transport(value) as unknown as StartupInternals
    const startup = internals.allocateStartupInfo(1n, 2n, 3n, new Set([1n, 2n, 3n]))
    startup.release()
    startup.release()
    expect(value.deleteAttributes).toBe(1)
    expect(() => internals.allocateStartupInfo(1n, 2n, 3n, new Set())).toThrow('whitelist is empty')
  })

  it('rejects CreateProcess failures, malformed process records, and restore failures', async () => {
    const create = state()
    create.createProcessResult = 0
    await expect(transport(create).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow('CreateProcessW')

    const missing = state()
    missing.processInformation = undefined
    await expect(transport(missing).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow()

    const nullHandles = state()
    nullHandles.processInformation = { hProcess: null, hThread: null, dwProcessId: 1, dwThreadId: 2 }
    await expect(transport(nullHandles).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow('invalid process information')

    const badPid = state()
    badPid.processInformation = { hProcess: 100n, hThread: 101n, dwProcessId: 0, dwThreadId: 2 }
    await expect(transport(badPid).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow('invalid process information')
    expect(badPid.terminatedProcesses).toContain(100n)

    const cleanupWait = state()
    cleanupWait.processInformation = { hProcess: 100n, hThread: 101n, dwProcessId: 0, dwThreadId: 2 }
    cleanupWait.waitResults.push(0xFFFFFFFF)
    await expect(transport(cleanupWait).createSuspendedProcess(spawnSpec(), new AbortController().signal))
      .rejects.toThrow('invalid process information')

    const restore = state()
    restore.failSetHandleCalls.add(4)
    await expect(transport(restore).createSuspendedProcess(spawnSpec(), new AbortController().signal)).rejects.toThrow('SetHandleInformation')
    expect(restore.terminatedProcesses).toContain(100n)
  })
})

describe('Windows Koffi termination and disposal', () => {
  async function owned(value = state()): Promise<{
    readonly subject: KoffiWindowsJobTransport
    readonly job: WindowsNativeJob
    readonly child: WindowsSuspendedProcess
  }> {
    const subject = transport(value)
    const job = await subject.createKillOnCloseJob(new AbortController().signal)
    const child = await subject.createSuspendedProcess(spawnSpec({
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    }), new AbortController().signal)
    return { subject, job, child }
  }

  it('terminates a child and tolerates an already-exited TerminateProcess race', async () => {
    const normal = state()
    const normalOwned = await owned(normal)
    await normalOwned.subject.terminateProcess(normalOwned.child)

    const exited = state()
    exited.terminateProcessResult = 0
    const exitedOwned = await owned(exited)
    exited.waitResults.push(0, 0)
    await exitedOwned.subject.terminateProcess(exitedOwned.child)
  })

  it('reports TerminateProcess, wait, and outcome-query failures', async () => {
    const termination = state()
    termination.terminateProcessResult = 0
    const terminationOwned = await owned(termination)
    termination.waitResults.push(258)
    await expect(terminationOwned.subject.terminateProcess(terminationOwned.child)).rejects.toThrow('TerminateProcess')

    const wait = state()
    const waitOwned = await owned(wait)
    wait.waitResults.push(0xFFFFFFFF)
    await expect(waitOwned.subject.terminateProcess(waitOwned.child)).rejects.toThrow('WaitForSingleObject failed')

    const outcome = state()
    outcome.exitResult = 0
    const outcomeOwned = await owned(outcome)
    await expect(outcomeOwned.child.done).rejects.toThrow('GetExitCodeProcess')
  })

  it('handles empty, active, failed, and unexpectedly queried Jobs', async () => {
    const empty = state()
    const emptyOwned = await owned(empty)
    await emptyOwned.subject.terminateJob(emptyOwned.job)

    const active = state()
    active.activeDefault = 1
    const activeOwned = await owned(active)
    await activeOwned.subject.terminateJob(activeOwned.job)

    const failed = state()
    failed.activeDefault = 1
    failed.terminateJobResult = 0
    const failedOwned = await owned(failed)
    await expect(failedOwned.subject.terminateJob(failedOwned.job)).rejects.toThrow('TerminateJobObject')

    const query = state()
    query.queryResult = 0
    const queryOwned = await owned(query)
    await expect(queryOwned.subject.terminateJob(queryOwned.job)).rejects.toThrow('QueryInformationJobObject')
  })

  it('polls active-process zero and returns false for preexisting or later cancellation', async () => {
    vi.useFakeTimers()
    const value = state()
    value.activeCounts.push(1, 0)
    const fixture = await owned(value)
    const waiting = fixture.subject.waitForActiveProcessZero(fixture.job)
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toBe(true)

    const preCancelled = state()
    preCancelled.activeDefault = 1
    const preFixture = await owned(preCancelled)
    const controller = new AbortController()
    controller.abort()
    await expect(preFixture.subject.waitForActiveProcessZero(preFixture.job, controller.signal)).resolves.toBe(false)

    const later = state()
    later.activeDefault = 1
    const laterFixture = await owned(later)
    const laterController = new AbortController()
    const laterWait = laterFixture.subject.waitForActiveProcessZero(laterFixture.job, laterController.signal)
    laterController.abort()
    await expect(laterWait).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('disposes retained ownership once and aggregates native cleanup failures', async () => {
    const success = await owned()
    await success.subject.dispose()
    await success.subject.dispose()
    await expect(success.subject.createKillOnCloseJob(new AbortController().signal)).rejects.toThrow('disposing')

    const failed = state()
    failed.queryResult = 0
    const failedOwned = await owned(failed)
    await expect(failedOwned.subject.dispose()).rejects.toThrow(AggregateError)
  })

  it('rejects unexpected wait status and native async callback failure during cleanup', async () => {
    const unexpected = state()
    const unexpectedOwned = await owned(unexpected)
    unexpected.waitResults.push(7)
    await expect(unexpectedOwned.subject.terminateProcess(unexpectedOwned.child)).rejects.toThrow('unexpected WaitForSingleObject result 7')

    const callback = state()
    const callbackOwned = await owned(callback)
    callback.waitAsyncError = new Error('wait callback failed')
    await expect(callbackOwned.subject.terminateProcess(callbackOwned.child)).rejects.toThrow('wait callback failed')
  })
})

const koffiState = vi.hoisted(() => ({ invalidAbi: false, values: new Map<object, unknown>() }))

vi.mock('koffi', () => {
  const pointer = (): { readonly size: number } => ({ size: 8 })
  return {
    load: () => ({ func: () => native(() => 1) }),
    pointer,
    struct: (name: string): { readonly size: number; readonly name: string } => ({
      name,
      size: koffiState.invalidAbi
        ? 1
        : name.includes('STARTUPINFOEX')
          ? 112
          : name.includes('STARTUPINFO')
            ? 104
            : 24,
    }),
    array: (_type: unknown, length: number) => ({ length }),
    alloc: (type: unknown, length: number) => ({ type, length }),
    encode: (target: object, _type: unknown, value: unknown): void => { koffiState.values.set(target, value) },
    decode: (target: object): unknown => koffiState.values.get(target),
  }
})

describe('Windows Koffi lazy binding adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    koffiState.invalidAbi = false
    koffiState.values.clear()
  })

  it('rejects x64-incompatible Windows architecture before loading Koffi', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    await expect(createKoffiWindowsJobTransport({ activeProcessPollMs: 1, pipeReadBytes: 1 }))
      .rejects.toThrow('win32-arm64')
  })

  it('loads x64 bindings and forwards allocation, encoding, decoding, and pointer arrays', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    const subject = await createKoffiWindowsJobTransport({ activeProcessPollMs: 1, pipeReadBytes: 1 })
    interface BindingInternals {
      api: {
        allocate(type: unknown, length?: number): object
        encode(target: object, type: unknown, value: unknown): void
        decode(target: object, type: unknown): unknown
        pointerArray(length: number): unknown
      }
    }
    const api = (subject as unknown as BindingInternals).api
    const slot = api.allocate('uint8', 2)
    api.encode(slot, 'uint8', 42)
    expect(api.decode(slot, 'uint8')).toBe(42)
    expect(api.pointerArray(3)).toEqual({ length: 3 })
  })

  it('rejects an unsupported native ABI layout', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    koffiState.invalidAbi = true
    await expect(createKoffiWindowsJobTransport({ activeProcessPollMs: 1, pipeReadBytes: 1 }))
      .rejects.toThrow('unsupported Windows ABI')
  })
})
