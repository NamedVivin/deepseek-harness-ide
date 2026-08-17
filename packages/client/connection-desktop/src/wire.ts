/** Bounded UTF-8 JSON framing shared by both directions of the desktop child-IPC hop. */

import {
  DESKTOP_CONNECTION_PROTOCOL_VERSION,
  DesktopBodyId,
  type DesktopBodyFrame,
  type DesktopBodyId as DesktopBodyIdType,
} from './protocol.ts'

/** Default aggregate body limit: 160 MiB. */
export const DEFAULT_MAX_DESKTOP_BODY_BYTES = 160 * 1024 * 1024
/** Default physical child-IPC chunk limit: 1 MiB. */
export const DEFAULT_MAX_DESKTOP_CHUNK_BYTES = 1024 * 1024
/** Default hop-wide unacknowledged byte limit: 16 MiB. */
export const DEFAULT_MAX_DESKTOP_INFLIGHT_BYTES = 16 * 1024 * 1024

/** Optional desktop IPC limit fields accepted by provider and peer constructors. */
export interface DesktopIpcLimitsInput {
  /** Maximum UTF-8 JSON bytes in one request, response, or event. */
  readonly maxDesktopBodyBytes?: number
  /** Maximum bytes in one physical chunk. */
  readonly maxDesktopChunkBytes?: number
  /** Maximum unacknowledged bytes shared by all concurrent bodies on one hop. */
  readonly maxDesktopInflightBytes?: number
}

/** Validated limits used by one direction pair of a desktop IPC hop. */
export interface DesktopIpcLimits {
  /** Maximum UTF-8 JSON bytes in one request, response, or event. */
  readonly maxDesktopBodyBytes: number
  /** Maximum bytes in one physical chunk. */
  readonly maxDesktopChunkBytes: number
  /** Maximum unacknowledged bytes shared by all concurrent bodies on one hop. */
  readonly maxDesktopInflightBytes: number
}

/** Stable failure for a body that exceeds the configured aggregate limit. */
export class DesktopBodyLimitError extends Error {
  /**
   * @param actualBytes - observed UTF-8 byte count.
   * @param limitBytes - configured inclusive limit.
   */
  constructor(readonly actualBytes: number, readonly limitBytes: number) {
    super(`connection-desktop: body is ${String(actualBytes)} bytes; limit is ${String(limitBytes)}`)
    this.name = 'DesktopBodyLimitError'
  }
}

/** Stable failure for malformed, duplicated, or out-of-order physical frames. */
export class DesktopProtocolError extends Error {
  /** @param message - precise rejected protocol condition. */
  constructor(message: string) {
    super(`connection-desktop: ${message}`)
    this.name = 'DesktopProtocolError'
  }
}

/**
 * Resolve and validate desktop body, chunk, and hop-wide credit limits.
 * @param input - optional deployment overrides.
 * @returns immutable positive-integer limits with a non-zero credit window.
 */
export function resolveDesktopIpcLimits(input: DesktopIpcLimitsInput = {}): DesktopIpcLimits {
  const limits: DesktopIpcLimits = {
    maxDesktopBodyBytes: input.maxDesktopBodyBytes ?? DEFAULT_MAX_DESKTOP_BODY_BYTES,
    maxDesktopChunkBytes: input.maxDesktopChunkBytes ?? DEFAULT_MAX_DESKTOP_CHUNK_BYTES,
    maxDesktopInflightBytes: input.maxDesktopInflightBytes ?? DEFAULT_MAX_DESKTOP_INFLIGHT_BYTES,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`connection-desktop: ${name} must be a positive safe integer`)
    }
  }
  if (limits.maxDesktopChunkBytes > limits.maxDesktopInflightBytes) {
    throw new Error(
      'connection-desktop: maxDesktopChunkBytes must not exceed maxDesktopInflightBytes',
    )
  }
  return Object.freeze(limits)
}

interface PendingAcknowledgement {
  readonly byteLength: number
  readonly release: () => void
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

interface ReceivingBody {
  readonly expectedBytes: number
  readonly chunks: Uint8Array[]
  nextSequence: number
  receivedBytes: number
}

interface CreditWaiter {
  readonly byteLength: number
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

class HopCredit {
  private used = 0
  private readonly waiters: CreditWaiter[] = []

  constructor(private readonly capacity: number) {}

  get usedBytes(): number {
    return this.used
  }

  reserve(byteLength: number, signal?: AbortSignal): Promise<() => void> {
    if (signal === undefined) return this.enqueue(byteLength)
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return this.enqueueCancellable(byteLength, signal)
  }

