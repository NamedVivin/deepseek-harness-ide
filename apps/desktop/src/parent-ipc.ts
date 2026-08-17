/** JSON-safe IPC adaptation between Electron main and the pure Node.js guardian. */

import {
  DESKTOP_CONNECTION_PROTOCOL_VERSION,
  type DesktopMainMessageEndpoint,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import {
  DesktopProtocolError,
  parseDesktopBodyFrame,
} from '@deepseek-ai/dsh-client-connection-desktop/wire'
import {
  createNodeGuardianHostEndpoint,
  type GuardianHostIpcEndpoint,
} from '@deepseek-ai/dsh-subprocess-guardian/host'

/** Cross-V8 Electron-to-guardian child-process serialization mode. */
export const DESKTOP_PARENT_IPC_SERIALIZATION = 'json' as const

const PARENT_BINARY_NAMESPACE = 'dsh.desktop.parent-binary'
const PARENT_BINARY_VERSION = 1
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const ENVELOPE_KEYS = new Set([
  'namespace',
  'version',
  'type',
  'bodyId',
  'sequence',
  'byteLength',
  'data',
])

type ParentIpcTarget = Parameters<typeof createNodeGuardianHostEndpoint>[0]

/**
 * Codec for the JSON child-IPC hop whose Electron and Node.js peers may embed different V8 versions.
 * Non-binary frames pass through unchanged; body chunks use a canonical, length-checked base64 envelope.
 */
export class DesktopParentIpcCodec {
  /** @param maxChunkBytes - maximum decoded bytes accepted in one body-chunk envelope. */
  constructor(private readonly maxChunkBytes: number) {
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) {
      throw new Error('desktop parent IPC: maxChunkBytes must be a positive safe integer')
    }
  }

  /**
   * Encode one semantic desktop message for JSON child IPC.
   * @param value - validated local message or untrusted sidecar value being relayed.
   * @returns a JSON-safe physical value.
   */
  encode(value: unknown): unknown {
    const frame = parseDesktopBodyFrame(value)
    if (frame?.type !== 'body-chunk') return value
    if (frame.chunk.byteLength === 0 || frame.chunk.byteLength > this.maxChunkBytes) {
      throw new DesktopProtocolError('desktop parent IPC: body chunk has an invalid byte length')
    }
    return {
      namespace: PARENT_BINARY_NAMESPACE,
      version: PARENT_BINARY_VERSION,
      type: 'body-chunk',
      bodyId: frame.bodyId,
      sequence: frame.sequence,
      byteLength: frame.chunk.byteLength,
      data: Buffer.from(frame.chunk).toString('base64'),
    }
  }

  /**
   * Decode one value received from JSON child IPC.
   * @param value - untrusted physical child-IPC value.
   * @returns the semantic body chunk or an unrelated value unchanged.
   */
  decode(value: unknown): unknown {
    if (!isRecord(value) || value.namespace !== PARENT_BINARY_NAMESPACE) return value
    const keys = Object.keys(value)
    if (keys.length !== ENVELOPE_KEYS.size || keys.some(key => !ENVELOPE_KEYS.has(key))
      || value.version !== PARENT_BINARY_VERSION
      || value.type !== 'body-chunk') {
      throw new DesktopProtocolError('desktop parent IPC: malformed binary envelope')
    }
    if (typeof value.bodyId !== 'string' || value.bodyId.length === 0
      || !isNatural(value.sequence)) {
      throw new DesktopProtocolError('desktop parent IPC: binary envelope has invalid correlation fields')
    }
    if (!isPositiveBoundedInteger(value.byteLength, this.maxChunkBytes)) {
      throw new DesktopProtocolError('desktop parent IPC: binary envelope exceeds the configured byte limit')
    }
    const expectedLength = Math.ceil(value.byteLength / 3) * 4
    if (typeof value.data !== 'string' || value.data.length !== expectedLength || !BASE64.test(value.data)) {
      throw new DesktopProtocolError('desktop parent IPC: binary envelope has invalid base64 data')
    }
    const decoded = Buffer.from(value.data, 'base64')
    if (decoded.byteLength !== value.byteLength || decoded.toString('base64') !== value.data) {
      throw new DesktopProtocolError('desktop parent IPC: binary envelope has non-canonical base64 data')
    }
    return {
      version: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      type: 'body-chunk',
      bodyId: value.bodyId,
      sequence: value.sequence,
      chunk: new Uint8Array(decoded),
    }
  }
}

/**
 * Adapt Electron main's JSON child to the semantic desktop Connection endpoint.
 * @param target - connected pure-Node guardian child.
 * @param maxChunkBytes - maximum decoded body chunk size.
 * @returns endpoint that encodes and decodes only binary body chunks.
 */
export function createDesktopJsonMainEndpoint(
  target: ParentIpcTarget,
  maxChunkBytes: number,
): DesktopMainMessageEndpoint {
  const codec = new DesktopParentIpcCodec(maxChunkBytes)
  if (typeof target.send !== 'function' || target.connected === false) throw disconnectedError()
  return {
    send: (frame) => {
      if (typeof target.send !== 'function' || target.connected === false) throw disconnectedError()
      target.send(codec.encode(frame))
    },
    onMessage: (listener) => {
      const receive = (value: unknown): void => { listener(codec.decode(value)) }
      target.on('message', receive)
      return () => { target.off('message', receive) }
    },
    onDisconnect: (listener) => {
      target.on('disconnect', listener)
      return () => { target.off('disconnect', listener) }
    },
  }
}

/**
 * Adapt the guardian's JSON parent channel for semantic relay through `GuardianHost`.
 * @param target - guardian process connected to Electron main.
 * @param maxChunkBytes - maximum decoded body chunk size.
 * @returns promise-based parent endpoint with binary body-chunk translation.
 */
export function createDesktopJsonGuardianEndpoint(
  target: ParentIpcTarget,
  maxChunkBytes: number,
): GuardianHostIpcEndpoint {
  const codec = new DesktopParentIpcCodec(maxChunkBytes)
  const endpoint = createNodeGuardianHostEndpoint(target)
  return {
    send: value => endpoint.send(codec.encode(value)),
    onMessage: listener => endpoint.onMessage((value) => { listener(codec.decode(value)) }),
    onDisconnect: listener => endpoint.onDisconnect(listener),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNatural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function disconnectedError(): Error {
  return new Error('desktop parent IPC: Node child IPC disconnected')
}
