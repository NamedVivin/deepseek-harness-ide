/**
 * Workspace-scoped file Remote over the active filesystem provider and durable
 * workspace registry. Renderer callers receive relative identities and opaque
 * versions; absolute paths remain Host-only.
 * @module @deepseek-ai/dsh-host-workspace-files
 */

import { Buffer } from 'node:buffer'
import { posix, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceFileEntry,
  WorkspaceFileSegments,
  WorkspaceFilesFailure,
  WorkspaceFilesListRequest,
  WorkspaceFilesListValue,
  WorkspaceFilesReadRequest,
  WorkspaceFilesReadValue,
  WorkspaceFilesRejected,
  WorkspaceFilesResolveLocationRequest,
  WorkspaceFilesResolveLocationValue,
  WorkspaceFilesResult,
  WorkspaceFilesSaveRequest,
  WorkspaceFilesSaveValue,
  WorkspaceFilesSuccess,
  WorkspaceFileVersion,
  WorkspaceId,
} from './types.ts'

export type * from './types.ts'

/** Workspace-file limits owned by the Host deployment. */
export interface Config {
  /** Inclusive UTF-8 byte limit for one editor buffer. Defaults to 10 MiB. */
  readonly maxTextFileBytes?: number
  /** Inclusive direct-child limit for one directory listing. Defaults to 10,000. */
  readonly maxDirectoryEntries?: number
}

interface ResolvedConfig {
  readonly maxTextFileBytes: number
  readonly maxDirectoryEntries: number
}

interface ResolvedTarget {
  readonly root: FsTarget
  readonly target: FsTarget
  readonly segments: WorkspaceFileSegments
}

type PathFamily = typeof posix

const DEFAULT_MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_DIRECTORY_ENTRIES = 10_000
const WORKSPACE_WRITE_POLICY = 'workspace-write'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceFiles: WorkspaceFilesGateway
  }
}

function resolvePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`workspace-files: ${name} must be a positive safe integer`)
  }
  return value
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    maxTextFileBytes: resolvePositiveInteger(
      'maxTextFileBytes',
      config.maxTextFileBytes ?? DEFAULT_MAX_TEXT_FILE_BYTES,
    ),
    maxDirectoryEntries: resolvePositiveInteger(
      'maxDirectoryEntries',
      config.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES,
    ),
  }
}

function success<T>(value: T): WorkspaceFilesSuccess<T> {
  return Object.freeze({ ok: true, value })
}

function rejected(code: WorkspaceFilesFailure['code'], details: Omit<WorkspaceFilesFailure, 'code'> = {}): WorkspaceFilesRejected {
  return Object.freeze({ ok: false, error: Object.freeze({ code, ...details }) })
}

function isRejected<T>(value: WorkspaceFilesResult<T> | ResolvedTarget): value is WorkspaceFilesRejected {
  return 'ok' in value && !value.ok
}

function validSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('\0')
    && !segment.includes('/')
    && !segment.includes('\\')
    && !/^[A-Za-z]:/.test(segment)
    && !win32.isAbsolute(segment)
}

function validateSegments(segments: WorkspaceFileSegments, allowRoot: boolean): WorkspaceFilesRejected | undefined {
  if ((!allowRoot && segments.length === 0) || segments.some(segment => !validSegment(segment))) {
    return rejected('invalid-path')
  }
  return undefined
}

function pathFamily(path: string): PathFamily {
  return windowsAbsolute(path) ? win32 : posix
}

function windowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function relativeSegments(rootPath: string, targetPath: string): WorkspaceFileSegments | undefined {
  const family = pathFamily(rootPath)
  const relative = family.relative(rootPath, targetPath)
  if (relative === '') return Object.freeze([])
  if (family.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${family.sep}`)) return undefined
  const segments = relative.split(family.sep)
  if (segments.some(segment => !validSegment(segment))) return undefined
  return Object.freeze(segments)
}

function asWorkspaceFileVersion(version: FsVersion): WorkspaceFileVersion {
  return version as unknown as WorkspaceFileVersion
}

function asFsVersion(version: WorkspaceFileVersion): FsVersion {
  return version as unknown as FsVersion
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function kindOf(info: FsInfo): WorkspaceFilesResolveLocationValue['kind'] {
  return info.type
}

/** Host-owned workspace file gateway published through generated Typert Remote descriptors. */
export class WorkspaceFilesGateway extends TypertRemoteService {
  static inject = ['fs', 'workspaceRegistry']

  static Config: s<Config> = s.object({
    maxTextFileBytes: s.number().step(1).min(1).default(DEFAULT_MAX_TEXT_FILE_BYTES),
    maxDirectoryEntries: s.number().step(1).min(1).default(DEFAULT_MAX_DIRECTORY_ENTRIES),
  })

  private readonly config: ResolvedConfig

  /**
   * @param ctx - Host context carrying the workspace authority and root filesystem provider.
   * @param config - Bounded directory and editor-buffer limits.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceFiles')
    this.config = resolveConfig(config)
  }

  /**
   * List one direct workspace directory without materializing more than the configured entry limit.
   * @param request - Registered workspace and canonical relative directory.
   * @param signal - Cancels filesystem work.
   * @returns stable entries or one business failure.
   */
  @Remote('list')
  async list(request: WorkspaceFilesListRequest, signal?: AbortSignal): Promise<WorkspaceFilesResult<WorkspaceFilesListValue>> {
    const resolved = await this.resolveSegments(request.workspaceId, request.directory, true, signal)
    if (isRejected(resolved)) return resolved
    const info = await this.stat(resolved.target, signal)
    if (!info.ok) return info
    if (info.value.type !== 'directory') return rejected('not-directory')
    let listed
    try {
      listed = await this.ctx.fs.listDirBounded(
        resolved.target,
        { maxEntries: this.config.maxDirectoryEntries },
        signal,
      )
    } catch (error: unknown) {
      return this.mapFsError(error, { limit: this.config.maxDirectoryEntries })
    }
    const inertPrefix = [...resolved.segments]
    const entries: WorkspaceFileEntry[] = listed.map((entry) => {
      if (!validSegment(entry.name) || !this.ctx.fs.contains(resolved.root, entry.target)) {
        return Object.freeze({
          name: entry.name,
          segments: Object.freeze([...inertPrefix, entry.name]),
          kind: 'blocked' as const,
        })
      }
      const segments = relativeSegments(
        this.ctx.fs.processPath(resolved.root),
        this.ctx.fs.processPath(entry.target),
      )
      if (segments === undefined) {
        return Object.freeze({
          name: entry.name,
          segments: Object.freeze([...inertPrefix, entry.name]),
          kind: 'blocked' as const,
        })
      }
      return Object.freeze({
        name: entry.name,
        segments,
        kind: entry.type,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })
    })
    return success(Object.freeze({
      directory: resolved.segments,
      entries: Object.freeze(entries),
    }))
  }

  /**
   * Read one regular UTF-8 file and reject a mutation observed during the bounded read.
   * @param request - Registered workspace and canonical relative file.
   * @param signal - Cancels filesystem work.
   * @returns stable content/version pair or one business failure.
   */
  @Remote('read')
  async read(request: WorkspaceFilesReadRequest, signal?: AbortSignal): Promise<WorkspaceFilesResult<WorkspaceFilesReadValue>> {
    const resolved = await this.resolveSegments(request.workspaceId, request.path, false, signal)
    if (isRejected(resolved)) return resolved
    const before = await this.stat(resolved.target, signal)
    if (!before.ok) return before
    if (before.value.type !== 'file') return rejected('not-regular-file')
    if (before.value.size !== undefined && before.value.size > this.config.maxTextFileBytes) {
      return rejected('too-large', { limit: this.config.maxTextFileBytes, actual: before.value.size })
    }
    let bytes: Uint8Array
    try {
      bytes = await this.ctx.fs.readBytes(resolved.target, signal, this.config.maxTextFileBytes)
    } catch (error: unknown) {
      return this.mapFsError(error, { limit: this.config.maxTextFileBytes })
    }
    const content = decodeText(bytes)
    if (content === undefined) return rejected('not-text')
    const fresh = await this.resolveSegments(request.workspaceId, request.path, false, signal)
    if (isRejected(fresh)) return fresh.error.code === 'outside-workspace' ? fresh : rejected('changed-during-read')
    const after = await this.stat(fresh.target, signal)
    if (!after.ok) return rejected('changed-during-read')
    if (fresh.target.targetKey !== resolved.target.targetKey || after.value.version !== before.value.version) {
      return rejected('changed-during-read')
    }
    return success(Object.freeze({
      path: fresh.segments,
      content,
      version: asWorkspaceFileVersion(after.value.version),
    }))
  }

  /**
   * Replace one existing file only when its opaque observed revision still matches.
   * @param request - Complete content and compare-and-swap basis.
   * @param signal - Cancels before atomic publication.
   * @returns the durable new revision or one business failure.
   */
  @Remote('save')
  async save(request: WorkspaceFilesSaveRequest, signal?: AbortSignal): Promise<WorkspaceFilesResult<WorkspaceFilesSaveValue>> {
    const actual = Buffer.byteLength(request.content, 'utf8')
    if (actual > this.config.maxTextFileBytes) {
      return rejected('too-large', { limit: this.config.maxTextFileBytes, actual })
    }
    const resolved = await this.resolveSegments(request.workspaceId, request.path, false, signal)
    if (isRejected(resolved)) return resolved
    const info = await this.stat(resolved.target, signal)
    if (!info.ok) return info
    if (info.value.type !== 'file') return rejected('not-regular-file')
    const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
    if (workspace === undefined) return rejected('workspace-not-found')
    const fresh = await this.resolveSegments(request.workspaceId, request.path, false, signal)
    if (isRejected(fresh)) return fresh
    if (fresh.target.targetKey !== resolved.target.targetKey) return rejected('version-conflict')
    const policy: SandboxExecutionPolicy = {
      mode: WORKSPACE_WRITE_POLICY,
      workspaceRoot: workspace.path,
    }
    try {
      const outcome = await this.ctx.fs.writeText(
        fresh.target,
        request.content,
        { kind: 'replaceIfVersion', version: asFsVersion(request.expectedVersion) },
        signal,
        policy,
      )
      return success(Object.freeze({
        path: fresh.segments,
        version: asWorkspaceFileVersion(outcome.version),
      }))
    } catch (error: unknown) {
      return this.mapFsError(error)
    }
  }

  /**
   * Resolve an untrusted model-facing location into a canonical relative IDE identity.
   * @param request - Registered workspace and absolute or relative candidate.
   * @param signal - Cancels filesystem work.
   * @returns safe location metadata or one business failure.
   */
  @Remote('resolveLocation')
  async resolveLocation(
    request: WorkspaceFilesResolveLocationRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesResult<WorkspaceFilesResolveLocationValue>> {
    const { location } = request
    if (location.path.trim().length === 0 || location.path.includes('\0')
      || (location.line !== undefined && (!Number.isSafeInteger(location.line) || location.line < 1))) {
      return rejected('invalid-path')
    }
    const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
    if (workspace === undefined) return rejected('workspace-not-found')
    let root: FsTarget
    let target: FsTarget
    try {
      root = await this.ctx.fs.resolve(workspace.path, signal === undefined ? {} : { signal })
      const rootPath = this.ctx.fs.processPath(root)
      const family = pathFamily(rootPath)
      if (family === posix && windowsAbsolute(location.path)) return rejected('outside-workspace')
      if (family === win32 && posix.isAbsolute(location.path) && !windowsAbsolute(location.path)) {
        return rejected('outside-workspace')
      }
      target = await this.ctx.fs.resolve(location.path, {
        cwd: rootPath,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error: unknown) {
      return this.mapFsError(error)
    }
    if (!this.ctx.fs.contains(root, target)) return rejected('outside-workspace')
    const segments = relativeSegments(this.ctx.fs.processPath(root), this.ctx.fs.processPath(target))
    if (segments === undefined) return rejected('outside-workspace')
    const info = await this.stat(target, signal)
    if (!info.ok) return info
    return success(Object.freeze({
      segments,
      kind: kindOf(info.value),
      textSupported: info.value.type === 'file'
        && (info.value.size === undefined || info.value.size <= this.config.maxTextFileBytes),
      ...(location.line === undefined ? {} : { line: location.line }),
    }))
  }

  private async resolveSegments(
    workspaceId: WorkspaceId,
    segments: WorkspaceFileSegments,
    allowRoot: boolean,
    signal?: AbortSignal,
  ): Promise<ResolvedTarget | WorkspaceFilesRejected> {
    const invalid = validateSegments(segments, allowRoot)
    if (invalid !== undefined) return invalid
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) return rejected('workspace-not-found')
    try {
      const root = await this.ctx.fs.resolve(workspace.path, signal === undefined ? {} : { signal })
      const target = await this.ctx.fs.resolve(
        segments.length === 0 ? '.' : segments.join('/'),
        {
          cwd: this.ctx.fs.processPath(root),
          ...(signal === undefined ? {} : { signal }),
        },
      )
      if (!this.ctx.fs.contains(root, target)) return rejected('outside-workspace')
      const canonical = relativeSegments(this.ctx.fs.processPath(root), this.ctx.fs.processPath(target))
      if (canonical === undefined) return rejected('outside-workspace')
      return { root, target, segments: canonical }
    } catch (error: unknown) {
      return this.mapFsError(error)
    }
  }

  private async stat(target: FsTarget, signal?: AbortSignal): Promise<WorkspaceFilesResult<FsInfo>> {
    try {
      const info = await this.ctx.fs.stat(target, signal)
      return info === undefined ? rejected('not-found') : success(info)
    } catch (error: unknown) {
      return this.mapFsError(error)
    }
  }

  private mapFsError(error: unknown, details: Omit<WorkspaceFilesFailure, 'code'> = {}): WorkspaceFilesRejected {
    if (!(error instanceof FsError)) throw error
    switch (error.code) {
      case 'FS_NOT_FOUND': return rejected('not-found')
      case 'FS_NOT_DIRECTORY': return rejected('not-directory')
      case 'FS_NOT_REGULAR_FILE': return rejected('not-regular-file')
      case 'FS_NOT_TEXT': return rejected('not-text')
      case 'FS_TOO_LARGE': return rejected('too-large', details)
      case 'FS_PERMISSION_DENIED':
      case 'FS_SANDBOX_DENIED': return rejected('permission-denied')
      case 'FS_STALE_VERSION': return rejected('version-conflict')
      case 'FS_ABORTED': throw error
      case 'FS_IO_ERROR':
      case 'FS_NOT_OBSERVED':
      case 'FS_AMBIGUOUS_EDIT':
      case 'FS_EDIT_NOT_FOUND': throw error
    }
  }
}

export default WorkspaceFilesGateway