  private enqueue(byteLength: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const waiter: CreditWaiter = {
        byteLength,
        resolve,
        reject,
      }
      this.waiters.push(waiter)
      this.drain()
    })
  }

  private enqueueCancellable(byteLength: number, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const waiter = {
        byteLength,
        resolve,
        reject,
        signal,
        onAbort: (): void => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(abortReason(signal))
          this.drain()
        },
      } satisfies CreditWaiter
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
  }

  fail(error: unknown): void {
    for (const waiter of this.waiters.splice(0)) {
      this.removeAbort(waiter)
      waiter.reject(error)
    }
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0] as CreditWaiter
      if (this.used + waiter.byteLength > this.capacity) return
      this.waiters.shift()
      this.removeAbort(waiter)
      this.used += waiter.byteLength
      waiter.resolve(() => {
        this.used -= waiter.byteLength
        this.drain()
      })
    }
  }

  private removeAbort(waiter: CreditWaiter): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }
}

/**
 * Encode, chunk, acknowledge, reassemble, and decode bodies for one physical hop.
 * Both peers instantiate this class with the same validated limits.
 */
export class DesktopBodyTransport {
  private readonly credit: HopCredit
  private readonly pending = new Map<string, PendingAcknowledgement>()
  private readonly receiving = new Map<DesktopBodyIdType, ReceivingBody>()
  private readonly completed = new Map<DesktopBodyIdType, unknown>()
  private terminalError: Error | undefined

  /**
   * @param sendFrame - physical frame sender for the local direction.
   * @param limits - validated body, chunk, and credit limits.
   */
  constructor(
    private readonly sendFrame: (frame: DesktopBodyFrame) => void,
    private readonly limits: DesktopIpcLimits,
  ) {
    this.credit = new HopCredit(limits.maxDesktopInflightBytes)
  }

  /** Current bytes sent but not yet acknowledged across every local body. */
  get inflightBytes(): number {
    return this.credit.usedBytes
  }

  /**
   * Encode and send one JSON value as ordered bounded chunks.
   * @param value - wire value accepted by `JSON.stringify`.
   * @param signal - optional operation cancellation.
   * @returns body id referenced by a later control frame.
   */
  async send(value: unknown, signal?: AbortSignal): Promise<DesktopBodyIdType> {
    this.throwIfTerminal()
    if (signal?.aborted === true) throw abortReason(signal)
    const encoded = encodeJson(value)
    if (encoded.byteLength > this.limits.maxDesktopBodyBytes) {
      throw new DesktopBodyLimitError(encoded.byteLength, this.limits.maxDesktopBodyBytes)
    }
    const bodyId = DesktopBodyId(globalThis.crypto.randomUUID())
    this.sendFrame({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'body-start',
      bodyId,
      byteLength: encoded.byteLength,
    })
    const acknowledgements: Promise<void>[] = []
    try {
      let sequence = 0
      for (let offset = 0; offset < encoded.byteLength; offset += this.limits.maxDesktopChunkBytes) {
        const chunk = encoded.slice(offset, offset + this.limits.maxDesktopChunkBytes)
        const release = await this.credit.reserve(chunk.byteLength, signal)
        try {
          this.throwIfTerminal()
          throwIfAborted(signal)
        } catch (error) {
          release()
          throw error
        }
        const key = acknowledgementKey(bodyId, sequence)
        const acknowledgement = new Promise<void>((resolve, reject) => {
          this.pending.set(key, { byteLength: chunk.byteLength, release, resolve, reject })
        })
        acknowledgements.push(acknowledgement)
        try {
          this.sendFrame({
            version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
            type: 'body-chunk',
            bodyId,
            sequence,
            chunk,
          })
        } catch (error) {
          this.rejectAcknowledgement(key, error)
          throw error
        }
        sequence += 1
      }
      this.sendFrame({ version: DESKTOP_CONNECTION_PROTOCOL_VERSION, type: 'body-end', bodyId })
      await waitForAcknowledgements(acknowledgements, signal)
      return bodyId
    } catch (error) {
      this.cancelSentBody(bodyId, error)
      await Promise.allSettled(acknowledgements)
      throw error
    }
  }

  /**
   * Accept one already validated body frame from the peer.
   * @param frame - body lifecycle or acknowledgement frame.
   */
  accept(frame: DesktopBodyFrame): void {
    this.throwIfTerminal()
    switch (frame.type) {
      case 'body-start':
        this.start(frame.bodyId, frame.byteLength)
        return
      case 'body-chunk':
        this.chunk(frame.bodyId, frame.sequence, frame.chunk)
        return
      case 'body-ack':
        this.acknowledge(frame.bodyId, frame.sequence, frame.byteLength)
        return
      case 'body-end':
        this.end(frame.bodyId)
        return
      case 'body-cancel':
        this.receiving.delete(frame.bodyId)
        this.completed.delete(frame.bodyId)
        this.cancelPendingAcknowledgements(frame.bodyId)
        return
    }
  }

