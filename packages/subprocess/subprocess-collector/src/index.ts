/**
 * Provider-neutral subprocess output collection: byte-exact bounded tails,
 * independent whole-stream offsets, optional private spill files, and an
 * explicit drain/finalization lifecycle.
 * @module @deepseek-ai/dsh-subprocess-collector
 */

import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  CollectedOutput,
  SubprocessOutputRead,
  SubprocessOutputReader,
} from '@deepseek-ai/dsh-subprocess'

/** Construction values for one collected subprocess stream. */
export interface OutputCollectorOptions {
  /** Exact in-memory tail cap in bytes. */
  maxBytes: number
  /** Complete-stream spill cap; omission disables spill creation. */
  maxSpillBytes?: number
  /** Safe filename label such as `stdout` or `stderr`. */
  label: string
  /** Existing private directory for spill files; omission uses a process-private temp directory. */
  spillDir?: string
}

/** One readable stream attached to an {@link OutputCollector}. */
export interface CollectedReadable {
  /** Reader published on the subprocess handle. */
  readonly reader: SubprocessOutputReader
  /** Collector used by framing providers that also need direct state access. */
  readonly collector: OutputCollector
  /** Resolves only after clean EOF; rejects on stream error or close-before-end. */
  readonly drained: Promise<void>
  /**
   * Await clean EOF or invalidate and stop the stream when `signal` aborts.
   * @param signal - optional provider-owned drain bound.
   * @returns `true` for complete EOF, `false` when the bound aborted first.
   */
  drain(signal?: AbortSignal): Promise<boolean>
  /**
   * Mark the stream incomplete, remove its provisional spill, and stop reading.
   * @param reason - optional stream-destruction reason.
   */
  fail(reason?: Error): void
}

type CollectorState = 'active' | 'complete' | 'incomplete'

let spillCounter = 0
let defaultSpillDir: string | undefined

/** Return the lazily-created mode-0700 spill directory shared by this process. */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))
  return defaultSpillDir
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`subprocess collector ${name} must be a positive safe integer`)
  }
}

/** Read live abort state after listener registration. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Bounded byte collector shared by local and transported subprocess providers.
 * A spill path is provisional while bytes can still arrive and becomes public
 * only after clean finalization closes the file successfully.
 */
