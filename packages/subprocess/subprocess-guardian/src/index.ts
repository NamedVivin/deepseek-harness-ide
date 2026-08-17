/** Guardian-backed ordinary subprocess Service Provider for the packaged pure-Node desktop sidecar. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  FramedGuardianPeer,
  createNodeGuardianEndpoint,
  type NodeGuardianIpcProcess,
} from './channel.ts'
import { IpcGuardianSubprocessClient, type GuardianSubprocessClient } from './client.ts'
import { validateGuardianProtocolLimits } from './protocol.ts'

export {
  FramedGuardianPeer,
  createNodeGuardianEndpoint,
} from './channel.ts'
export type {
  GuardianByteSink,
  GuardianByteWriter,
  GuardianCallHandler,
  GuardianCallResult,
  GuardianMessageEndpoint,
  NodeGuardianIpcProcess,
} from './channel.ts'
export { IpcGuardianSubprocessClient } from './client.ts'
export type { GuardianSubprocessClient } from './client.ts'
export { GuardianServer } from './guardian.ts'
export type { GuardianPreparedSpawn, GuardianSpawnRequest } from './guardian.ts'
export * from './protocol.ts'
export * from './supervisor.ts'

/** Mandatory bounded transport configuration. */
export interface Config {
  /** Maximum complete JSON call or result body. */
  maxBodyBytes: number
  /** Maximum bytes in one IPC chunk. */
  maxChunkBytes: number
  /** Hop-wide maximum unacknowledged bytes across concurrent streams. */
  maxInflightBytes: number
}

/** Guardian-backed subprocess service retaining handles until whole-tree release. */
export class GuardianSubprocessRuntime extends SubprocessRuntime {
  static Config: z<Config> = z.object({
    maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxChunkBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
    maxInflightBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })

  private readonly live = new Set<SubprocessHandle>()
  private disposing = false

  /**
   * @param ctx - sidecar Host context.
   * @param config - required framing bounds.
   * @param suppliedClient - deterministic embedded client for tests; production uses the connected process IPC channel.
   */
  constructor(ctx: Context, config: Config, private readonly client: GuardianSubprocessClient = createClient(config)) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposing = true
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      await Promise.allSettled(handles.map(handle => handle.waitForExit()))
      await Promise.allSettled(handles.map(handle => handle.done))
      this.live.clear()
      await this.client.dispose()
    }, 'guardian subprocess teardown')
  }

  /** @inheritdoc */
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.disposing) return Promise.reject(new Error('subprocess-guardian: service is disposing'))
    return this.client.resolveExecutable(command, env, signal)
  }

  /** @inheritdoc */
  async spawn(spec: SubprocessSpawnSpec): Promise<SubprocessHandle> {
    if (this.disposing) throw new Error('subprocess-guardian: service is disposing')
    const handle = await this.client.spawn(spec)
    if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) {
      handle.terminate()
      await handle.waitForExit()
      throw new Error('subprocess-guardian: guardian published a non-positive pid')
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can begin while client spawn is pending.
    if (this.disposing) {
      handle.terminate()
      await handle.waitForExit()
      await handle.done.catch(() => undefined)
      throw new Error('subprocess-guardian: service disposed during process setup')
    }
    this.live.add(handle)
    void handle.done.finally(() => { this.live.delete(handle) }).catch(() => undefined)
    return handle
  }
}

function createClient(config: Config): GuardianSubprocessClient {
  const limits = validateGuardianProtocolLimits(config)
  const peer = new FramedGuardianPeer(
    createNodeGuardianEndpoint(process as unknown as NodeGuardianIpcProcess),
    limits,
  )
  return new IpcGuardianSubprocessClient(peer)
}

export default GuardianSubprocessRuntime
