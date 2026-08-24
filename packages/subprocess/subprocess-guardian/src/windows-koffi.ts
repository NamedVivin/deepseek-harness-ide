/** Koffi-backed Windows suspended-process and kill-on-close Job Object transport. */

import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import type { KoffiModule } from 'koffi'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type {
  GuardianNativeSpawnSpec,
  WindowsJobNativeTransport,
  WindowsNativeJob,
  WindowsSuspendedProcess,
} from './supervisor.ts'

const CREATE_SUSPENDED = 0x00000004
const CREATE_NO_WINDOW = 0x08000000
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const STARTF_USESTDHANDLES = 0x00000100
const HANDLE_FLAG_INHERIT = 0x00000001
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_EXTENDED_LIMIT_SIZE = 144
const JOB_OBJECT_LIMIT_FLAGS_OFFSET = 16
const JOB_OBJECT_ACTIVE_PROCESS_OFFSET = 40
const JOB_OBJECT_BASIC_ACCOUNTING_SIZE = 48
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 258
const WAIT_FAILED = 0xFFFFFFFF
const INFINITE = 0xFFFFFFFF
const ERROR_BROKEN_PIPE = 109
const ERROR_INSUFFICIENT_BUFFER = 122
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
const STARTUPINFO_SIZE = 104
const STARTUPINFOEX_SIZE = 112
const MAX_ATTRIBUTE_LIST_BYTES = 1024 * 1024
const STD_OUTPUT_HANDLE = -11
const STD_ERROR_HANDLE = -12

type NativeHandle = bigint

interface NativeFunction<Arguments extends readonly unknown[], Result> {
  (...args: Arguments): Result
  async(...args: [...Arguments, (error: unknown, result: Result) => void]): void
}

interface ProcessInformation {
  readonly hProcess: NativeHandle | null
  readonly hThread: NativeHandle | null
  readonly dwProcessId: number
  readonly dwThreadId: number
}

interface WindowsBindings {
  readonly types: {
    readonly pointer: unknown
    readonly startupInfo: unknown
    readonly startupInfoEx: unknown
    readonly processInformation: unknown
    readonly sizeT: unknown
    readonly uint8: unknown
    readonly pointerSize: number
  }
  readonly createPipe: NativeFunction<[unknown, unknown, null, number], number>
  readonly setHandleInformation: NativeFunction<[NativeHandle, number, number], number>
  readonly getStdHandle: NativeFunction<[number], NativeHandle | null>
  readonly createProcessW: NativeFunction<[
    string, Buffer, null, null, number, number, Buffer, string, unknown, unknown,
  ], number>
  readonly initializeProcThreadAttributeList: NativeFunction<[unknown, number, number, unknown], number>
  readonly updateProcThreadAttribute: NativeFunction<[
    unknown, number, number, unknown, number, null, null,
  ], number>
  readonly deleteProcThreadAttributeList: NativeFunction<[unknown], undefined>
  readonly createJobObjectW: NativeFunction<[null, null], NativeHandle | null>
  readonly setInformationJobObject: NativeFunction<[NativeHandle, number, Buffer, number], number>
  readonly assignProcessToJobObject: NativeFunction<[NativeHandle, NativeHandle], number>
  readonly resumeThread: NativeFunction<[NativeHandle], number>
  readonly terminateProcess: NativeFunction<[NativeHandle, number], number>
  readonly terminateJobObject: NativeFunction<[NativeHandle, number], number>
  readonly queryInformationJobObject: NativeFunction<[NativeHandle, number, Buffer, number, null], number>
  readonly waitForSingleObject: NativeFunction<[NativeHandle, number], number>
  readonly getExitCodeProcess: NativeFunction<[NativeHandle, Buffer], number>
  readonly peekNamedPipe: NativeFunction<[NativeHandle, null, number, null, Buffer, null], number>
  readonly readFile: NativeFunction<[NativeHandle, Buffer, number, Buffer, null], number>
  readonly writeFile: NativeFunction<[NativeHandle, Buffer, number, Buffer, null], number>
  readonly closeHandle: NativeFunction<[NativeHandle], number>
  readonly getLastError: NativeFunction<[], number>
  readonly allocate: (type: unknown, length?: number) => unknown
  readonly encode: (target: unknown, type: unknown, value: unknown) => void
  readonly decode: (target: unknown, type: unknown) => unknown
  readonly pointerArray: (length: number) => unknown
}

