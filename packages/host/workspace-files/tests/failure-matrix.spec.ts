import { TextEncoder } from 'node:util'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsErrorCode,
  type FsInfo,
  type FsTarget,
} from '@deepseek-ai/dsh-fs'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkspaceFilesGateway from '../src/index.ts'
import type { WorkspaceFileVersion } from '../src/types.ts'

const workspaceId = WorkspaceId('workspace-files-failure-matrix')
const contexts: Context[] = []

function target(path: string, key = path): FsTarget {
  return { targetKey: FsTargetKey(key), displayPath: path }
}

function info(type: FsInfo['type'], size?: number, version = 'v1'): FsInfo {
  return {
    type,
    version: FsVersion(version),
    ...(size === undefined ? {} : { size }),
  }
}

function setup(config: { maxTextFileBytes?: number; maxDirectoryEntries?: number } = {}, workspacePath = '/workspace') {
  const ctx = new Context()
  contexts.push(ctx)
  const root = target(workspacePath)
  const registryGet = vi.fn((_id: WorkspaceId): { path: string } | undefined => ({ path: workspacePath }))
  const fs = {
    resolve: vi.fn(async (path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> => {
      if (path === workspacePath) return root
      return target(posix.isAbsolute(path) ? path : posix.resolve(options?.cwd ?? workspacePath, path))
    }),
    processPath: vi.fn((value: FsTarget): string => value.displayPath),
    contains: vi.fn((parent: FsTarget, child: FsTarget): boolean =>
      child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)),
    stat: vi.fn(async (value: FsTarget): Promise<FsInfo | undefined> =>
      value.targetKey === root.targetKey ? info('directory') : info('file', 2)),
    listDirBounded: vi.fn(async (): Promise<FsDirEntry[]> => []),
    readBytes: vi.fn(async (): Promise<Uint8Array> => new TextEncoder().encode('ok')),
    writeText: vi.fn(async (_target: FsTarget, content: string) => ({
      operation: 'update' as const,
      version: FsVersion('v2'),
      before: 'ok',
      after: content,
    })),
  }
  ctx.provide('fs', fs as never)
  ctx.provide('workspaceRegistry', { get: registryGet } as never)
  return { ctx, fs, gateway: new WorkspaceFilesGateway(ctx, config), registryGet, root }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('WorkspaceFilesGateway failure matrix', () => {
  it('validates deployment limits and resolves constructor defaults without Schemastery', () => {
    const direct = setup()
    expect(direct.gateway).toBeInstanceOf(WorkspaceFilesGateway)

    for (const config of [
      { maxTextFileBytes: 0 },
      { maxTextFileBytes: Number.MAX_SAFE_INTEGER + 1 },
      { maxDirectoryEntries: 1.5 },
    ]) {
      const ctx = new Context()
      contexts.push(ctx)
      expect(() => new WorkspaceFilesGateway(ctx, config)).toThrow('must be a positive safe integer')
    }
  })

  it('maps every filesystem error and rethrows non-business failures', async () => {
    const { fs, gateway } = setup({}, '/workspace')
    const mapped: ReadonlyArray<readonly [FsErrorCode, string]> = [
      ['FS_NOT_FOUND', 'not-found'],
      ['FS_NOT_DIRECTORY', 'not-directory'],
      ['FS_NOT_REGULAR_FILE', 'not-regular-file'],
      ['FS_NOT_TEXT', 'not-text'],
      ['FS_TOO_LARGE', 'too-large'],
      ['FS_PERMISSION_DENIED', 'permission-denied'],
      ['FS_SANDBOX_DENIED', 'permission-denied'],
      ['FS_STALE_VERSION', 'version-conflict'],
    ]
    for (const [fsCode, code] of mapped) {
      fs.listDirBounded.mockRejectedValueOnce(new FsError(fsCode, fsCode))
      await expect(gateway.list({ workspaceId, directory: [] })).resolves.toMatchObject({
        ok: false,
        error: { code },
      })
    }

    for (const code of [
      'FS_ABORTED',
      'FS_IO_ERROR',
      'FS_NOT_OBSERVED',
      'FS_AMBIGUOUS_EDIT',
      'FS_EDIT_NOT_FOUND',
    ] as const) {
      fs.listDirBounded.mockRejectedValueOnce(new FsError(code, code))
      await expect(gateway.list({ workspaceId, directory: [] })).rejects.toMatchObject({ code })
    }

    fs.stat.mockRejectedValueOnce(new Error('provider bug'))
    await expect(gateway.list({ workspaceId, directory: [] })).rejects.toThrow('provider bug')
  })

  it('blocks malformed, escaped, and non-canonical provider entries', async () => {
    const { fs, gateway, root } = setup()
    fs.contains.mockReturnValue(true)
    fs.listDirBounded.mockResolvedValueOnce([
      { name: 'bad/name', type: 'file', target: target('/workspace/bad-name') },
      { name: 'escaped', type: 'file', target: target('/outside') },
      { name: 'bad-segment', type: 'file', target: target('/workspace/bad\0segment') },
      { name: 'self', type: 'directory', target: root },
      { name: 'normal', type: 'file', target: target('/workspace/normal') },
    ])

    await expect(gateway.list({ workspaceId, directory: [] })).resolves.toEqual({
      ok: true,
      value: {
        directory: [],
        entries: [
          { name: 'bad/name', segments: ['bad/name'], kind: 'blocked' },
          { name: 'escaped', segments: ['escaped'], kind: 'blocked' },
          { name: 'bad-segment', segments: ['bad-segment'], kind: 'blocked' },
          { name: 'self', segments: [], kind: 'directory' },
          { name: 'normal', segments: ['normal'], kind: 'file' },
        ],
      },
    })
  })

  it('returns early metadata failures for lists, reads, and saves', async () => {
    const missing = setup({ maxTextFileBytes: 1 })
    missing.fs.stat.mockResolvedValue(undefined)
    await expect(missing.gateway.list({ workspaceId, directory: [] })).resolves.toMatchObject({ error: { code: 'not-found' } })
    await expect(missing.gateway.read({ workspaceId, path: ['file.txt'] })).resolves.toMatchObject({ error: { code: 'not-found' } })
    await expect(missing.gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'x',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'not-found' } })

    const wrongKinds = setup()
    wrongKinds.fs.stat.mockResolvedValue(info('file', 1))
    await expect(wrongKinds.gateway.list({ workspaceId, directory: [] })).resolves.toMatchObject({ error: { code: 'not-directory' } })
    wrongKinds.fs.stat.mockResolvedValue(info('directory'))
    await expect(wrongKinds.gateway.read({ workspaceId, path: ['folder'] })).resolves.toMatchObject({ error: { code: 'not-regular-file' } })
    await expect(wrongKinds.gateway.save({
      workspaceId,
      path: ['folder'],
      content: 'x',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'not-regular-file' } })

    await expect(missing.gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'too large',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'too-large', limit: 1 } })
    await expect(wrongKinds.gateway.save({
      workspaceId,
      path: [],
      content: 'x',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'invalid-path' } })
  })

  it('rejects every read-side identity race', async () => {
    const escaped = setup()
    escaped.fs.resolve
      .mockResolvedValueOnce(escaped.root)
      .mockResolvedValueOnce(target('/workspace/file.txt'))
      .mockResolvedValueOnce(escaped.root)
      .mockResolvedValueOnce(target('/outside'))
    await expect(escaped.gateway.read({ workspaceId, path: ['file.txt'] })).resolves.toMatchObject({
      error: { code: 'outside-workspace' },
    })

    const missingWorkspace = setup()
    missingWorkspace.registryGet
      .mockReturnValueOnce({ path: '/workspace' })
      .mockReturnValue(undefined)
    await expect(missingWorkspace.gateway.read({ workspaceId, path: ['file.txt'] })).resolves.toMatchObject({
      error: { code: 'changed-during-read' },
    })

    const missingAfter = setup()
    missingAfter.fs.stat
      .mockResolvedValueOnce(info('file', 2))
      .mockResolvedValueOnce(undefined)
    await expect(missingAfter.gateway.read({ workspaceId, path: ['file.txt'] })).resolves.toMatchObject({
      error: { code: 'changed-during-read' },
    })

    const changedTarget = setup()
    changedTarget.fs.resolve
      .mockResolvedValueOnce(changedTarget.root)
      .mockResolvedValueOnce(target('/workspace/file.txt', 'first'))
      .mockResolvedValueOnce(changedTarget.root)
      .mockResolvedValueOnce(target('/workspace/file.txt', 'second'))
    await expect(changedTarget.gateway.read({ workspaceId, path: ['file.txt'] })).resolves.toMatchObject({
      error: { code: 'changed-during-read' },
    })

    const readFailure = setup()
    readFailure.fs.readBytes.mockRejectedValueOnce(new FsError('denied', 'FS_PERMISSION_DENIED'))
    await expect(readFailure.gateway.read({ workspaceId, path: ['file.txt'] })).resolves.toMatchObject({
      error: { code: 'permission-denied' },
    })
  })

  it('rejects every save-side authority and identity race', async () => {
    const missingWorkspace = setup()
    missingWorkspace.registryGet
      .mockReturnValueOnce({ path: '/workspace' })
      .mockReturnValueOnce(undefined)
    await expect(missingWorkspace.gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'x',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'workspace-not-found' } })

    const missingFresh = setup()
    missingFresh.registryGet
      .mockReturnValueOnce({ path: '/workspace' })
      .mockReturnValueOnce({ path: '/workspace' })
      .mockReturnValueOnce(undefined)
    await expect(missingFresh.gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'x',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'workspace-not-found' } })

    const changedTarget = setup()
    changedTarget.fs.resolve
      .mockResolvedValueOnce(changedTarget.root)
      .mockResolvedValueOnce(target('/workspace/file.txt', 'first'))
      .mockResolvedValueOnce(changedTarget.root)
      .mockResolvedValueOnce(target('/workspace/file.txt', 'second'))
    await expect(changedTarget.gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'x',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'version-conflict' } })

    const writeFailure = setup()
    writeFailure.fs.writeText.mockRejectedValueOnce(new FsError('denied', 'FS_PERMISSION_DENIED'))
    await expect(writeFailure.gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'x',
      expectedVersion: 'v1' as WorkspaceFileVersion,
    })).resolves.toMatchObject({ error: { code: 'permission-denied' } })
  })

  it('handles Windows roots, bounded metadata, signals, and canonical-location failures', async () => {
    const windows = setup({ maxTextFileBytes: 2 }, 'C:\\workspace')
    windows.fs.resolve.mockImplementation(async (path: string): Promise<FsTarget> => {
      if (path === 'C:\\workspace') return windows.root
      if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) return target(path)
      return target(`C:\\workspace\\${path}`)
    })
    windows.fs.contains.mockReturnValue(true)
    await expect(windows.gateway.resolveLocation({ workspaceId, location: { path: '/outside' } }))
      .resolves.toMatchObject({ error: { code: 'outside-workspace' } })
    const signal = new AbortController().signal
    await expect(windows.gateway.resolveLocation({ workspaceId, location: { path: 'file.txt' } }, signal))
      .resolves.toEqual({ ok: true, value: { segments: ['file.txt'], kind: 'file', textSupported: true } })

    const missingWorkspace = setup()
    missingWorkspace.registryGet.mockReturnValue(undefined)
    await expect(missingWorkspace.gateway.resolveLocation({ workspaceId, location: { path: 'file.txt' } }))
      .resolves.toMatchObject({ error: { code: 'workspace-not-found' } })

    const resolveFailure = setup()
    resolveFailure.fs.resolve.mockRejectedValueOnce(new FsError('missing', 'FS_NOT_FOUND'))
    await expect(resolveFailure.gateway.resolveLocation({ workspaceId, location: { path: 'file.txt' } }))
      .resolves.toMatchObject({ error: { code: 'not-found' } })

    const escaped = setup()
    escaped.fs.contains.mockReturnValue(true)
    escaped.fs.resolve
      .mockResolvedValueOnce(escaped.root)
      .mockResolvedValueOnce(target('/outside'))
    await expect(escaped.gateway.resolveLocation({ workspaceId, location: { path: 'file.txt' } }))
      .resolves.toMatchObject({ error: { code: 'outside-workspace' } })

    const missing = setup()
    missing.fs.stat.mockResolvedValue(undefined)
    await expect(missing.gateway.resolveLocation({ workspaceId, location: { path: 'file.txt' } }))
      .resolves.toMatchObject({ error: { code: 'not-found' } })

    const metadata = setup({ maxTextFileBytes: 2 })
    metadata.fs.stat.mockResolvedValueOnce(info('directory'))
    await expect(metadata.gateway.resolveLocation({ workspaceId, location: { path: 'folder' } }))
      .resolves.toMatchObject({ value: { kind: 'directory', textSupported: false } })
    metadata.fs.stat.mockResolvedValueOnce(info('file', 3))
    await expect(metadata.gateway.resolveLocation({ workspaceId, location: { path: 'large.txt' } }))
      .resolves.toMatchObject({ value: { kind: 'file', textSupported: false } })
  })

  it('maps segment resolution failures with and without caller signals', async () => {
    const canonical = setup()
    canonical.fs.contains.mockReturnValue(true)
    canonical.fs.resolve
      .mockResolvedValueOnce(canonical.root)
      .mockResolvedValueOnce(target('/outside'))
    await expect(canonical.gateway.read({ workspaceId, path: ['file.txt'] }))
      .resolves.toMatchObject({ error: { code: 'outside-workspace' } })

    const rejected = setup()
    rejected.fs.resolve.mockRejectedValueOnce(new FsError('denied', 'FS_PERMISSION_DENIED'))
    await expect(rejected.gateway.read(
      { workspaceId, path: ['file.txt'] },
      new AbortController().signal,
    )).resolves.toMatchObject({ error: { code: 'permission-denied' } })

    const signalled = setup()
    await expect(signalled.gateway.read(
      { workspaceId, path: ['file.txt'] },
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: true, value: { content: 'ok' } })
  })
})
