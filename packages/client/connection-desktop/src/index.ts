/** Child-IPC provider for the carrier-neutral Host Connection registry. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-modules'
import type { RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  ConnectionRpcAccessError,
  HostConnectionTransport,
  type ConnectionRpcTarget,
  type HostConnectionTransportHost,
} from '@deepseek-ai/dsh-client-connection'
import {
  ChildProcessDesktopIpcAdapter,
  createNodeChildProcessEndpoint,
} from './adapter.ts'
import type {
  DesktopIpcAdapter,
  DesktopIpcHost,
  DesktopRendererInvocation,
  DesktopRendererInvocationResult,
  HostInitiatedMethodMap,
  HostInitiatedRequest,
  HostInitiatedResponse,
} from './protocol.ts'
import {
  resolveDesktopIpcLimits,
  type DesktopIpcLimitsInput,
} from './wire.ts'

export {
  ChildProcessDesktopIpcAdapter,
  DesktopMainIpcPeer,
  InMemoryDesktopIpcAdapter,
  createNodeChildProcessEndpoint,
  createNodeParentProcessEndpoint,
} from './adapter.ts'
export { parseDesktopServerRequest } from './codec.ts'
export type {
  InMemoryDesktopMainHandlers,
  NodeChildIpcProcess,
  NodeIpcPeer,
} from './adapter.ts'
export {
  DESKTOP_CONNECTION_PROTOCOL_VERSION,
  DesktopBodyId,
  DesktopRequestId,
} from './protocol.ts'
export type * from './protocol.ts'
export {
  DEFAULT_MAX_DESKTOP_BODY_BYTES,
  DEFAULT_MAX_DESKTOP_CHUNK_BYTES,
  DEFAULT_MAX_DESKTOP_INFLIGHT_BYTES,
  DesktopBodyLimitError,
  DesktopBodyTransport,
  DesktopProtocolError,
  parseDesktopBodyFrame,
  resolveDesktopIpcLimits,
} from './wire.ts'
export type { DesktopIpcLimits, DesktopIpcLimitsInput } from './wire.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection-desktop'
/** Desktop module graph is required for the packaged renderer bootstrap method. */
export const inject = ['clientModules']
/** Optional pre-provided adapter key used by embedded desktop tests and bootloaders. */
export const DESKTOP_IPC_ADAPTER_SERVICE = 'desktopIpcAdapter'

/** Desktop child-IPC provider configuration. */
export interface DesktopConnectionConfig extends DesktopIpcLimitsInput {}

/** Validated desktop child-IPC limits. */
export const Config: z<DesktopConnectionConfig> = z.object({
  maxDesktopBodyBytes: z.natural().min(1).default(160 * 1024 * 1024),
  maxDesktopChunkBytes: z.natural().min(1).default(1024 * 1024),
  maxDesktopInflightBytes: z.natural().min(1).default(16 * 1024 * 1024),
})

/** Closed ApiProxy method list callable by the packaged renderer. */
export const DESKTOP_RENDERER_API_METHODS = [
  'session.list',
  'session.search',
  'session.create',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
  'subagent.list',
  'subagent.history',
  'subagent.prompt',
  'subagent.interrupt',
  'host.describe',
  'workspace.list',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession',
  'skill.list',
  'agentPreset.list',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.providers',
  'llm.models',
  'llm.discoverModels',
] as const satisfies readonly (keyof RpcMethodMap)[]

const DESKTOP_RENDERER_API_METHOD_SET: ReadonlySet<string> = new Set(DESKTOP_RENDERER_API_METHODS)

/** Closed Typert Remote endpoint list callable by the packaged renderer. */
const DESKTOP_RENDERER_REMOTE_ENDPOINTS = [
  'commands/list',
  'commands/execute',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'goals/complete',
  'goals/clear',
  'messageFeedback/list',
  'messageFeedback/put',
  'messageFeedback/delete',
  'pluginInventory/list',
  'workspaceFiles/list',
  'workspaceFiles/read',
  'workspaceFiles/save',
  'workspaceFiles/resolveLocation',
  'workspaceRegistration/pickAndRegister',
] as const

const DESKTOP_RENDERER_REMOTE_ENDPOINT_SET: ReadonlySet<string> = new Set(
  DESKTOP_RENDERER_REMOTE_ENDPOINTS,
)

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Sidecar-to-Electron capability service; separate from renderer RPC. */
    desktopHostBridge: DesktopHostBridge
  }
}

/** Sidecar-to-Electron main capability service with a closed method map. */
export class DesktopHostBridge extends Service {
  /**
   * @param ctx - desktop provider context.
   * @param adapter - physical IPC adapter carrying Host requests.
   */
  constructor(ctx: Context, private readonly adapter: DesktopIpcAdapter) {
    super(ctx, 'desktopHostBridge')
  }

