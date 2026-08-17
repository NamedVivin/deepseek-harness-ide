/** Client-safe wire vocabulary for Host-owned workspace registration. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Workspace identifier issued by the authoritative Host registry. */
export type WorkspaceId = Branded<'WorkspaceId'>

/** Registered Workspace projection returned after a successful native pick. */
export interface RegisteredWorkspaceView {
  workspaceId: WorkspaceId
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

/** Stable business failures of the user-paced registration operation. */
export type WorkspaceRegistrationFailureCode =
  | 'cancelled'
  | 'picker-unavailable'
  | 'registration-failed'

/** One failed registration result. */
export interface WorkspaceRegistrationFailure {
  readonly code: WorkspaceRegistrationFailureCode
  readonly message: string
}

/** Successful registration result. */
export interface WorkspaceRegistrationSuccess {
  readonly ok: true
  readonly value: {
    readonly workspace: RegisteredWorkspaceView
  }
}

/** Rejected or cancelled registration result. */
export interface WorkspaceRegistrationRejected {
  readonly ok: false
  readonly error: WorkspaceRegistrationFailure
}

/** Closed business result of `pickAndRegister`. */
export type WorkspaceRegistrationResult =
  | WorkspaceRegistrationSuccess
  | WorkspaceRegistrationRejected
