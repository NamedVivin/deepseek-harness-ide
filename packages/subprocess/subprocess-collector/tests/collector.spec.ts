import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectReadable, OutputCollector } from '@deepseek-ai/dsh-subprocess-collector'
import { runOutputCollectorContract } from './contract.ts'

const { failNextClose, failNextUnlink, failNextWrite, mkdtempCalls } = vi.hoisted(() => ({
  failNextClose: { value: false },
  failNextUnlink: { value: false },
  failNextWrite: { value: false },
  mkdtempCalls: { value: 0 },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtempSync(...args: Parameters<typeof actual.mkdtempSync>): ReturnType<typeof actual.mkdtempSync> {
      mkdtempCalls.value += 1
      return Reflect.apply(actual.mkdtempSync, actual, args)
    },
    closeSync(fd: number): void {
      if (failNextClose.value) {
        failNextClose.value = false
        throw Object.assign(new Error('simulated EIO on close'), { code: 'EIO' })
      }
      actual.closeSync(fd)
    },
    unlinkSync(path: import('node:fs').PathLike): void {
      if (failNextUnlink.value) {
        failNextUnlink.value = false
        throw Object.assign(new Error('simulated EBUSY on unlink'), { code: 'EBUSY' })
      }
      actual.unlinkSync(path)
    },
    writeSync(...args: Parameters<typeof actual.writeSync>): ReturnType<typeof actual.writeSync> {
      if (failNextWrite.value) {
        failNextWrite.value = false
        throw Object.assign(new Error('simulated ENOSPC on write'), { code: 'ENOSPC' })
      }
      return Reflect.apply(actual.writeSync, actual, args)
    },
  }
})

let spillDir: string

beforeEach(() => {
  spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-collector-'))
  mkdtempCalls.value = 0
})
afterEach(() => { rmSync(spillDir, { recursive: true, force: true }) })

describe('default spill directory allocation', () => {
  it('waits for the first actual spill and skips allocation when spill is disabled', () => {
    const memoryOnly = new OutputCollector({ maxBytes: 4, label: 'stdout' })
    memoryOnly.push(Buffer.from('abcdefgh'))
    expect(memoryOnly.readFrom(0)).toEqual({ text: 'efgh', nextOffset: 8, lossy: true })
    expect(mkdtempCalls.value).toBe(0)

    const spilling = new OutputCollector({ maxBytes: 4, maxSpillBytes: 100, label: 'stderr' })
    spilling.push(Buffer.from('abcd'))
    expect(mkdtempCalls.value).toBe(0)
    spilling.push(Buffer.from('efgh'))
    expect(mkdtempCalls.value).toBe(1)
    expect(spilling.provisionalSpillPath).toBeDefined()
    spilling.fail()
  })
})

runOutputCollectorContract(() => spillDir)