interface PipePair {
  readonly read: NativeHandle
  readonly write: NativeHandle
}

interface KoffiJob extends WindowsNativeJob {
  readonly handle: NativeHandle
  closed: boolean
}

interface KoffiChild extends WindowsSuspendedProcess {
  readonly processHandle: NativeHandle
  readonly threadHandle: NativeHandle
  readonly inputHandle: NativeHandleLease | undefined
  readonly outputHandles: ReadonlySet<NativeHandleLease>
  resumed: boolean
  processClosed: boolean
  threadClosed: boolean
}

/** Configuration for cancellation-aware active-process-zero polling. */
export interface KoffiWindowsJobTransportOptions {
  /** Maximum delay between native Job accounting queries. */
  readonly activeProcessPollMs: number
  /** Buffer size of each asynchronous Win32 pipe read. */
  readonly pipeReadBytes: number
}

/**
 * Real Win32 transport. Every process starts suspended and every Job carries KILL_ON_JOB_CLOSE before assignment.
 * One transport instance belongs exclusively to one guardian process.
 */
export class KoffiWindowsJobTransport implements WindowsJobNativeTransport {
  private readonly jobs = new Map<string, KoffiJob>()
  private readonly children = new Map<string, KoffiChild>()
  private disposing = false

  /** @param api - loaded x64 Win32 bindings. @param options - required polling bound. */
  constructor(
    private readonly api: WindowsBindings,
    private readonly options: KoffiWindowsJobTransportOptions,
  ) {
    if (!Number.isSafeInteger(options.activeProcessPollMs) || options.activeProcessPollMs <= 0) {
      throw new Error('subprocess-guardian: activeProcessPollMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.pipeReadBytes) || options.pipeReadBytes <= 0) {
      throw new Error('subprocess-guardian: pipeReadBytes must be a positive safe integer')
    }
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- async preserves the transport's rejected-Promise method contract.
  async createKillOnCloseJob(signal: AbortSignal): Promise<WindowsNativeJob> {
    this.requireOpen()
    const handle = this.api.createJobObjectW(null, null)
    if (isNullHandle(handle)) this.fail('CreateJobObjectW')
    const information = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_SIZE)
    information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_FLAGS_OFFSET)
    if (this.api.setInformationJobObject(
      handle,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      information,
      information.length,
    ) === 0) {
      const error = this.nativeError('SetInformationJobObject')
      this.api.closeHandle(handle)
      throw error
    }
    try {
      signal.throwIfAborted()
    } catch (error) {
      this.api.closeHandle(handle)
      throw error
    }
    const job: KoffiJob = { id: randomUUID(), handle, closed: false }
    this.jobs.set(job.id, job)
    return job
  }

