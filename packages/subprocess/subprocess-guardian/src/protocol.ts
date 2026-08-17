/** Versioned guardian child-IPC frames and hostile-input validation. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** Guardian protocol namespace; unrelated messages on the shared child IPC channel are ignored. */
export const GUARDIAN_PROTOCOL_NAMESPACE = 'dsh.guardian' as const
/** Current guardian protocol version. */
export const GUARDIAN_PROTOCOL_VERSION = 1 as const
/** Fixed active-stream limit protecting the control plane from empty-stream exhaustion. */
export const GUARDIAN_ACTIVE_STREAM_LIMIT = 1024

/** Correlation id minted by the caller of one guardian operation. */
export type GuardianCallId = Branded<'GuardianCallId'>
/** Byte-stream id minted by its sender. */
export type GuardianStreamId = Branded<'GuardianStreamId'>
/** Guardian-owned process id, distinct from an operating-system pid. */
export type GuardianProcessId = Branded<'GuardianProcessId'>

/**
 * Brand a validated guardian-call wire identifier.
 * @param value - validated wire id.
 * @returns branded guardian call id.
 */
export const GuardianCallId = (value: string): GuardianCallId => value as GuardianCallId
/**
 * Brand a validated guardian-stream wire identifier.
 * @param value - validated wire id.
 * @returns branded guardian stream id.
 */
export const GuardianStreamId = (value: string): GuardianStreamId => value as GuardianStreamId
/**
 * Brand a validated guardian-owned process identifier.
 * @param value - validated wire id.
 * @returns branded guardian process id.
 */
export const GuardianProcessId = (value: string): GuardianProcessId => value as GuardianProcessId

/** Calls accepted by the guardian runtime. */
export type GuardianOperation =
  | 'resolve-executable'
  | 'spawn-prepare'
  | 'spawn-resume'
  | 'process-terminate'
  | 'process-wait'
  | 'process-release'

/** Stable error sent across the guardian hop. */
export interface GuardianWireError {
  readonly code: 'aborted' | 'bad-request' | 'disconnected' | 'internal' | 'not-supported'
  readonly message: string
}

/** Success/error process settlement sent after output streams have ended. */
export type GuardianSettlement =
  | { readonly ok: true; readonly outcome: SubprocessOutcome }
  | { readonly ok: false; readonly error: GuardianWireError }

interface GuardianFrameBase {
  readonly namespace: typeof GUARDIAN_PROTOCOL_NAMESPACE
  readonly version: typeof GUARDIAN_PROTOCOL_VERSION
}

/** One bounded guardian child-IPC frame. */
export type GuardianFrame =
  | GuardianFrameBase & {
    readonly type: 'call'
    readonly callId: GuardianCallId
    readonly operation: GuardianOperation
    readonly bodyStreamId: GuardianStreamId
    readonly bodyBytes: number
  }
  | GuardianFrameBase & {
    readonly type: 'call-cancel'
    readonly callId: GuardianCallId
  }
  | GuardianFrameBase & {
    readonly type: 'result'
    readonly callId: GuardianCallId
    readonly bodyStreamId: GuardianStreamId
    readonly bodyBytes: number
  }
  | GuardianFrameBase & {
    readonly type: 'failure'
    readonly callId: GuardianCallId
    readonly error: GuardianWireError
  }
  | GuardianFrameBase & {
    readonly type: 'chunk'
    readonly streamId: GuardianStreamId
    readonly sequence: number
    readonly data: Buffer
  }
  | GuardianFrameBase & {
    readonly type: 'ack'
    readonly streamId: GuardianStreamId
    readonly sequence: number
    readonly bytes: number
  }
  | GuardianFrameBase & {
    readonly type: 'end'
    readonly streamId: GuardianStreamId
    readonly sequence: number
  }
  | GuardianFrameBase & {
    readonly type: 'stream-cancel'
    readonly streamId: GuardianStreamId
    readonly error: GuardianWireError
  }
  | GuardianFrameBase & {
    readonly type: 'process-settled'
    readonly processId: GuardianProcessId
    readonly settlement: GuardianSettlement
  }

/** Runtime limits required by both peers before the first frame is accepted. */
export interface GuardianProtocolLimits {
  /** Maximum complete JSON request or result body. */
  readonly maxBodyBytes: number
  /** Maximum bytes in one `chunk` frame. */
  readonly maxChunkBytes: number
  /** Maximum unacknowledged chunk bytes across every concurrent stream. */
  readonly maxInflightBytes: number
}

/** A matching guardian frame violated wire validation. */
export class GuardianProtocolError extends Error {
  override readonly name = 'GuardianProtocolError'
}

/**
 * Validate transport limits before listeners are installed.
 * @param limits - body, chunk, and hop-wide credit limits.
 * @returns the unchanged validated limits.
 */
export function validateGuardianProtocolLimits(limits: GuardianProtocolLimits): GuardianProtocolLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`subprocess-guardian: ${name} must be a positive safe integer`)
    }
  }
  if (limits.maxChunkBytes > limits.maxInflightBytes) {
    throw new Error('subprocess-guardian: maxChunkBytes must not exceed maxInflightBytes')
  }
  return limits
}

/**
 * Parse one value received at the Node IPC trust boundary. Non-guardian messages are ignored.
 * @param value - untrusted child-IPC message.
 * @param limits - negotiated local receive limits.
 * @returns a validated frame, or undefined for another protocol namespace.
 */