describe('spill final-close failure', () => {
  it('does not promote a spill whose first final close fails', () => {
    const collector = new OutputCollector({ maxBytes: 4, maxSpillBytes: 100, label: 'stdout', spillDir })
    collector.push(Buffer.from('abcdefgh'))
    failNextClose.value = true

    expect(collector.finalize()).toEqual({ text: 'efgh', truncated: true })
    expect(failNextClose.value).toBe(false)
    expect(collector.readFrom(0)).toEqual({ text: 'efgh', nextOffset: 8, lossy: true })
  })

  it('turns an ingest failure into a failed drain instead of throwing from the stream callback', async () => {
    const stream = new PassThrough()
    const collected = collectReadable(stream, {
      maxBytes: 4,
      label: 'stdout',
      spillDir,
    })
    vi.spyOn(collected.collector, 'push').mockImplementationOnce(() => { throw new Error('ingest failed') })

    expect(() => { stream.write('data') }).not.toThrow()
    await expect(collected.drained).rejects.toThrow('ingest failed')
    expect(stream.destroyed).toBe(true)
  })

  it('keeps collecting the tail after optional spill write failure', () => {
    const collector = new OutputCollector({ maxBytes: 4, maxSpillBytes: 100, label: 'stdout', spillDir })
    collector.push(Buffer.from('abcd'))
    failNextWrite.value = true
    collector.push(Buffer.from('efgh'))
    collector.push(Buffer.from('ijkl'))

    expect(collector.finalize()).toEqual({ text: 'ijkl', truncated: true })
    expect(collector.readFrom(0)).toEqual({ text: 'ijkl', nextOffset: 12, lossy: true })
  })

  it('retries cleanup after a provisional spill unlink fails', () => {
    const collector = new OutputCollector({ maxBytes: 4, maxSpillBytes: 100, label: 'stdout', spillDir })
    collector.push(Buffer.from('abcdefgh'))
    const provisional = collector.provisionalSpillPath!
    failNextUnlink.value = true

    expect(collector.fail()).toEqual({ text: 'efgh', truncated: true })
    expect(failNextUnlink.value).toBe(false)
    expect(existsSync(provisional)).toBe(false)
  })

  it('appends to an open spill and disables spill before creating one when its cap is already exceeded', () => {
    const open = new OutputCollector({ maxBytes: 4, maxSpillBytes: 100, label: 'stdout', spillDir })
    open.push(Buffer.from('abcd'))
    open.push(Buffer.from('efgh'))
    open.push(Buffer.from('i'))
    const openOutput = open.finalize()
    expect(openOutput).toMatchObject({ text: 'fghi', truncated: true })
    expect(typeof openOutput.spillPath).toBe('string')

    const neverOpened = new OutputCollector({ maxBytes: 4, maxSpillBytes: 4, label: 'stderr', spillDir })
    neverOpened.push(Buffer.from('abcdefgh'))
    expect(neverOpened.finalize()).toEqual({ text: 'efgh', truncated: true })
  })

  it('fails a synthetic whole-stream offset overflow without retaining the new byte', () => {
    const collector = new OutputCollector({ maxBytes: 4, label: 'stdout' })
    Object.defineProperty(collector, 'totalBytes', { value: Number.MAX_SAFE_INTEGER, writable: true })

    expect(() => { collector.push(Buffer.from('x')) }).toThrow('Number.MAX_SAFE_INTEGER')
    expect(collector.finalize()).toEqual({ text: '', truncated: false })
  })

  it('covers readable error, string chunks, settled failure, and clean signalled drain', async () => {
    const failed = new PassThrough()
    const collectedFailure = collectReadable(failed, { maxBytes: 4, label: 'stderr', spillDir })
    failed.emit('data', 'text')
    failed.emit('error', new Error('stream failed'))
    await expect(collectedFailure.drained).rejects.toThrow('stream failed')
    collectedFailure.fail(new Error('already settled'))
    expect(collectedFailure.collector.size).toBe(4)
    expect(collectedFailure.collector.truncated).toBe(false)

    const clean = new PassThrough()
    const collectedClean = collectReadable(clean, { maxBytes: 4, label: 'stdout', spillDir })
    const draining = collectedClean.drain(new AbortController().signal)
    clean.end('done')
    await expect(draining).resolves.toBe(true)
    collectedClean.fail()
  })

  it('normalizes non-Error ingestion failures and does not destroy an already destroyed stream', async () => {
    const stream = new PassThrough()
    const collected = collectReadable(stream, { maxBytes: 4, label: 'stdout', spillDir })
    vi.spyOn(collected.collector, 'push').mockImplementationOnce(() => { throw 'ingest failed' })
    stream.destroy()
    stream.emit('data', Buffer.from('data'))

    await expect(collected.drained).rejects.toThrow('ingest failed')
    collected.fail()
  })

  it('handles already-aborted and registration-race drain signals', async () => {
    const alreadyAborted = new PassThrough()
    const first = collectReadable(alreadyAborted, { maxBytes: 4, label: 'stdout', spillDir })
    const firstController = new AbortController()
    firstController.abort('deadline')
    await expect(first.drain(firstController.signal)).resolves.toBe(false)

    const abortedWithError = new PassThrough()
    const withError = collectReadable(abortedWithError, { maxBytes: 4, label: 'stdout', spillDir })
    const errorController = new AbortController()
    errorController.abort(new Error('deadline'))
    await expect(withError.drain(errorController.signal)).resolves.toBe(false)

    const raced = new PassThrough()
    const second = collectReadable(raced, { maxBytes: 4, label: 'stdout', spillDir })
    const secondController = new AbortController()
    const signal = secondController.signal
    const addEventListener = signal.addEventListener.bind(signal)
    vi.spyOn(signal, 'addEventListener').mockImplementation((...args) => {
      addEventListener(...args)
      secondController.abort('registered abort')
    })
    await expect(second.drain(signal)).resolves.toBe(false)
  })
})