  /** @inheritdoc */
  async createSuspendedProcess(spec: GuardianNativeSpawnSpec, signal: AbortSignal): Promise<WindowsSuspendedProcess> {
    this.requireOpen()
    signal.throwIfAborted()
    validateSpawnSpec(spec)
    const resources = this.createStdio(spec)
    let processHandle: NativeHandle | undefined
    let threadHandle: NativeHandle | undefined
    let inheritanceRestored = false
    try {
      const startup = this.allocateStartupInfo(
        resources.childStdin,
        resources.childStdout,
        resources.childStderr,
        resources.inheritedHandles,
      )
      const processInformation = this.allocate(this.api.types.processInformation)
      const commandLine = encodeWide(`${quoteWindowsArgument(spec.argv[0] as string)}${spec.argv.length === 1
        ? ''
        : ` ${spec.argv.slice(1).map(quoteWindowsArgument).join(' ')}`}`)
      const environment = encodeEnvironment(spec.env)
      let created: number
      let createError: number | undefined
      let restoreError: Error | undefined
      let info: ProcessInformation | undefined
      try {
        created = this.api.createProcessW(
          spec.argv[0] as string,
          commandLine,
          null,
          null,
          1,
          CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
          environment,
          spec.cwd,
          startup.value,
          processInformation,
        )
        createError = created === 0 ? this.api.getLastError() : undefined
        if (created !== 0) {
          info = this.apiDecode(processInformation, this.api.types.processInformation) as ProcessInformation
          if (!isNullHandle(info.hProcess)) processHandle = info.hProcess
          if (!isNullHandle(info.hThread)) threadHandle = info.hThread
        }
      } finally {
        try {
          startup.release()
        } finally {
          restoreError = this.restoreInheritedHandles(resources.inheritedHandles)
          inheritanceRestored = true
        }
      }
      if (createError !== undefined) throw nativeError('CreateProcessW', createError)
      if (info === undefined || processHandle === undefined || threadHandle === undefined) {
        throw new Error('subprocess-guardian: CreateProcessW returned invalid process information')
      }
      if (!Number.isSafeInteger(info.dwProcessId) || info.dwProcessId <= 0) {
        throw new Error('subprocess-guardian: CreateProcessW returned invalid process information')
      }
      if (restoreError !== undefined) throw restoreError
      resources.closeChildEnds()
      const inputHandle = resources.parentStdin === undefined
        ? undefined
        : new NativeHandleLease(this.api, resources.parentStdin)
      const stdoutHandle = resources.parentStdout === undefined
        ? undefined
        : new NativeHandleLease(this.api, resources.parentStdout)
      const stderrHandle = resources.parentStderr === undefined
        ? undefined
        : new NativeHandleLease(this.api, resources.parentStderr)
      const outputHandles = new Set([stdoutHandle, stderrHandle].filter(isLease))
      const stdin = inputHandle === undefined ? undefined : writablePipe(this.api, inputHandle)
      const stdout = stdoutHandle === undefined ? undefined : readablePipe(this.api, stdoutHandle, this.options.pipeReadBytes)
      const stderr = stderrHandle === undefined ? undefined : readablePipe(this.api, stderrHandle, this.options.pipeReadBytes)
      const done = waitForProcess(this.api, processHandle)
      void done.catch(() => undefined)
      const child: KoffiChild = {
        id: randomUUID(),
        pid: info.dwProcessId,
        stdin,
        stdout,
        stderr,
        done,
        processHandle,
        threadHandle,
        inputHandle,
        outputHandles,
        resumed: false,
        processClosed: false,
        threadClosed: false,
      }
      this.children.set(child.id, child)
      return child
    } catch (error) {
      if (!inheritanceRestored) this.restoreInheritedHandles(resources.inheritedHandles)
      resources.closeAll()
      if (processHandle !== undefined) {
        this.api.terminateProcess(processHandle, 1)
        await waitHandle(this.api.waitForSingleObject, processHandle, INFINITE).catch(() => undefined)
        this.api.closeHandle(processHandle)
      }
      if (threadHandle !== undefined) this.api.closeHandle(threadHandle)
      throw error
    }
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- async preserves the transport's rejected-Promise method contract.
  async assignProcess(job: WindowsNativeJob, child: WindowsSuspendedProcess): Promise<void> {
    const nativeJob = this.requireJob(job)
    const nativeChild = this.requireChild(child)
    if (this.api.assignProcessToJobObject(nativeJob.handle, nativeChild.processHandle) === 0) {
      this.fail('AssignProcessToJobObject')
    }
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- async preserves the transport's rejected-Promise method contract.
  async resumeProcess(child: WindowsSuspendedProcess): Promise<void> {
    const native = this.requireChild(child)
    if (native.resumed) throw new Error('subprocess-guardian: Windows child was already resumed')
    if (this.api.resumeThread(native.threadHandle) === WAIT_FAILED) this.fail('ResumeThread')
    native.resumed = true
    this.closeThread(native)
  }

  /** @inheritdoc */
  async terminateProcess(child: WindowsSuspendedProcess): Promise<void> {
    const native = this.requireChild(child)
    if (this.api.terminateProcess(native.processHandle, 1) === 0) {
      const code = this.api.getLastError()
      if (!await hasExited(this.api, native.processHandle)) throw nativeError('TerminateProcess', code)
    }
    await waitHandle(this.api.waitForSingleObject, native.processHandle, INFINITE)
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- async preserves the transport's rejected-Promise method contract.
  async terminateJob(job: WindowsNativeJob): Promise<void> {
    const native = this.requireJob(job)
    if (this.activeProcessCount(native) === 0) return
    if (this.api.terminateJobObject(native.handle, 1) === 0) this.fail('TerminateJobObject')
  }

  /** @inheritdoc */
  async waitForActiveProcessZero(job: WindowsNativeJob, signal?: AbortSignal): Promise<boolean> {
    const native = this.requireJob(job)
    while (this.activeProcessCount(native) !== 0) {
      await abortableDelay(this.options.activeProcessPollMs, signal)
      if (signal?.aborted === true) return false
    }
    return true
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- async preserves the transport's rejected-Promise method contract.
  async closeProcess(child: WindowsSuspendedProcess): Promise<void> {
    const native = this.requireChild(child)
    this.closeThread(native)
    native.stdin?.destroy()
    native.stdout?.destroy()
    native.stderr?.destroy()
    for (const handle of native.outputHandles) handle.close()
    native.inputHandle?.close()
    if (!native.processClosed) {
      native.processClosed = true
      this.api.closeHandle(native.processHandle)
    }
    this.children.delete(native.id)
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- async preserves the transport's rejected-Promise method contract.
  async closeJob(job: WindowsNativeJob): Promise<void> {
    const native = this.requireJob(job)
    if (!native.closed) {
      native.closed = true
      this.api.closeHandle(native.handle)
    }
    this.jobs.delete(native.id)
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    const jobs = [...this.jobs.values()]
    const children = [...this.children.values()]
    const cleanup = [
      ...await Promise.allSettled(children.map(child => this.terminateProcess(child))),
      ...await Promise.allSettled(jobs.map(job => this.terminateJob(job))),
      ...await Promise.allSettled(jobs.map(job => this.waitForActiveProcessZero(job))),
      ...await Promise.allSettled(children.map(child => this.closeProcess(child))),
      ...await Promise.allSettled(jobs.map(job => this.closeJob(job))),
    ]
    const failures: unknown[] = []
    for (const result of cleanup) {
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'subprocess-guardian: Windows transport cleanup failed')
  }

  private createStdio(spec: GuardianNativeSpawnSpec): StdioResources {
    const resources = new StdioResources(this.api)
    try {
      if (spec.stdio.stdin === 'ignore') {
        const pair = resources.pipe()
        resources.childStdin = pair.read
        resources.inherit(pair.read)
        resources.closeAfterCreate(pair.read)
        resources.closeNow(pair.write)
      } else {
        const pair = resources.pipe()
        resources.childStdin = pair.read
        resources.parentStdin = pair.write
        resources.inherit(pair.read)
        resources.closeAfterCreate(pair.read)
      }
      if (spec.stdio.stdout === 'inherit') {
        resources.childStdout = resources.stdHandle(STD_OUTPUT_HANDLE)
        resources.inherit(resources.childStdout)
      } else {
        const pair = resources.pipe()
        resources.parentStdout = pair.read
        resources.childStdout = pair.write
        resources.inherit(pair.write)
        resources.closeAfterCreate(pair.write)
      }
      if (spec.stdio.stderr === 'inherit') {
        resources.childStderr = resources.stdHandle(STD_ERROR_HANDLE)
        resources.inherit(resources.childStderr)
      } else {
        const pair = resources.pipe()
        resources.parentStderr = pair.read
        resources.childStderr = pair.write
        resources.inherit(pair.write)
        resources.closeAfterCreate(pair.write)
      }
      return resources
    } catch (error) {
      resources.closeAll()
      throw error
    }
  }

  private allocate(type: unknown, length = 1): unknown {
    return this.api.allocate(type, length)
  }

  private allocateStartupInfo(
    stdin: NativeHandle,
    stdout: NativeHandle,
    stderr: NativeHandle,
    inheritedHandles: ReadonlySet<NativeHandle>,
  ): { readonly value: unknown; readonly release: () => void } {
    const sizeSlot = this.allocate(this.api.types.sizeT)
    this.api.encode(sizeSlot, this.api.types.sizeT, 0)
    const probed = this.api.initializeProcThreadAttributeList(null, 1, 0, sizeSlot)
    const probeError = probed === 0 ? this.api.getLastError() : 0
    if (probed !== 0 || probeError !== ERROR_INSUFFICIENT_BUFFER) {
      throw nativeError('InitializeProcThreadAttributeList(size)', probeError)
    }
    const bytes = safeNativeSize(this.api.decode(sizeSlot, this.api.types.sizeT), 'attribute list')
    if (bytes === 0 || bytes > MAX_ATTRIBUTE_LIST_BYTES) {
      throw new Error('subprocess-guardian: invalid process attribute-list size')
    }
    const attributeList = this.allocate(this.api.types.uint8, bytes)
    if (this.api.initializeProcThreadAttributeList(attributeList, 1, 0, sizeSlot) === 0) {
      this.fail('InitializeProcThreadAttributeList')
    }
    let initialized = true
    try {
      const handles = [...inheritedHandles]
      if (handles.length === 0) throw new Error('subprocess-guardian: target handle whitelist is empty')
      const handleArrayType = this.api.pointerArray(handles.length)
      const handleArray = this.allocate(handleArrayType)
      this.api.encode(handleArray, handleArrayType, handles)
      if (this.api.updateProcThreadAttribute(
        attributeList,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handleArray,
        handles.length * this.api.types.pointerSize,
        null,
        null,
      ) === 0) this.fail('UpdateProcThreadAttribute')
      const startupInfo = this.allocate(this.api.types.startupInfoEx)
      this.api.encode(startupInfo, this.api.types.startupInfoEx, {
        StartupInfo: {
          cb: STARTUPINFOEX_SIZE,
          dwFlags: STARTF_USESTDHANDLES,
          hStdInput: stdin,
          hStdOutput: stdout,
          hStdError: stderr,
        },
        lpAttributeList: attributeList,
      })
      return {
        value: startupInfo,
        release: () => {
          if (!initialized) return
          initialized = false
          this.api.deleteProcThreadAttributeList(attributeList)
          void handleArray
        },
      }
    } catch (error) {
      this.api.deleteProcThreadAttributeList(attributeList)
      throw error
    }
  }

  private apiDecode(pointer: unknown, type: unknown): unknown {
    return this.api.decode(pointer, type)
  }

  private restoreInheritedHandles(handles: ReadonlySet<NativeHandle>): Error | undefined {
    let failure: Error | undefined
    for (const handle of handles) {
      if (this.api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) === 0 && failure === undefined) {
        failure = this.nativeError('SetHandleInformation')
      }
    }
    return failure
  }

  private activeProcessCount(job: KoffiJob): number {
    const information = Buffer.alloc(JOB_OBJECT_BASIC_ACCOUNTING_SIZE)
    if (this.api.queryInformationJobObject(
      job.handle,
      JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
      information,
      information.length,
      null,
    ) === 0) this.fail('QueryInformationJobObject')
    return information.readUInt32LE(JOB_OBJECT_ACTIVE_PROCESS_OFFSET)
  }

  private closeThread(child: KoffiChild): void {
    if (child.threadClosed) return
    child.threadClosed = true
    this.api.closeHandle(child.threadHandle)
  }

  private requireOpen(): void {
    if (this.disposing) throw new Error('subprocess-guardian: Windows transport is disposing')
  }

  private requireJob(value: WindowsNativeJob): KoffiJob {
    const job = this.jobs.get(value.id)
    if (job === undefined || job.closed) throw new Error('subprocess-guardian: unknown or closed Windows Job')
    return job
  }

  private requireChild(value: WindowsSuspendedProcess): KoffiChild {
    const child = this.children.get(value.id)
    if (child === undefined || child.processClosed) throw new Error('subprocess-guardian: unknown or closed Windows child')
    return child
  }

  private fail(name: string): never { throw this.nativeError(name) }
  private nativeError(name: string): Error { return nativeError(name, this.api.getLastError()) }
}

/**
 * Load Koffi lazily in the packaged Windows guardian.
 * @param options - required active-process polling bound.
 * @returns real Win32 transport.
 */
export async function createKoffiWindowsJobTransport(
  options: KoffiWindowsJobTransportOptions,
): Promise<KoffiWindowsJobTransport> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`subprocess-guardian: Windows Job transport requires win32-x64, got ${process.platform}-${process.arch}`)
  }
  const module = await import('koffi') as unknown as KoffiModule
  return new KoffiWindowsJobTransport(loadBindings(module), options)
}

/**
 * Quote one argument according to CommandLineToArgvW/CRT parsing rules.
 * @param argument - one exact argv entry.
 * @returns command-line representation parsed back to the same entry.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length === 0) return '""'
  if (!/[\s"]/u.test(argument)) return argument
  let result = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') result += '\\'.repeat(backslashes * 2 + 1) + '"'
    else result += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return result + '\\'.repeat(backslashes * 2) + '"'
}

class StdioResources {
  childStdin!: NativeHandle
  childStdout!: NativeHandle
  childStderr!: NativeHandle
  parentStdin: NativeHandle | undefined
  parentStdout: NativeHandle | undefined
  parentStderr: NativeHandle | undefined
  readonly inheritedHandles = new Set<NativeHandle>()
  private readonly handles = new Set<NativeHandle>()
  private readonly childEnds = new Set<NativeHandle>()

  constructor(private readonly api: WindowsBindings) {}

  pipe(): PipePair {
    const readSlot = this.allocatePointer()
    const writeSlot = this.allocatePointer()
    if (this.api.createPipe(readSlot, writeSlot, null, 0) === 0) this.fail('CreatePipe')
    const read = this.decodePointer(readSlot)
    const write = this.decodePointer(writeSlot)
    if (isNullHandle(read) || isNullHandle(write)) throw new Error('subprocess-guardian: CreatePipe returned a null handle')
    this.handles.add(read)
    this.handles.add(write)
    return { read, write }
  }

  stdHandle(selector: number): NativeHandle {
    const handle = this.api.getStdHandle(selector)
    if (isNullHandle(handle)) this.fail('GetStdHandle')
    return handle
  }

  inherit(handle: NativeHandle): void {
    if (this.api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) === 0) {
      this.fail('SetHandleInformation')
    }
    this.inheritedHandles.add(handle)
  }

  closeAfterCreate(handle: NativeHandle): void { this.childEnds.add(handle) }

  closeNow(handle: NativeHandle): void {
    if (!this.handles.delete(handle)) return
    this.api.closeHandle(handle)
  }

  closeChildEnds(): void {
    for (const handle of this.childEnds) this.closeNow(handle)
    this.childEnds.clear()
  }

  closeAll(): void {
    for (const handle of this.handles) this.api.closeHandle(handle)
    this.handles.clear()
    this.childEnds.clear()
  }

  private allocatePointer(): unknown {
    return this.api.allocate(this.api.types.pointer)
  }

  private decodePointer(pointer: unknown): NativeHandle | null {
    return this.api.decode(pointer, this.api.types.pointer) as NativeHandle | null
  }

  private fail(name: string): never { throw nativeError(name, this.api.getLastError()) }
}

function loadBindings(koffi: KoffiModule): WindowsBindings {
  const kernel32 = koffi.load('kernel32.dll')
  const pointer = koffi.pointer('void')
  const pointerPointer = koffi.pointer(pointer)
  // Each optional Windows backend loads and verifies its own koffi ABI table without importing another provider.
  /* jscpd:ignore-start */
  const startupInfo = koffi.struct('DSH_GUARDIAN_STARTUPINFOW', {
    cb: 'uint32',
    lpReserved: 'str16',
    lpDesktop: 'str16',
    lpTitle: 'str16',
    dwX: 'uint32',
    dwY: 'uint32',
    dwXSize: 'uint32',
    dwYSize: 'uint32',
    dwXCountChars: 'uint32',
    dwYCountChars: 'uint32',
    dwFillAttribute: 'uint32',
    dwFlags: 'uint32',
    wShowWindow: 'uint16',
    cbReserved2: 'uint16',
    lpReserved2: koffi.pointer('uint8'),
    hStdInput: pointer,
    hStdOutput: pointer,
    hStdError: pointer,
  })
  /* jscpd:ignore-end */
  const processInformation = koffi.struct('DSH_GUARDIAN_PROCESS_INFORMATION', {
    hProcess: pointer,
    hThread: pointer,
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  })
  const startupInfoEx = koffi.struct('DSH_GUARDIAN_STARTUPINFOEXW', {
    StartupInfo: startupInfo,
    lpAttributeList: pointer,
  })
  if (startupInfo.size !== STARTUPINFO_SIZE || startupInfoEx.size !== STARTUPINFOEX_SIZE || processInformation.size !== 24) {
    throw new Error('subprocess-guardian: unsupported Windows ABI structure layout')
  }
  const bind = <Arguments extends readonly unknown[], Result>(
    name: string,
    result: unknown,
    parameters: unknown[],
  ): NativeFunction<Arguments, Result> => kernel32.func('__stdcall', name, result, parameters) as unknown as NativeFunction<Arguments, Result>
  return {
    types: {
      pointer,
      startupInfo,
      startupInfoEx,
      processInformation,
      sizeT: 'size_t',
      uint8: 'uint8',
      pointerSize: pointer.size,
    },
    createPipe: bind('CreatePipe', 'int', [pointerPointer, pointerPointer, pointer, 'uint32']),
    setHandleInformation: bind('SetHandleInformation', 'int', [pointer, 'uint32', 'uint32']),
    getStdHandle: bind('GetStdHandle', pointer, ['int']),
    createProcessW: bind('CreateProcessW', 'int', [
      'str16', pointer, pointer, pointer, 'int', 'uint32', pointer, 'str16', koffi.pointer(startupInfoEx), koffi.pointer(processInformation),
    ]),
    initializeProcThreadAttributeList: bind('InitializeProcThreadAttributeList', 'int', [pointer, 'uint32', 'uint32', koffi.pointer('size_t')]),
    updateProcThreadAttribute: bind('UpdateProcThreadAttribute', 'int', [
      pointer, 'uint32', 'uintptr', pointer, 'size_t', pointer, pointer,
    ]),
    deleteProcThreadAttributeList: bind('DeleteProcThreadAttributeList', 'void', [pointer]),
    createJobObjectW: bind('CreateJobObjectW', pointer, [pointer, 'str16']),
    setInformationJobObject: bind('SetInformationJobObject', 'int', [pointer, 'int', pointer, 'uint32']),
    assignProcessToJobObject: bind('AssignProcessToJobObject', 'int', [pointer, pointer]),
    resumeThread: bind('ResumeThread', 'uint32', [pointer]),
    terminateProcess: bind('TerminateProcess', 'int', [pointer, 'uint32']),
    terminateJobObject: bind('TerminateJobObject', 'int', [pointer, 'uint32']),
    queryInformationJobObject: bind('QueryInformationJobObject', 'int', [pointer, 'int', pointer, 'uint32', pointer]),
    waitForSingleObject: bind('WaitForSingleObject', 'uint32', [pointer, 'uint32']),
    getExitCodeProcess: bind('GetExitCodeProcess', 'int', [pointer, pointer]),
    peekNamedPipe: bind('PeekNamedPipe', 'int', [pointer, pointer, 'uint32', pointer, pointer, pointer]),
    readFile: bind('ReadFile', 'int', [pointer, pointer, 'uint32', pointer, pointer]),
    writeFile: bind('WriteFile', 'int', [pointer, pointer, 'uint32', pointer, pointer]),
    closeHandle: bind('CloseHandle', 'int', [pointer]),
    getLastError: bind('GetLastError', 'uint32', []),
    allocate: (type: unknown, length = 1) => koffi.alloc(type, length),
    encode: (target: unknown, type: unknown, value: unknown) => { koffi.encode(target, type, value) },
    decode: (target: unknown, type: unknown) => koffi.decode(target, type),
    pointerArray: (length: number) => koffi.array(pointer, length),
  }
}

