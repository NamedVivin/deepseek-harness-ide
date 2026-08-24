/** Credit-bounded byte streams and correlated JSON calls over one Node IPC message endpoint. */

import { randomUUID } from 'node:crypto'
import {
  GUARDIAN_ACTIVE_STREAM_LIMIT,
  GUARDIAN_PROTOCOL_NAMESPACE,
  GUARDIAN_PROTOCOL_VERSION,
  GuardianCallId,
  GuardianProtocolError,
  GuardianStreamId,
  parseGuardianFrame,
  type GuardianCallId as GuardianCallIdType,
  type GuardianFrame,
  type GuardianOperation,
  type GuardianProcessId,
  type GuardianProtocolLimits,
  type GuardianSettlement,
  type GuardianStreamId as GuardianStreamIdType,
  type GuardianWireError,
} from './protocol.ts'

/** Physical message endpoint shared with the desktop connection carrier. */
export interface GuardianMessageEndpoint {
  /** Queue one frame and settle after Node accepts or rejects the send. */
  send(frame: GuardianFrame): Promise<void>
  /** Subscribe to untrusted incoming messages. */
  onMessage(listener: (value: unknown) => void): () => void
  /** Subscribe to physical peer loss. */
  onDisconnect(listener: () => void): () => void
}

/** Minimal Node child IPC face implemented by a child `process` or parent `ChildProcess`. */
export interface NodeGuardianIpcProcess {
  readonly connected?: boolean
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (value: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

/**
 * Adapt Node child IPC without taking ownership of the shared physical channel.
 * @param target - sidecar `process` or guardian-side `ChildProcess` face.
 * @returns guardian endpoint whose listeners can be removed independently.
 */
export function createNodeGuardianEndpoint(target: NodeGuardianIpcProcess): GuardianMessageEndpoint {
  if (typeof target.send !== 'function' || target.connected === false) {
    throw disconnectedError('subprocess-guardian: a connected Node child IPC channel is required')
  }
  return {
    send: frame => new Promise<void>((resolve, reject) => {
      if (target.connected === false || target.send === undefined) {
        reject(disconnectedError())
        return
      }
      target.send(frame, (error) => {
        if (error === null) resolve()
        else reject(error)
      })
    }),
    onMessage: (listener) => {
      target.on('message', listener)
      return () => { target.off('message', listener) }
    },
    onDisconnect: (listener) => {
      target.on('disconnect', listener)
      return () => { target.off('disconnect', listener) }
    },
  }
}

/** Receiver for one framed byte stream. An acknowledgement follows each completed write. */
export interface GuardianByteSink {
  /** Accept one validated chunk in sequence. */
  write(chunk: Buffer): void | Promise<void>
  /** Finish after every accepted write settles. */
  end(): void | Promise<void>
  /** Cancel and release retained resources. */
  fail(error: Error): void | Promise<void>
}

/** Outgoing framed byte stream with acknowledgement-backed writes. */
export interface GuardianByteWriter {
  /** Send bytes, splitting them at the negotiated chunk bound. */
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>
  /** Send the exact terminal sequence after prior writes are acknowledged. */
  end(): Promise<void>
  /** Cancel the stream and reject unacknowledged writes. */
  cancel(error?: Error): Promise<void>
}

/** Result of one incoming JSON call. `afterReply` runs only after its success body is acknowledged. */
export interface GuardianCallResult {
  readonly value: unknown
  readonly afterReply?: (() => void | Promise<void>) | undefined
}

/** Handler for validated and decoded guardian JSON call bodies. */
export type GuardianCallHandler = (
  operation: GuardianOperation,
  body: unknown,
  signal: AbortSignal,
) => Promise<GuardianCallResult>

interface IncomingStream {
  readonly sink: GuardianByteSink
  readonly expectedBytes: number | undefined
  readonly complete: PromiseWithResolvers<void>
  sequence: number
  receivedBytes: number
  chain: Promise<void>
}

interface OutgoingStream {
  sequence: number
  ended: boolean
  canceled: Error | undefined
  chain: Promise<void>
}

interface PendingAck {
  readonly bytes: number
  readonly streamId: GuardianStreamIdType
  readonly deferred: PromiseWithResolvers<void>
}

interface PendingCall {
  readonly deferred: PromiseWithResolvers<unknown>
  readonly removeAbort: () => void
  responseStreamId: GuardianStreamIdType | undefined
}

interface IncomingCall {
  readonly controller: AbortController
}

/**
 * Symmetric guardian peer. It multiplexes bounded JSON bodies and stdio byte streams while enforcing one
 * hop-wide unacknowledged-byte budget across all outgoing streams.
 */
export class FramedGuardianPeer {
  private readonly incomingStreams = new Map<GuardianStreamIdType, IncomingStream>()
  private readonly outgoingStreams = new Map<GuardianStreamIdType, OutgoingStream>()
  private readonly pendingAcks = new Map<string, PendingAck>()
  private readonly pendingCalls = new Map<GuardianCallIdType, PendingCall>()
  private readonly incomingCalls = new Map<GuardianCallIdType, IncomingCall>()
  private readonly creditWaiters = new Set<PromiseWithResolvers<void>>()
  private readonly work = new Set<Promise<void>>()
  private readonly settlementListeners = new Set<(processId: GuardianProcessId, value: GuardianSettlement) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private readonly removeMessage: () => void
  private readonly removeDisconnect: () => void
  private inflightBytes = 0
  private closedError: Error | undefined
  private handler: GuardianCallHandler | undefined

  /** @param endpoint - physical child-IPC endpoint. @param limits - mandatory negotiated bounds. */
  constructor(
    private readonly endpoint: GuardianMessageEndpoint,
    private readonly limits: GuardianProtocolLimits,
  ) {
    this.removeMessage = endpoint.onMessage((value) => { this.receive(value) })
    this.removeDisconnect = endpoint.onDisconnect(() => {
      void this.shutdown(disconnectedError())
    })
  }

  /**
   * Install the sole incoming call handler.
   * @param handler - guardian runtime dispatcher.
   * @returns disposer removing the handler without closing the peer.
   */
  handleCalls(handler: GuardianCallHandler): () => void {
    if (this.handler !== undefined) throw new Error('subprocess-guardian: call handler already installed')
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = undefined
    }
  }

  /**
   * Invoke one guardian operation with a bounded JSON body.
   * @param operation - closed operation name.
   * @param body - JSON-serializable request body.
   * @param signal - optional cancellation propagated to the remote handler.
   * @returns decoded JSON result.
   */
  async call(operation: GuardianOperation, body: unknown, signal?: AbortSignal): Promise<unknown> {
    this.requireOpen()
    signal?.throwIfAborted()
    const bytes = encodeBody(body, this.limits.maxBodyBytes)
    const callId = GuardianCallId(randomUUID())
    const bodyStreamId = GuardianStreamId(randomUUID())
    const deferred = Promise.withResolvers<unknown>()
    void deferred.promise.catch(() => undefined)
    const onAbort = (): void => {
      if (!this.pendingCalls.delete(callId)) return
      void this.safeSend(frame({ type: 'call-cancel', callId }))
      deferred.reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    this.pendingCalls.set(callId, {
      deferred,
      removeAbort: () => { signal?.removeEventListener('abort', onAbort) },
      responseStreamId: undefined,
    })
    try {
      await this.endpoint.send(frame({
        type: 'call',
        callId,
        operation,
        bodyStreamId,
        bodyBytes: bytes.length,
      }))
      const writer = this.createWriter(bodyStreamId)
      await writer.write(bytes, signal)
      await writer.end()
    } catch (error) {
      const pending = this.pendingCalls.get(callId)
      if (pending !== undefined) {
        this.pendingCalls.delete(callId)
        pending.removeAbort()
        pending.deferred.reject(error)
      }
    }
    return deferred.promise
  }

  /**
   * Reserve one incoming stdio stream before the remote process can resume.
   * @param streamId - sender-minted stream id returned by spawn preparation.
   * @param sink - bounded consumer or caller-owned readable proxy.
   * @returns promise settling after end or rejecting on cancellation.
   */
  acceptStream(streamId: GuardianStreamIdType, sink: GuardianByteSink): Promise<void> {
    return this.addIncomingStream(streamId, sink, undefined)
  }

  /**
   * Create one outgoing stdio stream.
   * @param streamId - sender-minted stream id published during spawn preparation.
   * @returns acknowledgement-backed writer.
   */
  createWriter(streamId: GuardianStreamIdType): GuardianByteWriter {
    this.requireOpen()
    if (this.outgoingStreams.has(streamId)) throw new Error(`subprocess-guardian: duplicate outgoing stream ${streamId}`)
    const state: OutgoingStream = { sequence: 0, ended: false, canceled: undefined, chain: Promise.resolve() }
    this.outgoingStreams.set(streamId, state)
    return {
      write: (data, signal) => this.queueWrite(streamId, state, Buffer.from(data), signal),
      end: () => this.queueEnd(streamId, state),
      cancel: error => this.cancelOutgoing(streamId, state, error ?? new Error('guardian byte stream cancelled')),
    }
  }

  /**
   * Register a process-settlement listener; listener exceptions remain contained.
   * @param listener - callback receiving one terminal owned-process result.
   * @returns disposer removing this listener.
   */
  onProcessSettled(listener: (processId: GuardianProcessId, value: GuardianSettlement) => void): () => void {
    this.settlementListeners.add(listener)
    return () => { this.settlementListeners.delete(listener) }
  }

  /**
   * Register a one-shot logical peer-loss listener.
   * @param listener - callback receiving the terminal peer error.
   * @returns disposer removing this listener.
   */
  onClosed(listener: (error: Error) => void): () => void {
    if (this.closedError !== undefined) {
      listener(this.closedError)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /**
   * Send one process settlement after its output pumps have terminated.
   * @param processId - guardian-owned process correlation id.
   * @param settlement - terminal outcome or transport failure.
   */
  sendProcessSettled(processId: GuardianProcessId, settlement: GuardianSettlement): Promise<void> {
    return this.endpoint.send(frame({ type: 'process-settled', processId, settlement }))
  }

  /**
   * Close logical guardian state and await all already-scheduled sink/call work.
   * @param reason - terminal error propagated to pending work.
   */
  dispose(reason = new Error('subprocess-guardian: peer disposed')): Promise<void> {
    return this.shutdown(reason)
  }

  private receive(value: unknown): void {
    if (this.closedError !== undefined) return
    let incoming: GuardianFrame | undefined
    try {
      incoming = parseGuardianFrame(value, this.limits)
      if (incoming === undefined) return
      this.route(incoming)
    } catch (error) {
      void this.shutdown(asError(error))
    }
  }

  private route(incoming: GuardianFrame): void {
    switch (incoming.type) {
      case 'call':
        this.receiveCall(incoming)
        return
      case 'call-cancel':
        this.incomingCalls.get(incoming.callId)?.controller.abort(new Error('guardian call cancelled by peer'))
        return
      case 'result':
        this.receiveResult(incoming)
        return
      case 'failure':
        this.receiveFailure(incoming.callId, incoming.error)
        return
      case 'chunk':
        this.receiveChunk(incoming.streamId, incoming.sequence, incoming.data)
        return
      case 'ack':
        this.receiveAck(incoming.streamId, incoming.sequence, incoming.bytes)
        return
      case 'end':
        this.receiveEnd(incoming.streamId, incoming.sequence)
        return
      case 'stream-cancel':
        this.receiveCancel(incoming.streamId, errorFromWire(incoming.error))
        return
      case 'process-settled':
        for (const listener of this.settlementListeners) {
          try {
            listener(incoming.processId, incoming.settlement)
          } catch {
            // One consumer callback cannot starve other process-settlement listeners.
          }
        }
        return
    }
  }

  private receiveCall(incoming: Extract<GuardianFrame, { type: 'call' }>): void {
    if (this.incomingCalls.has(incoming.callId)) throw new GuardianProtocolError('subprocess-guardian: duplicate call id')
    const controller = new AbortController()
    this.incomingCalls.set(incoming.callId, { controller })
    const body = bodySink(incoming.bodyBytes)
    const complete = this.addIncomingStream(incoming.bodyStreamId, body.sink, incoming.bodyBytes)
    const work = complete.then(async () => {
      const handler = this.handler
      if (handler === undefined) throw badRequest('subprocess-guardian: no call handler is installed')
      const result = await handler(incoming.operation, decodeBody(body.bytes()), controller.signal)
      const encoded = encodeBody(result.value, this.limits.maxBodyBytes)
      const bodyStreamId = GuardianStreamId(randomUUID())
      await this.endpoint.send(frame({
        type: 'result',
        callId: incoming.callId,
        bodyStreamId,
        bodyBytes: encoded.length,
      }))
      const writer = this.createWriter(bodyStreamId)
      await writer.write(encoded, controller.signal)
      await writer.end()
      await result.afterReply?.()
    }).catch(async (error: unknown) => {
      await this.safeSend(frame({ type: 'failure', callId: incoming.callId, error: toWireError(error, controller.signal) }))
    }).finally(() => {
      this.incomingCalls.delete(incoming.callId)
    })
    this.track(work)
  }

  private receiveResult(incoming: Extract<GuardianFrame, { type: 'result' }>): void {
    const pending = this.pendingCalls.get(incoming.callId)
    if (pending === undefined || pending.responseStreamId !== undefined) {
      void this.safeSend(frame({
        type: 'stream-cancel',
        streamId: incoming.bodyStreamId,
        error: { code: 'bad-request', message: 'unknown or duplicate guardian result' },
      }))
      return
    }
    pending.responseStreamId = incoming.bodyStreamId
    const body = bodySink(incoming.bodyBytes)
    const complete = this.addIncomingStream(incoming.bodyStreamId, body.sink, incoming.bodyBytes)
    const work = complete.then(() => {
      if (!this.pendingCalls.delete(incoming.callId)) return
      pending.removeAbort()
      pending.deferred.resolve(decodeBody(body.bytes()))
    }, (error: unknown) => {
      if (!this.pendingCalls.delete(incoming.callId)) return
      pending.removeAbort()
      pending.deferred.reject(error)
    })
    this.track(work)
  }

  private receiveFailure(callId: GuardianCallIdType, error: GuardianWireError): void {
    const pending = this.pendingCalls.get(callId)
    if (pending === undefined) return
    this.pendingCalls.delete(callId)
    pending.removeAbort()
    pending.deferred.reject(errorFromWire(error))
  }

  private addIncomingStream(
    streamId: GuardianStreamIdType,
    sink: GuardianByteSink,
    expectedBytes: number | undefined,
  ): Promise<void> {
    this.requireOpen()
    if (this.incomingStreams.size >= GUARDIAN_ACTIVE_STREAM_LIMIT) {
      throw new GuardianProtocolError('subprocess-guardian: active incoming stream limit exceeded')
    }
    if (this.incomingStreams.has(streamId)) throw new GuardianProtocolError(`subprocess-guardian: duplicate incoming stream ${streamId}`)
    const complete = Promise.withResolvers<void>()
    void complete.promise.catch(() => undefined)
    this.incomingStreams.set(streamId, {
      sink,
      expectedBytes,
      complete,
      sequence: 0,
      receivedBytes: 0,
      chain: Promise.resolve(),
    })
    return complete.promise
  }

  private receiveChunk(streamId: GuardianStreamIdType, sequence: number, data: Buffer): void {
    const state = this.incomingStreams.get(streamId)
    if (state === undefined) throw new GuardianProtocolError(`subprocess-guardian: chunk for unknown stream ${streamId}`)
    if (sequence !== state.sequence) throw new GuardianProtocolError(`subprocess-guardian: out-of-order chunk for stream ${streamId}`)
    state.sequence += 1
    state.receivedBytes += data.length
    if (state.expectedBytes !== undefined && state.receivedBytes > state.expectedBytes) {
      throw new GuardianProtocolError(`subprocess-guardian: stream ${streamId} exceeded its declared byte length`)
    }
    state.chain = state.chain.then(async () => {
      await state.sink.write(data)
      await this.endpoint.send(frame({ type: 'ack', streamId, sequence, bytes: data.length }))
    }).catch(async (error: unknown) => {
      this.incomingStreams.delete(streamId)
      await Promise.resolve(state.sink.fail(asError(error))).catch(() => undefined)
      state.complete.reject(error)
      await this.safeSend(frame({ type: 'stream-cancel', streamId, error: toWireError(error) }))
    })
  }

  private receiveEnd(streamId: GuardianStreamIdType, sequence: number): void {
    const state = this.incomingStreams.get(streamId)
    if (state === undefined) throw new GuardianProtocolError(`subprocess-guardian: end for unknown stream ${streamId}`)
    if (sequence !== state.sequence || state.expectedBytes !== undefined && state.receivedBytes !== state.expectedBytes) {
      throw new GuardianProtocolError(`subprocess-guardian: invalid terminal sequence or length for stream ${streamId}`)
    }
    this.incomingStreams.delete(streamId)
    state.chain = state.chain.then(async () => {
      await state.sink.end()
      state.complete.resolve()
    }).catch((error: unknown) => {
      state.complete.reject(error)
    })
    this.track(state.chain)
  }

  private receiveCancel(streamId: GuardianStreamIdType, error: Error): void {
    const incoming = this.incomingStreams.get(streamId)
    if (incoming !== undefined) {
      this.incomingStreams.delete(streamId)
      this.failIncomingStream(incoming, error)
    }
    const outgoing = this.outgoingStreams.get(streamId)
    if (outgoing !== undefined) {
      outgoing.canceled = error
      this.outgoingStreams.delete(streamId)
      this.rejectAcksForStream(streamId, error)
    }
  }

  private receiveAck(streamId: GuardianStreamIdType, sequence: number, bytes: number): void {
    const key = ackKey(streamId, sequence)
    const pending = this.pendingAcks.get(key)
    if (pending === undefined || pending.bytes !== bytes) {
      throw new GuardianProtocolError(`subprocess-guardian: invalid acknowledgement for stream ${streamId}`)
    }
    this.pendingAcks.delete(key)
    this.inflightBytes -= pending.bytes
    pending.deferred.resolve()
    this.wakeCreditWaiters()
  }

  private queueWrite(
    streamId: GuardianStreamIdType,
    state: OutgoingStream,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    if (data.length === 0) return state.chain
    state.chain = state.chain.then(async () => {
      this.requireWritable(state)
      signal?.throwIfAborted()
      for (let offset = 0; offset < data.length; offset += this.limits.maxChunkBytes) {
        const chunk = data.subarray(offset, Math.min(data.length, offset + this.limits.maxChunkBytes))
        await this.sendChunk(streamId, state, chunk, signal)
      }
    })
    return state.chain
  }

  private queueEnd(streamId: GuardianStreamIdType, state: OutgoingStream): Promise<void> {
    state.chain = state.chain.then(async () => {
      this.requireWritable(state)
      state.ended = true
      await this.endpoint.send(frame({ type: 'end', streamId, sequence: state.sequence }))
      this.outgoingStreams.delete(streamId)
    })
    return state.chain
  }

  private async sendChunk(
    streamId: GuardianStreamIdType,
    state: OutgoingStream,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.reserveCredit(data.length, signal)
    const sequence = state.sequence++
    const deferred = Promise.withResolvers<void>()
    void deferred.promise.catch(() => undefined)
    const key = ackKey(streamId, sequence)
    this.pendingAcks.set(key, { bytes: data.length, streamId, deferred })
    this.inflightBytes += data.length
    try {
      await this.endpoint.send(frame({ type: 'chunk', streamId, sequence, data }))
    } catch (error) {
      if (this.pendingAcks.delete(key)) {
        this.inflightBytes -= data.length
        deferred.reject(error)
        this.wakeCreditWaiters()
      }
      throw error
    }
    await deferred.promise
  }

  private async reserveCredit(bytes: number, signal?: AbortSignal): Promise<void> {
    while (this.inflightBytes + bytes > this.limits.maxInflightBytes) {
      this.requireOpen()
      signal?.throwIfAborted()
      const waiter = Promise.withResolvers<void>()
      this.creditWaiters.add(waiter)
      const onAbort = (): void => { waiter.reject(abortError(signal)) }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await waiter.promise
      } finally {
        signal?.removeEventListener('abort', onAbort)
        this.creditWaiters.delete(waiter)
      }
    }
  }

  private cancelOutgoing(streamId: GuardianStreamIdType, state: OutgoingStream, error: Error): Promise<void> {
    if (state.canceled !== undefined || state.ended) return state.chain
    state.canceled = error
    this.outgoingStreams.delete(streamId)
    this.rejectAcksForStream(streamId, error)
    return this.safeSend(frame({ type: 'stream-cancel', streamId, error: toWireError(error) }))
  }

  private rejectAcksForStream(streamId: GuardianStreamIdType, error: Error): void {
    for (const [key, pending] of this.pendingAcks) {
      if (pending.streamId !== streamId) continue
      this.pendingAcks.delete(key)
      this.inflightBytes -= pending.bytes
      pending.deferred.reject(error)
    }
    this.wakeCreditWaiters()
  }

  private requireWritable(state: OutgoingStream): void {
    this.requireOpen()
    if (state.canceled !== undefined) throw state.canceled
    if (state.ended) throw new Error('subprocess-guardian: byte stream already ended')
  }

  private requireOpen(): void {
    if (this.closedError !== undefined) throw this.closedError
  }

  private wakeCreditWaiters(): void {
    for (const waiter of this.creditWaiters) waiter.resolve()
    this.creditWaiters.clear()
  }

  private safeSend(value: GuardianFrame): Promise<void> {
    if (this.closedError !== undefined) return Promise.resolve()
    return this.endpoint.send(value).catch(() => undefined)
  }

  private track(promise: Promise<void>): void {
    this.work.add(promise)
    void promise.finally(() => { this.work.delete(promise) }).catch(() => undefined)
  }

  private failIncomingStream(incoming: IncomingStream, error: Error): void {
    const work = incoming.chain.then(() => incoming.sink.fail(error)).then(
      () => { incoming.complete.reject(error) },
      (sinkError: unknown) => { incoming.complete.reject(sinkError) },
    )
    this.track(work)
  }

  private async shutdown(error: Error): Promise<void> {
    if (this.closedError !== undefined) {
      await Promise.allSettled([...this.work])
      return
    }
    this.closedError = error
    this.removeMessage()
    this.removeDisconnect()
    this.handler = undefined
    this.settlementListeners.clear()
    const closeListeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const listener of closeListeners) {
      try {
        listener(error)
      } catch {
        // Peer loss must reach every lifecycle owner even when one callback throws.
      }
    }
    for (const incoming of this.incomingCalls.values()) incoming.controller.abort(error)
    this.incomingCalls.clear()
    for (const pending of this.pendingCalls.values()) {
      pending.removeAbort()
      pending.deferred.reject(error)
    }
    this.pendingCalls.clear()
    for (const incoming of this.incomingStreams.values()) this.failIncomingStream(incoming, error)
    this.incomingStreams.clear()
    this.outgoingStreams.clear()
    for (const pending of this.pendingAcks.values()) pending.deferred.reject(error)
    this.pendingAcks.clear()
    this.inflightBytes = 0
    for (const waiter of this.creditWaiters) waiter.reject(error)
    this.creditWaiters.clear()
    await Promise.allSettled([...this.work])
  }
}

function frame<T extends Omit<GuardianFrame, 'namespace' | 'version'>>(
  value: T,
): T & { namespace: typeof GUARDIAN_PROTOCOL_NAMESPACE; version: typeof GUARDIAN_PROTOCOL_VERSION } {
  return { namespace: GUARDIAN_PROTOCOL_NAMESPACE, version: GUARDIAN_PROTOCOL_VERSION, ...value }
}

function bodySink(expectedBytes: number): { sink: GuardianByteSink; bytes: () => Buffer } {
  const chunks: Buffer[] = []
  let bytes = 0
  return {
    sink: {
      write: (chunk) => {
        bytes += chunk.length
        if (bytes > expectedBytes) throw new GuardianProtocolError('subprocess-guardian: JSON body exceeded its declared length')
        chunks.push(chunk)
      },
      end: () => {
        if (bytes !== expectedBytes) throw new GuardianProtocolError('subprocess-guardian: JSON body ended before its declared length')
      },
      fail: () => { chunks.length = 0 },
    },
    bytes: () => Buffer.concat(chunks, bytes),
  }
}

function encodeBody(value: unknown, maximum: number): Buffer {
  let json: unknown
  try {
    json = JSON.stringify(value)
  } catch (error) {
    throw new Error(`subprocess-guardian: body is not JSON serializable: ${asError(error).message}`)
  }
  if (typeof json !== 'string') throw new Error('subprocess-guardian: body is not JSON serializable')
  const bytes = Buffer.from(json)
  if (bytes.length > maximum) throw new Error(`subprocess-guardian: JSON body exceeds ${maximum} bytes`)
  return bytes
}

function decodeBody(value: Buffer): unknown {
  try {
    return JSON.parse(value.toString('utf8')) as unknown
  } catch {
    throw new GuardianProtocolError('subprocess-guardian: invalid JSON body')
  }
}

function ackKey(streamId: GuardianStreamIdType, sequence: number): string {
  return `${streamId}\u0000${sequence}`
}

function toWireError(error: unknown, signal?: AbortSignal): GuardianWireError {
  if (signal?.aborted === true) return { code: 'aborted', message: 'guardian operation aborted' }
  if (error instanceof GuardianProtocolError) return { code: 'bad-request', message: error.message }
  return { code: 'internal', message: asError(error).message.slice(0, 4096) || 'guardian operation failed' }
}

function errorFromWire(value: GuardianWireError): Error {
  const error = new Error(value.message)
  error.name = `Guardian${value.code.split('-').map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('')}Error`
  return error
}

function badRequest(message: string): GuardianProtocolError {
  return new GuardianProtocolError(message)
}

function disconnectedError(message = 'subprocess-guardian: IPC peer disconnected'): Error {
  const error = new Error(message)
  error.name = 'GuardianDisconnectedError'
  return error
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('guardian operation aborted')
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
