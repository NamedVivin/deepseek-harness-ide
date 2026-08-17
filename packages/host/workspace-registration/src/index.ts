/** Host-owned native directory selection followed by durable Workspace registration. */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-directory-picker'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace'
import type {
  RegisteredWorkspaceView,
  WorkspaceRegistrationFailureCode,
  WorkspaceRegistrationRejected,
  WorkspaceRegistrationResult,
  WorkspaceRegistrationSuccess,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User-paced native picker and authoritative Workspace-registration Remote. */
    workspaceRegistration: WorkspaceRegistrationGateway
  }
}

function success(workspace: Workspace): WorkspaceRegistrationSuccess {
  const view: RegisteredWorkspaceView = Object.freeze({
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  })
  return Object.freeze({ ok: true, value: Object.freeze({ workspace: view }) })
}

function rejected(
  code: WorkspaceRegistrationFailureCode,
  message: string,
): WorkspaceRegistrationRejected {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
}

/** Remote gateway that never accepts a renderer-supplied filesystem path. */
export class WorkspaceRegistrationGateway extends TypertRemoteService {
  static inject = ['directoryPicker', 'workspaceRegistry']

  /** @param ctx - Host context carrying the picker and authoritative Workspace registry. */
  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistration')
  }

  /**
   * Open the selected Host picker and register its result while the caller remains live.
   * @param signal - Renderer request lifetime; a late chooser result is discarded after abort.
   * @returns the registered Workspace, cancellation, or a stable business failure.
   */
  @Remote('pickAndRegister')
  async pickAndRegister(signal?: AbortSignal): Promise<WorkspaceRegistrationResult> {
    const capability = this.ctx.directoryPicker.capability()
    if (capability.kind !== 'native') {
      return rejected('picker-unavailable', 'this deployment has no Host-owned native directory picker')
    }

    let selected: string | null
    try {
      selected = await capability.pick(signal ?? new AbortController().signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      return rejected('registration-failed', error instanceof Error ? error.message : String(error))
    }
    signal?.throwIfAborted()
    if (selected === null) return rejected('cancelled', 'directory selection was cancelled')

    try {
      const workspace = await this.ctx.workspaceRegistry.create(selected)
      signal?.throwIfAborted()
      return success(workspace)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      return rejected('registration-failed', error instanceof Error ? error.message : String(error))
    }
  }
}

export default WorkspaceRegistrationGateway