class NativeHandleLease {
  private closed = false

  constructor(
    private readonly api: WindowsBindings,
    readonly value: NativeHandle,
  ) {}

  close(): void {
    if (this.closed) return
    this.closed = true
    this.api.closeHandle(this.value)
  }
}

function readablePipe(api: WindowsBindings, handle: NativeHandleLease, readBytes: number): Readable {
  return Readable.from((async function* (): AsyncGenerator<Buffer> {
    try {
      for (;;) {
        const chunk = Buffer.allocUnsafe(readBytes)
        const read = Buffer.alloc(4)
        const result = await invokeAsync(api.readFile, [handle.value, chunk, chunk.length, read, null])
        if (result === 0) {
          const code = api.getLastError()
          if (code === ERROR_BROKEN_PIPE) return
          throw nativeError('ReadFile', code)
        }
        const count = read.readUInt32LE()
        if (count > 0) yield chunk.subarray(0, count)
      }
    } finally {
      handle.close()
    }
  })())
}

function writablePipe(api: WindowsBindings, handle: NativeHandleLease): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      const data = Buffer.from(chunk)
      const written = Buffer.alloc(4)
      void invokeAsync(api.writeFile, [handle.value, data, data.length, written, null]).then((result) => {
        if (result === 0) throw nativeError('WriteFile', api.getLastError())
        if (written.readUInt32LE() !== data.length) throw new Error('subprocess-guardian: WriteFile completed partially')
        callback()
      }).catch((error: unknown) => { callback(asError(error)) })
    },
    destroy(error, callback): void {
      handle.close()
      callback(error)
    },
  })
}

