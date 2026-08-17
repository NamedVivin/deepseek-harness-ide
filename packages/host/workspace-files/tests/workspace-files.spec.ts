import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import WorkspaceFilesGateway from '../src/index.ts'
import type { WorkspaceFilesRejected, WorkspaceFileVersion } from '../src/types.ts'

class RecordingLocalFileSystem extends LocalFileSystem {
  lastWritePolicy: SandboxExecutionPolicy | undefined

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    this.lastWritePolicy = sandboxPolicy
    return super.writeText(target, content, expected, signal)
  }
}

const workspaceId = WorkspaceId('workspace-files-test')
let root: string
let outside: string
let ctx: Context
let gateway: WorkspaceFilesGateway
let fs: RecordingLocalFileSystem

function workspace(path: string): Workspace {
  return {
    id: workspaceId,
    path,
    title: 'workspace',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    sessionIds: [],
    setTitle: () => Promise.resolve(),
    attachSession: () => Promise.resolve(),
    insertSessionBefore: () => Promise.resolve(),
    detachSession: () => Promise.resolve(),
    status: () => Promise.resolve('ok'),
  }
}

async function mount(config: { maxTextFileBytes?: number; maxDirectoryEntries?: number } = {}): Promise<void> {
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspaceId ? workspace(root) : undefined,
  } as never)
  await ctx.plugin(RecordingLocalFileSystem, { cwd: root })
  await ctx.plugin(WorkspaceFilesGateway, config)
  gateway = ctx.workspaceFiles
  fs = ctx.fs as RecordingLocalFileSystem
}

function expectCode(result: WorkspaceFilesRejected, code: WorkspaceFilesRejected['error']['code']): void {
  expect(result).toMatchObject({ ok: false, error: { code } })
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-files-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-files-outside-')))
  ctx = new Context()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ])
})