  /**
   * Consume a completed decoded body referenced by a control frame.
   * @param bodyId - completed body correlation id.
   * @returns decoded JSON value exactly once.
   */
  take(bodyId: DesktopBodyIdType): unknown {
    if (!this.completed.has(bodyId)) {
      throw new DesktopProtocolError(`control frame references incomplete body ${JSON.stringify(bodyId)}`)
    }
    const value = this.completed.get(bodyId)
    this.completed.delete(bodyId)
    return value
  }

  /**
   * Reject all current and future body work after disconnect or protocol failure.
   * @param error - terminal transport reason.
   */
  close(error: unknown): void {
    if (this.terminalError !== undefined) return
    const reason = normalizeError(error)
    this.terminalError = reason
    this.credit.fail(reason)
    for (const [key, pending] of this.pending) {
      this.pending.delete(key)
      pending.release()
      pending.reject(reason)
    }
    this.receiving.clear()
    this.completed.clear()
  }

  private start(bodyId: DesktopBodyIdType, byteLength: number): void {
    if (byteLength > this.limits.maxDesktopBodyBytes) {
      throw new DesktopBodyLimitError(byteLength, this.limits.maxDesktopBodyBytes)
    }
    if (this.receiving.has(bodyId) || this.completed.has(bodyId)) {
      throw new DesktopProtocolError(`duplicate body ${JSON.stringify(bodyId)}`)
    }
    this.receiving.set(bodyId, {
      expectedBytes: byteLength,
      chunks: [],
      nextSequence: 0,
      receivedBytes: 0,
    })
  }

  private chunk(bodyId: DesktopBodyIdType, sequence: number, chunk: Uint8Array): void {
    const body = this.receiving.get(bodyId)
    if (body === undefined) throw new DesktopProtocolError(`chunk for unknown body ${JSON.stringify(bodyId)}`)
    if (sequence !== body.nextSequence) {
      throw new DesktopProtocolError(
        `body ${JSON.stringify(bodyId)} expected sequence ${String(body.nextSequence)}, got ${String(sequence)}`,
      )
    }
    if (chunk.byteLength === 0 || chunk.byteLength > this.limits.maxDesktopChunkBytes) {
      throw new DesktopProtocolError(`body chunk has invalid byte length ${String(chunk.byteLength)}`)
    }
    if (body.receivedBytes + chunk.byteLength > body.expectedBytes) {
      throw new DesktopProtocolError(`body ${JSON.stringify(bodyId)} exceeds its declared byte length`)
    }
    body.chunks.push(chunk.slice())
    body.receivedBytes += chunk.byteLength
    body.nextSequence += 1
    this.sendFrame({
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'body-ack',
      bodyId,
      sequence,
      byteLength: chunk.byteLength,
    })
  }

  private end(bodyId: DesktopBodyIdType): void {
    const body = this.receiving.get(bodyId)
    if (body === undefined) throw new DesktopProtocolError(`end for unknown body ${JSON.stringify(bodyId)}`)
    if (body.receivedBytes !== body.expectedBytes) {
      throw new DesktopProtocolError(
        `body ${JSON.stringify(bodyId)} ended at ${String(body.receivedBytes)} of ${String(body.expectedBytes)} bytes`,
      )
    }
    this.receiving.delete(bodyId)
    const bytes = new Uint8Array(body.receivedBytes)
    let offset = 0
    for (const chunk of body.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    this.completed.set(bodyId, decodeJson(bytes))
  }

  private acknowledge(bodyId: DesktopBodyIdType, sequence: number, byteLength: number): void {
    const key = acknowledgementKey(bodyId, sequence)
    const pending = this.pending.get(key)
    if (pending === undefined) {
      throw new DesktopProtocolError(`unexpected acknowledgement for ${JSON.stringify(key)}`)
    }
    if (pending.byteLength !== byteLength) {
      throw new DesktopProtocolError(
        `acknowledgement for ${JSON.stringify(key)} has byte length ${String(byteLength)}`,
      )
    }
    this.pending.delete(key)
    pending.release()
    pending.resolve()
  }

  private rejectAcknowledgement(key: string, error: unknown): void {
    const pending = this.pending.get(key)
    if (pending === undefined) return
    this.pending.delete(key)
    pending.release()
    pending.reject(error)
  }

  private cancelSentBody(bodyId: DesktopBodyIdType, error: unknown): void {
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(`${bodyId}:`)) this.rejectAcknowledgement(key, error)
    }
    try {
      this.sendFrame({ version: DESKTOP_CONNECTION_PROTOCOL_VERSION, type: 'body-cancel', bodyId })
    } catch {
      // A failed send means the peer cannot observe cancellation.
    }
  }

  private cancelPendingAcknowledgements(bodyId: DesktopBodyIdType): void {
    const error = new DesktopProtocolError(`peer cancelled body ${JSON.stringify(bodyId)}`)
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(`${bodyId}:`)) this.rejectAcknowledgement(key, error)
    }
  }

  private throwIfTerminal(): void {
    if (this.terminalError !== undefined) throw this.terminalError
  }
}