async function waitForProcess(api: WindowsBindings, handle: NativeHandle): Promise<SubprocessOutcome> {
  await waitHandle(api.waitForSingleObject, handle, INFINITE)
  const code = Buffer.alloc(4)
  if (api.getExitCodeProcess(handle, code) === 0) throw nativeError('GetExitCodeProcess', api.getLastError())
  return { exitCode: code.readUInt32LE(), signal: null }
}

async function hasExited(api: WindowsBindings, handle: NativeHandle): Promise<boolean> {
  const result = await waitHandle(api.waitForSingleObject, handle, 0)
  return result === WAIT_OBJECT_0
}

async function waitHandle(
  wait: WindowsBindings['waitForSingleObject'],
  handle: NativeHandle,
  milliseconds: number,
): Promise<number> {
  const result = await invokeAsync(wait, [handle, milliseconds])
  if (result === WAIT_FAILED) throw new Error('subprocess-guardian: WaitForSingleObject failed')
  if (result !== WAIT_OBJECT_0 && result !== WAIT_TIMEOUT) {
    throw new Error(`subprocess-guardian: unexpected WaitForSingleObject result ${String(result)}`)
  }
  return result
}

function invokeAsync<Arguments extends readonly unknown[], Result>(
  fn: NativeFunction<Arguments, Result>,
  args: Arguments,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (error, result) => {
      if (error === null || error === undefined) resolve(result)
      else {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- preserve the native callback's rejection.
        reject(error)
      }
    })
  })
}

