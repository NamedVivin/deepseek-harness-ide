/** Closed lifecycle protocol shared by Electron main and the Node Host sidecar. */

import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** Current application lifecycle protocol version. */
export const DESKTOP_RUNTIME_PROTOCOL_VERSION = 1

/** Main-to-sidecar lifecycle frames outside the Connection body transport. */
export type DesktopRuntimeInboundFrame = {
  readonly version: 1
  readonly type: 'desktop-runtime-dispose'
  readonly reason: 'app-quit' | 'main-disconnect' | 'startup-abort'
}

/** Sidecar-to-main lifecycle frames outside the Connection body transport. */
export type DesktopRuntimeOutboundFrame =
  | {
    readonly version: 1
    readonly type: 'desktop-runtime-ready'
    readonly graph: WebBootGraph
  }
  | {
    readonly version: 1
    readonly type: 'desktop-runtime-failed'
    readonly message: string
  }
  | {
    readonly version: 1
    readonly type: 'desktop-runtime-disposed'
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one lifecycle control frame without accepting Connection frames.
 * @param value - untrusted child-IPC message.
 * @returns the validated control frame, or undefined for another protocol.
 */
export function parseDesktopRuntimeInboundFrame(value: unknown): DesktopRuntimeInboundFrame | undefined {
  if (!isRecord(value)
    || value.version !== DESKTOP_RUNTIME_PROTOCOL_VERSION
    || value.type !== 'desktop-runtime-dispose'
    || value.reason !== 'app-quit' && value.reason !== 'main-disconnect' && value.reason !== 'startup-abort'
    || Object.keys(value).some(key => key !== 'version' && key !== 'type' && key !== 'reason')) {
    return undefined
  }
  return {
    version: DESKTOP_RUNTIME_PROTOCOL_VERSION,
    type: value.type,
    reason: value.reason,
  }
}

/**
 * Parse one sidecar lifecycle frame without accepting Connection frames.
 * @param value - untrusted child-IPC message.
 * @returns the validated lifecycle frame, or undefined for another protocol.
 */
export function parseDesktopRuntimeOutboundFrame(value: unknown): DesktopRuntimeOutboundFrame | undefined {
  if (!isRecord(value) || value.version !== DESKTOP_RUNTIME_PROTOCOL_VERSION || typeof value.type !== 'string') {
    return undefined
  }
  if (value.type === 'desktop-runtime-failed' && typeof value.message === 'string') {
    return { version: DESKTOP_RUNTIME_PROTOCOL_VERSION, type: value.type, message: value.message }
  }
  if (value.type === 'desktop-runtime-disposed') {
    return { version: DESKTOP_RUNTIME_PROTOCOL_VERSION, type: value.type }
  }
  if (value.type === 'desktop-runtime-ready' && isWebBootGraph(value.graph)) {
    return { version: DESKTOP_RUNTIME_PROTOCOL_VERSION, type: value.type, graph: value.graph }
  }
  return undefined
}

function isWebBootGraph(value: unknown): value is WebBootGraph {
  if (!isRecord(value) || typeof value.rev !== 'string' || !Array.isArray(value.entries)) return false
  return value.entries.every((entry) => {
    if (!isRecord(entry)
      || typeof entry.id !== 'string'
      || typeof entry.url !== 'string'
      || typeof entry.rev !== 'string') return false
    if (entry.inject !== undefined
      && (!Array.isArray(entry.inject) || entry.inject.some(item => typeof item !== 'string'))) return false
    return entry.immediately === undefined || typeof entry.immediately === 'boolean'
  })
}