/**
 * Parse a physical body frame without accepting inline application payloads.
 * @param value - untrusted child-IPC value.
 * @returns validated frame, or undefined when the value is not a body frame.
 */
export function parseDesktopBodyFrame(value: unknown): DesktopBodyFrame | undefined {
  if (!isRecord(value) || value.version !== DESKTOP_CONNECTION_PROTOCOL_VERSION
    || typeof value.type !== 'string' || !value.type.startsWith('body-')) return undefined
  if (typeof value.bodyId !== 'string' || value.bodyId === '') {
    throw new DesktopProtocolError('body frame has no non-empty bodyId')
  }
  const bodyId = DesktopBodyId(value.bodyId)
  switch (value.type) {
    case 'body-start':
      if (!hasOnlyKeys(value, ['version', 'type', 'bodyId', 'byteLength']) || !isNatural(value.byteLength)) {
        throw new DesktopProtocolError('body-start has invalid fields')
      }
      return { version: 1, type: value.type, bodyId, byteLength: value.byteLength }
    case 'body-chunk':
      if (!hasOnlyKeys(value, ['version', 'type', 'bodyId', 'sequence', 'chunk'])
        || !isNatural(value.sequence) || !(value.chunk instanceof Uint8Array)) {
        throw new DesktopProtocolError('body-chunk has invalid fields')
      }
      return { version: 1, type: value.type, bodyId, sequence: value.sequence, chunk: value.chunk }
    case 'body-ack':
      if (!hasOnlyKeys(value, ['version', 'type', 'bodyId', 'sequence', 'byteLength'])
        || !isNatural(value.sequence) || !isNatural(value.byteLength)) {
        throw new DesktopProtocolError('body-ack has invalid fields')
      }
      return {
        version: 1,
        type: value.type,
        bodyId,
        sequence: value.sequence,
        byteLength: value.byteLength,
      }
    case 'body-end':
    case 'body-cancel':
      if (!hasOnlyKeys(value, ['version', 'type', 'bodyId'])) {
        throw new DesktopProtocolError(`${value.type} has invalid fields`)
      }
      return { version: 1, type: value.type, bodyId }
    default:
      throw new DesktopProtocolError(`unknown body frame type ${JSON.stringify(value.type)}`)
  }
}

function encodeJson(value: unknown): Uint8Array {
  const stringify: (input: unknown) => string | undefined = JSON.stringify
  const json = stringify(value)
  if (json === undefined) throw new DesktopProtocolError('body value is not JSON serializable')
  return new TextEncoder().encode(json)
}

function decodeJson(bytes: Uint8Array): unknown {
  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new DesktopProtocolError(`body is not valid UTF-8: ${String(error)}`)
  }
  try {
    return JSON.parse(json) as unknown
  } catch {
    throw new DesktopProtocolError('body is not valid JSON')
  }
}

function acknowledgementKey(bodyId: DesktopBodyIdType, sequence: number): string {
  return `${bodyId}:${String(sequence)}`
}

function isNatural(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop operation aborted')
}

function waitForAcknowledgements(
  acknowledgements: readonly Promise<void>[],
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) return Promise.all(acknowledgements).then(() => undefined)
  if (signal.aborted) return Promise.reject(abortReason(signal))
  const completed = Promise.all(acknowledgements).then(() => undefined)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => { finish(() => { reject(abortReason(signal)) }) }
    signal.addEventListener('abort', onAbort, { once: true })
    void completed.then(
      () => { finish(resolve) },
      (error: unknown) => { finish(() => { reject(normalizeError(error)) }) },
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortReason(signal)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const accepted = new Set(keys)
  return Object.keys(value).every(key => accepted.has(key))
}