  /**
   * Invoke one Electron-main capability.
   * @param method - closed Host-initiated method name.
   * @param payload - method-derived request payload.
   * @param signal - optional caller cancellation propagated to main.
   * @returns method-derived response after IPC validation.
   */
  request<K extends keyof HostInitiatedMethodMap>(
    method: K,
    payload: HostInitiatedRequest<K>,
    signal?: AbortSignal,
  ): Promise<HostInitiatedResponse<K>> {
    return this.adapter.requestHost(method, payload, signal)
  }
}

/** Desktop transport provider enforcing the renderer method policy at dispatch. */
export class DesktopConnectionTransport extends HostConnectionTransport {
  /**
   * @param ctx - provider-owning Host context.
   * @param adapter - child-IPC or deterministic in-memory adapter.
   */
  constructor(ctx: Context, private readonly adapter: DesktopIpcAdapter) {
    super(ctx)
  }

  /** @inheritdoc */
  install(host: HostConnectionTransportHost): () => void | Promise<void> {
    const handlers: DesktopIpcHost = {
      invoke: (invocation, signal) => this.invoke(host, invocation, signal),
      system: (_method, _payload, signal) => {
        if (signal.aborted) return Promise.reject(abortReason(signal))
        return Promise.resolve(this.ctx.clientModules.graph())
      },
      subscribe: (stream, signal) => host.subscribe(stream, signal),
    }
    return this.adapter.install(handlers)
  }

  private async invoke(
    host: HostConnectionTransportHost,
    invocation: DesktopRendererInvocation,
    signal: AbortSignal,
  ): Promise<DesktopRendererInvocationResult> {
    if (invocation.kind === 'respond') {
      return { kind: 'respond', receipt: await host.respond(invocation.message, signal) }
    }
    if (invocation.channel === '/api' && invocation.message.method === 'session.create') {
      assertDesktopSessionCreate(invocation.message.payload)
    }
    const message = await host.invoke({
      channel: invocation.channel,
      message: invocation.message,
      caller: 'loopback',
      signal,
      authorize: authorizeDesktopTarget,
    })
    return { kind: 'rpc', message }
  }
}

function authorizeDesktopTarget(target: ConnectionRpcTarget): boolean {
  return target.kind === 'registered'
    ? target.channel === '/api' && DESKTOP_RENDERER_REMOTE_ENDPOINT_SET.has(target.endpoint)
    : DESKTOP_RENDERER_API_METHOD_SET.has(target.endpoint)
}

function assertDesktopSessionCreate(value: unknown): void {
  if (!isRecord(value)) throw deniedSessionCreate()
  const keys = Object.keys(value)
  if (keys.some(key => key !== 'workspaceId' && key !== 'sessionId' && key !== 'agentPreset')
    || typeof value.workspaceId !== 'string' || value.workspaceId === ''
    || value.cwd !== undefined
    || value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId === '')
    || value.agentPreset !== undefined && value.agentPreset !== 'desktop-default') {
    throw deniedSessionCreate()
  }
}

function deniedSessionCreate(): ConnectionRpcAccessError {
  return new ConnectionRpcAccessError('/api/session.create')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Provide desktop Connection and Host-initiated bridge services.
 * @param ctx - sidecar Host context.
 */
export function apply(ctx: Context, config: DesktopConnectionConfig = {}): void {
  const limits = resolveDesktopIpcLimits(config)
  assertDesktopBodyCapacity(ctx, limits.maxDesktopBodyBytes)
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertDesktopBodyCapacity(attachmentCtx, limits.maxDesktopBodyBytes)
  })
  const supplied = ctx.get(DESKTOP_IPC_ADAPTER_SERVICE) as DesktopIpcAdapter | undefined
  const adapter = supplied ?? new ChildProcessDesktopIpcAdapter(
    createNodeChildProcessEndpoint(process),
    limits,
  )
  new DesktopHostBridge(ctx, adapter)
  new DesktopConnectionTransport(ctx, adapter)
}

const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024
const DEFAULT_MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024
const WORST_CASE_JSON_ESCAPE_BYTES = 6

function assertDesktopBodyCapacity(ctx: Context, maxDesktopBodyBytes: number): void {
  const requiredTextBodyBytes = DEFAULT_MAX_TEXT_FILE_BYTES * WORST_CASE_JSON_ESCAPE_BYTES
    + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxDesktopBodyBytes < requiredTextBodyBytes) {
    throw new Error(
      `connection-desktop maxDesktopBodyBytes (${String(maxDesktopBodyBytes)}) must be at least `
      + `${String(requiredTextBodyBytes)} for a worst-case escaped text buffer`,
    )
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredBytes = Math.ceil(attachments.imageLimits.maxMessageImageBytes * 4 / 3)
    + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxDesktopBodyBytes < requiredBytes) {
    throw new Error(
      `connection-desktop maxDesktopBodyBytes (${String(maxDesktopBodyBytes)}) must be at least `
      + `${String(requiredBytes)} for the configured aggregate image limit`,
    )
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop system request aborted')
}