export function parseGuardianFrame(
  value: unknown,
  limits: GuardianProtocolLimits,
): GuardianFrame | undefined {
  if (!isRecord(value) || value.namespace !== GUARDIAN_PROTOCOL_NAMESPACE) return undefined
  if (value.version !== GUARDIAN_PROTOCOL_VERSION || typeof value.type !== 'string') {
    throw new GuardianProtocolError('subprocess-guardian: unsupported or malformed guardian frame')
  }
  const base = { namespace: GUARDIAN_PROTOCOL_NAMESPACE, version: GUARDIAN_PROTOCOL_VERSION }
  switch (value.type) {
    case 'call': {
      const bodyBytes = requireBoundedBytes(value.bodyBytes, limits.maxBodyBytes, 'call body')
      return {
        ...base,
        type: value.type,
        callId: requireCallId(value.callId),
        operation: requireOperation(value.operation),
        bodyStreamId: requireStreamId(value.bodyStreamId),
        bodyBytes,
      }
    }
    case 'call-cancel':
      return { ...base, type: value.type, callId: requireCallId(value.callId) }
    case 'result': {
      const bodyBytes = requireBoundedBytes(value.bodyBytes, limits.maxBodyBytes, 'result body')
      return {
        ...base,
        type: value.type,
        callId: requireCallId(value.callId),
        bodyStreamId: requireStreamId(value.bodyStreamId),
        bodyBytes,
      }
    }
    case 'failure':
      return { ...base, type: value.type, callId: requireCallId(value.callId), error: requireWireError(value.error) }
    case 'chunk': {
      const streamId = requireStreamId(value.streamId)
      const sequence = requireSequence(value.sequence)
      if (!(value.data instanceof Uint8Array) || value.data.byteLength === 0
        || value.data.byteLength > limits.maxChunkBytes) {
        throw new GuardianProtocolError('subprocess-guardian: chunk data exceeds the negotiated bound')
      }
      return { ...base, type: value.type, streamId, sequence, data: Buffer.from(value.data) }
    }
    case 'ack': {
      const bytes = requireBoundedBytes(value.bytes, limits.maxChunkBytes, 'acknowledgement')
      if (bytes === 0) throw new GuardianProtocolError('subprocess-guardian: acknowledgement bytes must be positive')
      return {
        ...base,
        type: value.type,
        streamId: requireStreamId(value.streamId),
        sequence: requireSequence(value.sequence),
        bytes,
      }
    }
    case 'end':
      return {
        ...base,
        type: value.type,
        streamId: requireStreamId(value.streamId),
        sequence: requireSequence(value.sequence),
      }
    case 'stream-cancel':
      return {
        ...base,
        type: value.type,
        streamId: requireStreamId(value.streamId),
        error: requireWireError(value.error),
      }
    case 'process-settled':
      return {
        ...base,
        type: value.type,
        processId: requireProcessId(value.processId),
        settlement: requireSettlement(value.settlement),
      }
    default:
      throw new GuardianProtocolError(`subprocess-guardian: unknown guardian frame type ${JSON.stringify(value.type)}`)
  }
}

function requireOperation(value: unknown): GuardianOperation {
  if (value === 'resolve-executable' || value === 'spawn-prepare' || value === 'spawn-resume'
    || value === 'process-terminate' || value === 'process-wait' || value === 'process-release') return value
  throw new GuardianProtocolError('subprocess-guardian: invalid guardian operation')
}

function requireCallId(value: unknown): GuardianCallId {
  return GuardianCallId(requireId(value, 'call'))
}

function requireStreamId(value: unknown): GuardianStreamId {
  return GuardianStreamId(requireId(value, 'stream'))
}

function requireProcessId(value: unknown): GuardianProcessId {
  return GuardianProcessId(requireId(value, 'process'))
}

function requireId(value: unknown, kind: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new GuardianProtocolError(`subprocess-guardian: invalid ${kind} id`)
  }
  return value
}

function requireSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GuardianProtocolError('subprocess-guardian: invalid stream sequence')
  }
  return value as number
}

function requireBoundedBytes(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new GuardianProtocolError(`subprocess-guardian: ${label} exceeds the negotiated bound`)
  }
  return value as number
}

function requireWireError(value: unknown): GuardianWireError {
  if (!isRecord(value) || !isErrorCode(value.code) || typeof value.message !== 'string'
    || value.message.length === 0 || Buffer.byteLength(value.message) > 4096) {
    throw new GuardianProtocolError('subprocess-guardian: invalid wire error')
  }
  return { code: value.code, message: value.message }
}

function requireSettlement(value: unknown): GuardianSettlement {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new GuardianProtocolError('subprocess-guardian: invalid process settlement')
  }
  if (!value.ok) return { ok: false, error: requireWireError(value.error) }
  if (!isRecord(value.outcome)) throw new GuardianProtocolError('subprocess-guardian: invalid process outcome')
  const exitCode = value.outcome.exitCode
  const signal = value.outcome.signal
  if (!(exitCode === null || Number.isSafeInteger(exitCode)) || !(signal === null || typeof signal === 'string')) {
    throw new GuardianProtocolError('subprocess-guardian: invalid process outcome')
  }
  return { ok: true, outcome: { exitCode: exitCode as number | null, signal: signal as NodeJS.Signals | null } }
}

function isErrorCode(value: unknown): value is GuardianWireError['code'] {
  return value === 'aborted' || value === 'bad-request' || value === 'disconnected'
    || value === 'internal' || value === 'not-supported'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