export class OutputCollector implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0
  private dropped = false
  private state: CollectorState = 'active'
  private spillDisabled: boolean
  private spillFd: number | undefined
  private spillCandidate: string | undefined
  private cleanupCandidate: string | undefined
  private finalizedSpill: string | undefined
  private readonly maxBytes: number
  private readonly maxSpillBytes: number | undefined
  private readonly label: string
  private readonly spillDir: string

  /**
   * Create one collector. Limits and the path-safe label are validated before any file is created.
   * @param options - memory/spill caps, filename label, and optional private spill directory.
   */
  constructor(options: OutputCollectorOptions) {
    requirePositiveSafeInteger(options.maxBytes, 'maxBytes')
    if (options.maxSpillBytes !== undefined) {
      requirePositiveSafeInteger(options.maxSpillBytes, 'maxSpillBytes')
    }
    if (!/^[A-Za-z0-9_-]+$/.test(options.label)) {
      throw new Error('subprocess collector label must contain only letters, numbers, _ or -')
    }
    this.maxBytes = options.maxBytes
    this.maxSpillBytes = options.maxSpillBytes
    this.label = options.label
    this.spillDir = options.spillDir ?? privateSpillDir()
    this.spillDisabled = options.maxSpillBytes === undefined
  }

  /** Total whole-stream bytes accepted so far. */
  get size(): number {
    return this.totalBytes
  }

  /** Whether this collector has observed and discarded bytes from its in-memory head. */
  get truncated(): boolean {
    return this.dropped
  }

  /**
   * Provider-private path to a still-open, incomplete spill file. Never publish
   * this value through a subprocess handle.
   */
  get provisionalSpillPath(): string | undefined {
    return this.state === 'active' ? this.spillCandidate : undefined
  }

  /**
   * Ingest exact bytes from the provider transport.
   * @param bytes - immutable-for-the-call bytes; the collector retains its own copy.
   */
  push(bytes: Uint8Array): void {
    if (this.state !== 'active') throw new Error('subprocess collector received bytes after finalization')
    if (bytes.byteLength === 0) return
    const chunk = Buffer.from(bytes)
    if (!Number.isSafeInteger(this.totalBytes + chunk.length)) {
      this.fail()
      throw new Error('subprocess collector whole-stream offset exceeded Number.MAX_SAFE_INTEGER')
    }
    this.totalBytes += chunk.length
    const overflows = this.retainedBytes + chunk.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(chunk)
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
      this.dropped = true
    }
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
      throw new Error('subprocess collector offset must be a non-negative safe integer')
    }
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = fromByte < firstRetained
    const retained = Buffer.concat(this.chunks, this.retainedBytes)
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained))
    return {
      text: retained.subarray(start).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
      ...lossy && this.finalizedSpill !== undefined ? { spillPath: this.finalizedSpill } : {},
    }
  }

  /**
   * Promote a cleanly drained spill after its final close succeeds. Idempotent.
   * @returns the final tail, truncation fact, and complete spill path when available.
   */
  finalize(): CollectedOutput {
    if (this.state === 'active') {
      this.state = 'complete'
      const candidate = this.spillCandidate
      const closed = this.closeSpill()
      if (closed && candidate !== undefined) this.finalizedSpill = candidate
      else if (candidate !== undefined) this.cleanupFile(candidate)
      this.spillCandidate = undefined
      this.retryCleanup()
    }
    return this.output()
  }

  /**
   * Finalize an incomplete transport without advertising its provisional spill. Idempotent.
   * @returns the retained tail and truncation fact without a spill path.
   */
  fail(): CollectedOutput {
    if (this.state === 'active') {
      this.state = 'incomplete'
      const candidate = this.spillCandidate
      this.closeSpill()
      this.spillCandidate = undefined
      if (candidate !== undefined) this.cleanupFile(candidate)
      this.retryCleanup()
    }
    return this.output()
  }

  private output(): CollectedOutput {
    return {
      text: Buffer.concat(this.chunks, this.retainedBytes).toString('utf8'),
      truncated: this.dropped,
      ...this.finalizedSpill !== undefined ? { spillPath: this.finalizedSpill } : {},
    }
  }

  private spillAll(chunk: Buffer): void {
    if (this.maxSpillBytes !== undefined && this.totalBytes > this.maxSpillBytes) {
      this.disableSpill()
      return
    }
    try {
      if (this.spillFd === undefined) {
        const path = join(
          this.spillDir,
          `dsh-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
        )
        this.spillFd = openSync(path, 'wx', 0o600)
        this.spillCandidate = path
        for (const prior of this.chunks) writeSync(this.spillFd, prior)
      }
      writeSync(this.spillFd, chunk)
    } catch (_spillWriteFailure) {
      // Optional recovery must not turn otherwise readable subprocess output into a host failure.
      this.disableSpill()
    }
  }

  private disableSpill(): void {
    const candidate = this.spillCandidate
    this.spillDisabled = true
    this.closeSpill()
    this.spillCandidate = undefined
    if (candidate !== undefined) this.cleanupFile(candidate)
  }

  private closeSpill(): boolean {
    if (this.spillFd === undefined) return true
    const fd = this.spillFd
    try {
      closeSync(fd)
      this.spillFd = undefined
      return true
    } catch {
      // Keep the descriptor for one later retry; the candidate is never promoted.
      return false
    }
  }

  private cleanupFile(path: string): void {
    try {
      unlinkSync(path)
      if (this.cleanupCandidate === path) this.cleanupCandidate = undefined
    } catch {
      // The file is bounded by maxSpillBytes and never advertised; retain its path for one final retry.
      this.cleanupCandidate = path
    }
  }

  private retryCleanup(): void {
    this.closeSpill()
    if (this.cleanupCandidate !== undefined) this.cleanupFile(this.cleanupCandidate)
  }
}

/**
 * Attach a collector to a Node readable while keeping clean EOF distinct from
 * error, early close, and provider-owned drain cancellation.
 * @param stream - raw subprocess or transport-proxy output stream.
 * @param options - collection limits and spill placement.
 * @returns collector, public reader, drain promise, and incomplete-stream cleanup.
 */
export function collectReadable(stream: Readable, options: OutputCollectorOptions): CollectedReadable {
  const collector = new OutputCollector(options)
  const completion = Promise.withResolvers<void>()
  let settled = false
  const finish = (complete: boolean, error?: Error): void => {
    if (settled) return
    settled = true
    removeListeners()
    if (complete) {
      collector.finalize()
      completion.resolve()
    } else {
      collector.fail()
      completion.reject(error ?? new Error('subprocess collected stream closed before clean EOF'))
    }
  }
  const onData = (chunk: Buffer | Uint8Array | string): void => {
    try {
      collector.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    } catch (error: unknown) {
      finish(false, error instanceof Error ? error : new Error(String(error)))
      if (!stream.destroyed) stream.destroy()
    }
  }
  const onEnd = (): void => { finish(true) }
  const onError = (error: Error): void => { finish(false, error) }
  const onClose = (): void => { finish(false) }
  const removeListeners = (): void => {
    stream.off('data', onData)
    stream.off('end', onEnd)
    stream.off('error', onError)
    stream.off('close', onClose)
  }
  stream.on('data', onData)
  stream.once('end', onEnd)
  stream.once('error', onError)
  stream.once('close', onClose)
  void completion.promise.catch(() => {})

  const fail = (reason?: Error): void => {
    finish(false, reason)
    if (!stream.destroyed) stream.destroy()
  }

  return {
    reader: collector,
    collector,
    drained: completion.promise,
    async drain(signal?: AbortSignal): Promise<boolean> {
      if (signal === undefined) {
        await completion.promise
        return true
      }
      if (signal.aborted) {
        fail(signal.reason instanceof Error ? signal.reason : undefined)
        return false
      }
      const aborted = Promise.withResolvers<boolean>()
      const onAbort = (): void => {
        aborted.resolve(false)
        fail(signal.reason instanceof Error ? signal.reason : undefined)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (isAborted(signal)) onAbort()
      try {
        return await Promise.race([completion.promise.then(() => true), aborted.promise])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
    fail,
  }
}