function safeNativeSize(value: unknown, label: string): number {
  const size = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error(`subprocess-guardian: invalid ${label} size`)
  }
  return size as number
}

function encodeWide(value: string): Buffer {
  if (value.includes('\0')) throw new Error('subprocess-guardian: Windows string contains NUL')
  return Buffer.from(`${value}\0`, 'utf16le')
}

function encodeEnvironment(environment: Readonly<Record<string, string>>): Buffer {
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
  for (const [key, value] of entries) {
    if (key.length === 0 || key.includes('=') || key.includes('\0') || value.includes('\0')) {
      throw new Error('subprocess-guardian: invalid Windows environment entry')
    }
  }
  return Buffer.from(`${entries.map(([key, value]) => `${key}=${value}`).join('\0')}\0\0`, 'utf16le')
}

function validateSpawnSpec(spec: GuardianNativeSpawnSpec): void {
  if (spec.argv.length === 0 || spec.argv.some(value => value.includes('\0')) || spec.cwd.includes('\0')) {
    throw new Error('subprocess-guardian: invalid Windows spawn strings')
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds)
    timer.unref()
    signal?.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

function isLease(value: NativeHandleLease | undefined): value is NativeHandleLease { return value !== undefined }

function isNullHandle(value: NativeHandle | null | undefined): value is null | undefined {
  return value === null || value === undefined || value === 0n || value === -1n || value === 0xFFFFFFFFFFFFFFFFn
}

function nativeError(api: string, code: number): Error {
  const error = new Error(`subprocess-guardian: ${api} failed with Win32 error ${String(code)}`)
  error.name = 'GuardianWin32Error'
  return error
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)) }
