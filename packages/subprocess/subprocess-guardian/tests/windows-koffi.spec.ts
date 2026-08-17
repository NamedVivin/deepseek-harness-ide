import { describe, expect, it } from 'vitest'
import { createKoffiWindowsJobTransport, KoffiWindowsJobTransport, quoteWindowsArgument } from '../src/windows-koffi.ts'
import type { GuardianNativeSpawnSpec } from '../src/supervisor.ts'

interface FakeWindowsState {
  readonly inherited: string[]
  readonly restored: string[]
  readonly closed: string[]
  readonly whitelisted: bigint[][]
  creationFlags: number
  inheritHandles: number
  startup: unknown
  attributeDeletes: number
  failUpdate: boolean
}

function fakeBindings(state: FakeWindowsState): unknown {
  const values = new Map<object, unknown>()
  let nextHandle = 10n
  let lastError = 0
  const allocate = (_type: unknown, _length = 1): object => ({ allocation: Symbol('native') })
  const encode = (target: object, _type: unknown, value: unknown): void => { values.set(target, value) }
  const decode = (target: object, _type: unknown): unknown => values.get(target)
  const waitForSingleObject = Object.assign(
    (_handle: bigint, _milliseconds: number): number => 0,
    {
      async: (...args: unknown[]): void => {
        const callback = args.at(-1) as (error: unknown, result: number) => void
        queueMicrotask(() => { callback(null, 0) })
      },
    },
  )
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
      encode(read, 'pointer', nextHandle++)
      encode(write, 'pointer', nextHandle++)
      return 1
    },
    setHandleInformation: (handle: bigint, _mask: number, flags: number): number => {
      const target = flags === 0 ? state.restored : state.inherited
      target.push(String(handle))
      return 1
    },
    getStdHandle: (): bigint => 90n,
    createProcessW: (...args: unknown[]): number => {
      state.inheritHandles = args[4] as number
      state.creationFlags = args[5] as number
      state.startup = values.get(args[8] as object)
      encode(args[9] as object, 'process-information', {
        hProcess: 100n,
        hThread: 101n,
        dwProcessId: 4242,
        dwThreadId: 4343,
      })
      return 1
    },
    initializeProcThreadAttributeList: (list: object | null, _count: number, _flags: number, size: object): number => {
      if (list === null) {
        encode(size, 'size_t', 64)
        lastError = 122
        return 0
      }
      return 1
    },
    updateProcThreadAttribute: (
      _list: object,
      _flags: number,
      _attribute: number,
      handles: object,
    ): number => {
      state.whitelisted.push(values.get(handles) as bigint[])
      if (state.failUpdate) {
        lastError = 87
        return 0
      }
      return 1
    },
    deleteProcThreadAttributeList: (): undefined => { state.attributeDeletes += 1; return undefined },
    createJobObjectW: (): bigint => 200n,
    setInformationJobObject: (): number => 1,
    assignProcessToJobObject: (): number => 1,
    resumeThread: (): number => 1,
    terminateProcess: (): number => 1,
    terminateJobObject: (): number => 1,
    queryInformationJobObject: (): number => 1,
    waitForSingleObject,
    getExitCodeProcess: (_handle: bigint, code: Buffer): number => { code.writeUInt32LE(0); return 1 },
    peekNamedPipe: (): number => 0,
    readFile: Object.assign((): number => 0, { async: (): void => {} }),
    writeFile: Object.assign((): number => 1, { async: (): void => {} }),
    closeHandle: (handle: bigint): number => { state.closed.push(String(handle)); return 1 },
    getLastError: (): number => lastError,
    allocate,
    encode,
    decode,
    pointerArray: (length: number): string => `pointer-array:${String(length)}`,
  }
}

function fakeState(): FakeWindowsState {
  return {
    inherited: [],
    restored: [],
    closed: [],
    whitelisted: [],
    creationFlags: 0,
    inheritHandles: 0,
    startup: undefined,
    attributeDeletes: 0,
    failUpdate: false,
  }
}

function spawnSpec(): GuardianNativeSpawnSpec {
  return {
    argv: ['C:\\Program Files\\Node\\node.exe', '-e', ''],
    cwd: 'C:\\workspace',
    env: { PATH: 'C:\\Windows\\System32' },
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 100,
  }
}

describe('Windows Koffi transport surface', () => {
  it.each([
    ['', '""'],
    ['plain', 'plain'],
    ['two words', '"two words"'],
    ['trailing slash\\', '"trailing slash\\\\"'],
    ['say "hello"', '"say \\"hello\\""'],
  ])('quotes %j for CreateProcessW', (argument, expected) => {
    expect(quoteWindowsArgument(argument)).toBe(expected)
  })

  it('requires explicit positive native scheduling and pipe bounds', () => {
    expect(() => new KoffiWindowsJobTransport({} as never, {
      activeProcessPollMs: 0,
      pipeReadBytes: 64,
    })).toThrow('activeProcessPollMs')
    expect(() => new KoffiWindowsJobTransport({} as never, {
      activeProcessPollMs: 1,
      pipeReadBytes: 0,
    })).toThrow('pipeReadBytes')
  })

  it.runIf(process.platform !== 'win32')('refuses to load kernel32 on another platform', async () => {
    await expect(createKoffiWindowsJobTransport({ activeProcessPollMs: 1, pipeReadBytes: 64 }))
      .rejects.toThrow('requires win32-x64')
  })

  it('uses STARTUPINFOEX HANDLE_LIST to inherit only the three target stdio handles', async () => {
    const state = fakeState()
    const transport = new KoffiWindowsJobTransport(fakeBindings(state) as never, {
      activeProcessPollMs: 1,
      pipeReadBytes: 64,
    })
    const child = await transport.createSuspendedProcess(spawnSpec(), new AbortController().signal)
    expect(child.pid).toBe(4242)
    expect(state.inheritHandles).toBe(1)
    expect(state.creationFlags & 0x00080000).toBe(0x00080000)
    expect(state.whitelisted).toEqual([[10n, 13n, 15n]])
    expect(state.inherited).toEqual(['10', '13', '15'])
    expect(state.restored).toEqual(['10', '13', '15'])
    expect(state.startup).toMatchObject({ StartupInfo: { cb: 112 } })
    expect(state.attributeDeletes).toBe(1)
    await transport.closeProcess(child)
  })

  it('deletes the attribute list, restores inherit flags, and closes pipes when HANDLE_LIST setup fails', async () => {
    const state = fakeState()
    state.failUpdate = true
    const transport = new KoffiWindowsJobTransport(fakeBindings(state) as never, {
      activeProcessPollMs: 1,
      pipeReadBytes: 64,
    })
    await expect(transport.createSuspendedProcess(spawnSpec(), new AbortController().signal))
      .rejects.toThrow('UpdateProcThreadAttribute')
    expect(state.attributeDeletes).toBe(1)
    expect(state.restored).toEqual(['10', '13', '15'])
    expect(state.closed).toEqual(expect.arrayContaining(['10', '11', '12', '13', '14', '15']))
  })
})