describe('WorkspaceFilesGateway', () => {
  it('publishes the four bounded direct Remotes', async () => {
    await mount()

    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'workspaceFiles',
      namespace: 'workspaceFiles',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'read', invocation: { kind: 'direct' } },
      { method: 'save', invocation: { kind: 'direct' } },
      { method: 'resolveLocation', invocation: { kind: 'direct' } },
    ])
  })

  it('lists stable canonical entries and blocks links outside the workspace', async () => {
    await mkdir(join(root, 'z-dir'))
    await writeFile(join(root, 'a.txt'), 'alpha')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'outside-link'))
    await mount()

    const result = await gateway.list({ workspaceId, directory: [] })

    expect(result).toEqual({
      ok: true,
      value: {
        directory: [],
        entries: [
          { name: 'a.txt', segments: ['a.txt'], kind: 'file', size: 5 },
          { name: 'outside-link', segments: ['outside-link'], kind: 'blocked' },
          { name: 'z-dir', segments: ['z-dir'], kind: 'directory' },
        ],
      },
    })
    const escaped = await gateway.read({ workspaceId, path: ['outside-link', 'secret.txt'] })
    if (escaped.ok) throw new Error('expected containment rejection')
    expectCode(escaped, 'outside-workspace')
  })

  it('rejects an oversized directory through the provider-side bound', async () => {
    await Promise.all([
      writeFile(join(root, 'a.txt'), 'a'),
      writeFile(join(root, 'b.txt'), 'b'),
    ])
    await mount({ maxDirectoryEntries: 1 })

    const result = await gateway.list({ workspaceId, directory: [] })

    expect(result).toEqual({
      ok: false,
      error: { code: 'too-large', limit: 1 },
    })
  })

  it('rejects unknown workspaces and every non-canonical segment spelling', async () => {
    await mount()
    const invalidPaths = [
      [],
      [''],
      ['.'],
      ['..'],
      ['a/b'],
      ['a\\b'],
      ['C:escape'],
      ['C:\\escape'],
      ['\\\\server\\share'],
      ['nul\0byte'],
    ]

    for (const path of invalidPaths) {
      const result = await gateway.read({ workspaceId, path })
      if (result.ok) throw new Error(`expected invalid path ${JSON.stringify(path)}`)
      expectCode(result, 'invalid-path')
    }

    const missing = await gateway.list({
      workspaceId: WorkspaceId('forged-workspace'),
      directory: [],
    })
    if (missing.ok) throw new Error('expected unknown workspace rejection')
    expectCode(missing, 'workspace-not-found')
  })

  it('reads only regular bounded UTF-8 text and returns its opaque version', async () => {
    await writeFile(join(root, 'text.md'), '# hello\n')
    await writeFile(join(root, 'binary.bin'), new Uint8Array([0, 1, 2]))
    await writeFile(join(root, 'invalid.txt'), new Uint8Array([0xc3, 0x28]))
    await writeFile(join(root, 'large.txt'), '12345')
    await mkdir(join(root, 'folder'))
    await mount({ maxTextFileBytes: 4 })

    const text = await gateway.read({ workspaceId, path: ['text.md'] })
    expect(text).toEqual({ ok: false, error: { code: 'too-large', limit: 4, actual: 8 } })

    for (const path of [['binary.bin'], ['invalid.txt']] as const) {
      const result = await gateway.read({ workspaceId, path })
      if (result.ok) throw new Error('expected text rejection')
      expectCode(result, 'not-text')
    }

    const directory = await gateway.read({ workspaceId, path: ['folder'] })
    if (directory.ok) throw new Error('expected regular-file rejection')
    expectCode(directory, 'not-regular-file')

    await rm(join(root, 'large.txt'))
    await writeFile(join(root, 'ok.txt'), 'four')
    const ok = await gateway.read({ workspaceId, path: ['ok.txt'] })
    if (!ok.ok) throw new Error(`unexpected read rejection: ${ok.error.code}`)
    expect(ok.value).toMatchObject({ path: ['ok.txt'], content: 'four' })
    expect(typeof ok.value.version).toBe('string')
  })

  it('rejects content paired with a version observed across a concurrent mutation', async () => {
    const path = join(root, 'race.txt')
    await writeFile(path, 'before')
    await mount()
    let mutate = true
    fs.internals.inspectReadBytesAfterStat = async () => {
      if (!mutate) return
      mutate = false
      await writeFile(path, 'after!')
    }

    const result = await gateway.read({ workspaceId, path: ['race.txt'] })

    if (result.ok) throw new Error('expected changed-during-read rejection')
    expectCode(result, 'changed-during-read')
  })

  it('saves only with compare-and-swap and an explicit workspace-write policy', async () => {
    const path = join(root, 'file.txt')
    await writeFile(path, 'base')
    await mount()
    const observed = await gateway.read({ workspaceId, path: ['file.txt'] })
    if (!observed.ok) throw new Error(`unexpected read rejection: ${observed.error.code}`)

    const saved = await gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'updated',
      expectedVersion: observed.value.version,
    })

    expect(saved).toMatchObject({ ok: true, value: { path: ['file.txt'] } })
    expect(await readFile(path, 'utf8')).toBe('updated')
    expect(fs.lastWritePolicy).toEqual({ mode: 'workspace-write', workspaceRoot: root })

    const stale = await gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'stale overwrite',
      expectedVersion: observed.value.version,
    })
    if (stale.ok) throw new Error('expected stale save rejection')
    expectCode(stale, 'version-conflict')
    expect(await readFile(path, 'utf8')).toBe('updated')
  })

  it('serializes concurrent saves so exactly one matching version wins', async () => {
    const path = join(root, 'race.txt')
    await writeFile(path, 'base')
    await mount()
    const observed = await gateway.read({ workspaceId, path: ['race.txt'] })
    if (!observed.ok) throw new Error(`unexpected read rejection: ${observed.error.code}`)

    const outcomes = await Promise.all([
      gateway.save({
        workspaceId,
        path: ['race.txt'],
        content: 'first',
        expectedVersion: observed.value.version,
      }),
      gateway.save({
        workspaceId,
        path: ['race.txt'],
        content: 'second',
        expectedVersion: observed.value.version,
      }),
    ])

    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1)
    expect(outcomes.filter(outcome => !outcome.ok)).toEqual([
      { ok: false, error: { code: 'version-conflict' } },
    ])
    expect(['first', 'second']).toContain(await readFile(path, 'utf8'))
  })

  it('resolves relative and absolute locations without exposing sibling roots', async () => {
    const path = join(root, 'src', 'index.ts')
    await mkdir(join(root, 'src'))
    await writeFile(path, 'export {}\n')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await mount()

    const relative = await gateway.resolveLocation({
      workspaceId,
      location: { path: 'src/index.ts', line: 7 },
    })
    expect(relative).toEqual({
      ok: true,
      value: { segments: ['src', 'index.ts'], kind: 'file', textSupported: true, line: 7 },
    })
    const absolute = await gateway.resolveLocation({
      workspaceId,
      location: { path },
    })
    expect(absolute).toEqual({
      ok: true,
      value: { segments: ['src', 'index.ts'], kind: 'file', textSupported: true },
    })
    const escaped = await gateway.resolveLocation({
      workspaceId,
      location: { path: join(outside, 'secret.txt') },
    })
    if (escaped.ok) throw new Error('expected sibling-root rejection')
    expectCode(escaped, 'outside-workspace')

    for (const location of [
      { path: '' },
      { path: 'src/index.ts', line: 0 },
      { path: 'src/index.ts', line: 1.5 },
      { path: 'C:\\outside\\file.txt' },
      { path: '\\\\server\\share\\file.txt' },
    ]) {
      const result = await gateway.resolveLocation({ workspaceId, location })
      if (result.ok) throw new Error(`expected invalid or outside location ${JSON.stringify(location)}`)
      expect(['invalid-path', 'outside-workspace']).toContain(result.error.code)
    }
  })

  it('never accepts a caller-manufactured stale token as a blind overwrite', async () => {
    const path = join(root, 'file.txt')
    await writeFile(path, 'base')
    await mount()

    const result = await gateway.save({
      workspaceId,
      path: ['file.txt'],
      content: 'forged',
      expectedVersion: 'forged-version' as WorkspaceFileVersion,
    })

    if (result.ok) throw new Error('expected forged version rejection')
    expectCode(result, 'version-conflict')
    expect(await readFile(path, 'utf8')).toBe('base')
  })
})
