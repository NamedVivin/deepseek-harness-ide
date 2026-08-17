/**
 * Client-safe request and result vocabulary for workspace-scoped file access.
 * @module @deepseek-ai/dsh-host-workspace-files/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Client-safe structural spelling of the Host-issued workspace authority. */
export type WorkspaceId = Branded<'WorkspaceId'>

/** Opaque equality token for one observed workspace-file revision. */
export type WorkspaceFileVersion = Branded<'WorkspaceFileVersion'>

/** Canonical path segments relative to a registered workspace root. */
export type WorkspaceFileSegments = readonly string[]

/** A model-facing file location that may be absolute or workspace-relative. */
export interface WorkspaceFileLocation {
  /** Candidate path produced by a tool or assistant response. */
  readonly path: string
  /** Optional 1-based line to focus after opening the file. */
  readonly line?: number
}

/** File kind exposed to the IDE. `blocked` entries cannot be traversed. */
export type WorkspaceFileKind = 'file' | 'directory' | 'other' | 'blocked'

/** One direct child of a listed workspace directory. */
export interface WorkspaceFileEntry {
  /** Display basename of the child. */
  readonly name: string
  /** Canonical workspace-relative identity, or the inert requested spelling for a blocked entry. */
  readonly segments: WorkspaceFileSegments
  /** Traversal and editor eligibility. */
  readonly kind: WorkspaceFileKind
  /** Byte size when the provider reports one for a regular file. */
  readonly size?: number
}

/** List one registered workspace directory. */
export interface WorkspaceFilesListRequest {
  /** Host-issued workspace authority. */
  readonly workspaceId: WorkspaceId
  /** Canonical relative directory; an empty array names the root. */
  readonly directory: WorkspaceFileSegments
}

/** Stable directory listing in provider name order. */
export interface WorkspaceFilesListValue {
  /** Canonical directory that was listed. */
  readonly directory: WorkspaceFileSegments
  /** Direct children only. */
  readonly entries: readonly WorkspaceFileEntry[]
}

/** Read one existing workspace text file. */
export interface WorkspaceFilesReadRequest {
  /** Host-issued workspace authority. */
  readonly workspaceId: WorkspaceId
  /** Non-empty canonical relative file path. */
  readonly path: WorkspaceFileSegments
}

/** Stable text snapshot and the revision required for a later save. */
export interface WorkspaceFilesReadValue {
  /** Canonical relative file path. */
  readonly path: WorkspaceFileSegments
  /** Exact decoded UTF-8 content. */
  readonly content: string
  /** Opaque compare-and-swap basis. */
  readonly version: WorkspaceFileVersion
}

/** Save one existing workspace text file against an observed revision. */
export interface WorkspaceFilesSaveRequest {
  /** Host-issued workspace authority. */
  readonly workspaceId: WorkspaceId
  /** Non-empty canonical relative file path. */
  readonly path: WorkspaceFileSegments
  /** Complete replacement text. */
  readonly content: string
  /** Revision returned by the read or prior save being replaced. */
  readonly expectedVersion: WorkspaceFileVersion
}

/** Confirmed durable workspace-file save. */
export interface WorkspaceFilesSaveValue {
  /** Canonical relative file path. */
  readonly path: WorkspaceFileSegments
  /** Opaque revision after publication. */
  readonly version: WorkspaceFileVersion
}

/** Resolve one model-facing location under a registered workspace. */
export interface WorkspaceFilesResolveLocationRequest {
  /** Host-issued workspace authority. */
  readonly workspaceId: WorkspaceId
  /** Untrusted absolute or workspace-relative candidate. */
  readonly location: WorkspaceFileLocation
}

/** Canonical location safe for IDE routing. */
export interface WorkspaceFilesResolveLocationValue {
  /** Canonical relative identity. */
  readonly segments: WorkspaceFileSegments
  /** Current filesystem kind. */
  readonly kind: Exclude<WorkspaceFileKind, 'blocked'>
  /** Whether the file is eligible for a bounded text read; decoding may still reject binary content. */
  readonly textSupported: boolean
  /** Validated 1-based line copied from the candidate. */
  readonly line?: number
}

/** Stable business-failure discriminants shared by workspace-file operations. */
export type WorkspaceFilesErrorCode =
  | 'workspace-not-found'
  | 'invalid-path'
  | 'outside-workspace'
  | 'not-found'
  | 'not-directory'
  | 'not-regular-file'
  | 'not-text'
  | 'too-large'
  | 'permission-denied'
  | 'changed-during-read'
  | 'version-conflict'

/** One rejected workspace-file operation. */
export interface WorkspaceFilesFailure {
  /** Machine-routable failure. */
  readonly code: WorkspaceFilesErrorCode
  /** Configured byte or entry limit when the failure is size-related. */
  readonly limit?: number
  /** Observed UTF-8 byte count when known. */
  readonly actual?: number
}

/** Successful workspace-file operation. */
export interface WorkspaceFilesSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Rejected workspace-file operation. */
export interface WorkspaceFilesRejected {
  readonly ok: false
  readonly error: WorkspaceFilesFailure
}

/** Public result shared by all workspace-file Remote methods. */
export type WorkspaceFilesResult<T> = WorkspaceFilesSuccess<T> | WorkspaceFilesRejected
