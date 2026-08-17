/** Remaining fixture protocol domains and hostile-input branches. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientConnectionRpc,
  RpcRequest,
  RpcResponse,
  RpcResult,
  SessionId,
  WorkspaceId,
} from '@deepseek-ai/dsh-client-connection/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import {
  createFixtureApi,
  createFixtureFaces,
  FixtureApiClient,
} from '../src/client/fixture.ts'

const sid = (value: string): SessionId => value as SessionId
const wid = (value: string): WorkspaceId => value as WorkspaceId
let requestId = 0
const req = <P>(payload: P): RpcRequest<P> => ({ rpcId: RpcId(`runtime-${requestId++}`), payload })

function valueOf<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(`fixture request failed: ${response.result.error.code}`)
  return response.result.value
}

async function remote<T = unknown>(
  rpc: ClientConnectionRpc,
  endpoint: string,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  return rpc.call('/api', endpoint, { args }) as Promise<RpcResult<T>>
}

interface GoalRef {
  id: string
  revision: number
}

interface GoalView extends GoalRef {
  objective: string
}

interface FixtureTiming {
  appendUser(id: string, message: string): void
  startReasoningChunkStorm(id: string, chunkCount: number, chunksPerInterval: number, intervalMs: number): string
  beginModelRetry(id: string): void
  scheduleModelRetry(id: string): void
  cancelModelRetryDuringBackoff(id: string): void
  completeModelRetry(id: string): void
}

const fixtureTiming = (): FixtureTiming => (
  (globalThis as Record<string, unknown>).__fxTiming as FixtureTiming
)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fixture Remote command branches', () => {
  it('drives permission, plan, goal, and empty-result command outcomes', async () => {
    const { api, rpc } = createFixtureFaces()
    await expect(remote(rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/plan off' }))
      .resolves.toMatchObject({ ok: true })
    for (const [line, kind] of [
      ['/permission', 'success'],
      ['/permission unknown', 'error'],
      ['/permission danger-full-access', 'success'],
      ['/permission danger-full-access', 'success'],
      ['/permission workspace-write', 'success'],
      ['/echo', 'success'],
      ['/compact', 'success'],
      ['/goal', 'success'],
      ['/goal first objective', 'success'],
      ['/goal', 'success'],
      ['/goal replacement', 'success'],
    ] as const) {
      const result = await remote(rpc, 'commands/execute', { agentId: sid('fx-alpha'), line })
      expect(result).toMatchObject({ ok: true, value: { result: { kind } } })
    }

    await expect(remote(rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/plan' }))
      .resolves.toMatchObject({ ok: true })
    await expect(api.sessions.prompt(req({
      sessionId: sid('fx-alpha'), mode: 'queue', content: [{ type: 'text', text: 'apply plan' }],
    }))).resolves.toMatchObject({ result: { ok: true } })
    await api.sessions.cancel(req({ sessionId: sid('fx-alpha') }))
    await expect(remote(rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/plan off' }))
      .resolves.toMatchObject({ ok: true })

    const created = valueOf(await api.sessions.create(req({ sessionId: sid('command-idle') })))
    for (const line of ['/plan', '/plan', '/plan off']) {
      await expect(remote(rpc, 'commands/execute', { agentId: created.sessionId, line }))
        .resolves.toMatchObject({ ok: true })
    }
    const prompt = await api.sessions.prompt(req({
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'flush a pending plan selection' }],
    }))
    expect(prompt.result.ok).toBe(true)
    await api.sessions.cancel(req({ sessionId: created.sessionId }))
  })

  it('enforces goal session, revision, and transition rules on the Remote face', async () => {
    const { rpc } = createFixtureFaces({ empty: true })
    await expect(remote(rpc, 'goals/create', {
      agentId: sid('missing'), request: { objective: 'x' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })

    const faces = createFixtureFaces({ empty: true })
    const createdSession = valueOf(await faces.api.sessions.create(req({ sessionId: sid('goal-runtime') })))
    const created = await remote<{ ref: GoalRef }>(faces.rpc, 'goals/create', {
      agentId: createdSession.sessionId,
      request: { objective: 'ship', maxGoalRounds: 7 },
    })
    if (!created.ok) throw new Error('goal create failed')
    let ref = created.value.ref
    await expect(remote(faces.rpc, 'goals/create', {
      agentId: createdSession.sessionId, request: { objective: 'duplicate' },
    })).resolves.toMatchObject({ ok: false })
    await expect(remote(faces.rpc, 'goals/pause', {
      agentId: sid('missing'), ref: { id: 'none', revision: 1 },
    })).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    await expect(remote(faces.rpc, 'goals/edit', {
      agentId: createdSession.sessionId, ref: { ...ref, revision: 99 }, request: {},
    })).resolves.toMatchObject({ ok: false })
    await expect(faces.rpc.call('/api', 'goals/edit', {
      args: { agentId: createdSession.sessionId, ref: { ...ref, revision: 99 } },
    })).resolves.toMatchObject({ ok: false })

    const edited = await remote<GoalView>(faces.rpc, 'goals/edit', {
      agentId: createdSession.sessionId, ref, request: { maxGoalRounds: 9 },
    })
    if (!edited.ok) throw new Error('goal edit failed')
    ref = { id: edited.value.id, revision: edited.value.revision }
    const paused = await remote<GoalView>(faces.rpc, 'goals/pause', { agentId: createdSession.sessionId, ref })
    if (!paused.ok) throw new Error('goal pause failed')
    ref = { id: paused.value.id, revision: paused.value.revision }
    await expect(remote(faces.rpc, 'goals/pause', { agentId: createdSession.sessionId, ref }))
      .resolves.toMatchObject({ ok: false })
    const resumed = await remote<GoalView>(faces.rpc, 'goals/resume', { agentId: createdSession.sessionId, ref })
    if (!resumed.ok) throw new Error('goal resume failed')
    ref = { id: resumed.value.id, revision: resumed.value.revision }
    const activeAgain = await remote<GoalView>(faces.rpc, 'goals/resume', { agentId: createdSession.sessionId, ref })
    if (!activeAgain.ok) throw new Error('active resume failed')
    ref = { id: activeAgain.value.id, revision: activeAgain.value.revision }
    const completed = await remote<GoalView>(faces.rpc, 'goals/complete', { agentId: createdSession.sessionId, ref })
    if (!completed.ok) throw new Error('goal complete failed')
    ref = { id: completed.value.id, revision: completed.value.revision }
    await expect(remote(faces.rpc, 'goals/resume', { agentId: createdSession.sessionId, ref }))
      .resolves.toMatchObject({ ok: false })
    await expect(remote(faces.rpc, 'goals/clear', {
      agentId: createdSession.sessionId, ref: { ...ref, revision: 1 },
    })).resolves.toMatchObject({ ok: false })
    await expect(remote(faces.rpc, 'goals/clear', { agentId: createdSession.sessionId, ref }))
      .resolves.toMatchObject({ ok: true })

    await expect(faces.rpc.call('/other', 'commands/list', { args: { agentId: createdSession.sessionId } }))
      .rejects.toThrow(/channel/)
    await expect(faces.rpc.call('/api', 'unknown/endpoint', { args: { agentId: createdSession.sessionId } }))
      .rejects.toThrow(/endpoint/)
  })
})

describe('fixture legacy protocol domains', () => {
  it('forks only at completed-turn boundaries and preserves workspace accounting', async () => {
    const api = createFixtureApi()
    const hooks = fixtureTiming()
    await expect(api.sessions.fork(req({ sessionId: sid('missing') })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'session-not-found' } } })

    const latest = valueOf(await api.sessions.fork(req({ sessionId: sid('fx-alpha') })))
    const anchored = valueOf(await api.sessions.fork(req({ sessionId: sid('fx-alpha'), atSeq: 1 })))
    expect(latest.sessionId).not.toBe(anchored.sessionId)
    const list = valueOf(await api.sessions.list(req({}))).items
    expect(list.find(item => item.sessionId === latest.sessionId)?.parentSessionId).toBe(sid('fx-alpha'))
    const workspace = valueOf(await api.workspace.list(req({}))).items[0]
    expect(workspace?.sessionIds.slice(0, 2)).toEqual([anchored.sessionId, latest.sessionId])

    const noCwdApi = createFixtureApi()
    const noCwdSummary = valueOf(await noCwdApi.sessions.list(req({}))).items
      .find(item => item.sessionId === sid('fx-alpha'))
    if (noCwdSummary === undefined) throw new Error('fixture session missing')
    delete noCwdSummary.cwd
    const noCwdFork = valueOf(await noCwdApi.sessions.fork(req({ sessionId: sid('fx-alpha') })))
    expect(valueOf(await noCwdApi.sessions.list(req({}))).items
      .find(item => item.sessionId === noCwdFork.sessionId)?.cwd).toBeUndefined()

    const blank = valueOf(await api.sessions.create(req({ sessionId: sid('fork-blank') })))
    await expect(api.sessions.fork(req({ sessionId: blank.sessionId })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'fork-unavailable' } } })

    vi.useFakeTimers()
    hooks.startReasoningChunkStorm(String(blank.sessionId), 2, 1, 100)
    await expect(api.sessions.fork(req({ sessionId: blank.sessionId, atSeq: 0 })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'fork-unavailable' } } })
    vi.runAllTimers()
  })

  it('authorizes attachments by durable session reference and handles base64 padding', async () => {
    const api = createFixtureApi({ empty: true })
    const first = valueOf(await api.sessions.create(req({ sessionId: sid('images-one') }))).sessionId
    const second = valueOf(await api.sessions.create(req({ sessionId: sid('images-two') }))).sessionId
    for (const [data, name] of [['YQ==', undefined], ['YWI=', 'two.png'], ['YWJj', 'three.png']] as const) {
      const response = await api.sessions.prompt(req({
        sessionId: first,
        mode: 'steer',
        content: [{ type: 'image', data, mediaType: 'image/png', ...(name === undefined ? {} : { name }) }],
      }))
      expect(response.result.ok).toBe(true)
      await api.sessions.cancel(req({ sessionId: first }))
    }
    const history = valueOf(await api.sessions.history(req({ sessionId: first, maxMessages: 20 })))
    const ids = history.events.flatMap((entry) => {
      if (entry.event.type !== 'user/message') return []
      return entry.event.data.content.flatMap(block => (
        block.type === 'image' ? [block.attachment.attachmentId] : []
      ))
    })
    expect(ids).toHaveLength(3)
    await expect(api.sessions.attachment(req({ sessionId: first, attachmentId: 'missing' as AttachmentIdType })))
      .resolves.toMatchObject({ result: { ok: false, error: { details: { reason: 'ATTACHMENT_NOT_FOUND' } } } })
    await expect(api.sessions.attachment(req({ sessionId: second, attachmentId: ids[0]! })))
      .resolves.toMatchObject({ result: { ok: false, error: { details: { reason: 'ATTACHMENT_NOT_REFERENCED' } } } })
    const stored = valueOf(await api.sessions.attachment(req({ sessionId: first, attachmentId: ids[0]! })))
    expect(stored.data).toBe('YQ==')
    expect(stored.attachment.bytes).toBe(1)
  })

  it('covers directories, workspaces, presets, settings, catalogs, and downloads', async () => {
    const api = createFixtureApi()
    expect(valueOf(await api.host.pickDirectory(req({}), new AbortController().signal)).path).toContain('/Documents/project')
    expect(valueOf(await api.host.listDirectory(req({}), new AbortController().signal)).path).toBe('/home/fixture')
    expect(valueOf(await api.host.listDirectory(req({ path: '/home/fixture/Downloads' }), new AbortController().signal)).entries).toEqual([])
    await expect(api.host.listDirectory(req({ path: '/missing' }), new AbortController().signal))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'directory-unreadable' } } })
    await expect(api.host.createDirectory(req({ path: '/missing', name: 'child' })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'directory-create-failed' } } })
    valueOf(await api.host.createDirectory(req({ path: '/home/fixture', name: 'new-dir' })))
    await expect(api.host.createDirectory(req({ path: '/home/fixture', name: 'new-dir' })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'directory-exists' } } })
    expect(valueOf(await api.host.openPath(req({ path: '/tmp/fixture' }), new AbortController().signal))).toEqual({ opened: true })

    const one = valueOf(await api.workspace.create(req({ path: '/tmp/ws-one' }))).workspace
    const two = valueOf(await api.workspace.create(req({ path: '/tmp/ws-two' }))).workspace
    const three = valueOf(await api.workspace.create(req({ path: '/tmp/ws-three' }))).workspace
    await expect(api.workspace.insertBefore(req({ workspaceId: wid('missing') })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'workspace-not-found' } } })
    await expect(api.workspace.insertBefore(req({ workspaceId: one.workspaceId, beforeWorkspaceId: wid('missing') })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'workspace-not-found' } } })
    valueOf(await api.workspace.insertBefore(req({ workspaceId: one.workspaceId, beforeWorkspaceId: three.workspaceId })))
    valueOf(await api.workspace.insertBefore(req({ workspaceId: two.workspaceId })))
    valueOf(await api.workspace.insertBefore(req({ workspaceId: two.workspaceId })))
    valueOf(await api.workspace.insertBefore(req({ workspaceId: two.workspaceId, beforeWorkspaceId: two.workspaceId })))

    await expect(api.workspace.archiveSession(req({ sessionId: sid('missing') })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'session-not-found' } } })
    expect(valueOf(await api.workspace.archiveSession(req({ sessionId: sid('fx-beta') })))).toEqual({ archivedSessionIds: [sid('fx-beta')] })
    expect(valueOf(await api.workspace.archiveSession(req({ sessionId: sid('fx-beta') })))).toEqual({ archivedSessionIds: [sid('fx-beta')] })

    expect(valueOf(await api.agentPresets.list(req({}))).presets).toHaveLength(3)
    valueOf(await api.agentPresets.select(req({ sessionId: sid('fx-alpha'), agentPreset: 'minimal' })))
    await expect(api.agentPresets.read(req({ agentPreset: 'missing' })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'agent-preset-not-found' } } })
    expect(valueOf(await api.agentPresets.read(req({ agentPreset: 'standard' }))).trust).toBe('system')
    await expect(api.agentPresets.copy(req({ from: 'missing', agentPreset: 'copy' })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'agent-preset-not-found' } } })
    await expect(api.agentPresets.copy(req({ from: 'standard', agentPreset: 'minimal' })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'agent-preset-invalid' } } })
    valueOf(await api.agentPresets.copy(req({ from: 'standard', agentPreset: 'copy' })))
    await expect(api.agentPresets.openDocument(req({ agentPreset: 'missing' }), new AbortController().signal))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'agent-preset-read-only' } } })
    await expect(api.agentPresets.openDocument(req({ agentPreset: 'standard' }), new AbortController().signal))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'agent-preset-read-only' } } })
    expect(valueOf(await api.agentPresets.openDocument(req({ agentPreset: 'copy' }), new AbortController().signal))).toEqual({ opened: true })
    await expect(api.agentPresets.remove(req({ agentPreset: 'standard' })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'agent-preset-read-only' } } })
    valueOf(await api.agentPresets.remove(req({ agentPreset: 'copy' })))
    valueOf(await api.agentPresets.remove(req({ agentPreset: 'missing' })))

    expect(valueOf(await api.settings.openDocument(req({}), new AbortController().signal))).toEqual({ opened: true })
    for (const response of [
      await api.settings.update(req({ ns: 'x', revision: 0, value: {} } as never)),
      await api.settings.replace(req({ ns: 'x', revision: 0, value: {} } as never)),
      await api.settings.mutate(req({ ns: 'x', revision: 0, operations: [] } as never)),
    ]) expect(response.result).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })
    expect(valueOf(await api.llm.providers(req({}))).providers).toHaveLength(4)
    expect(valueOf(await api.llm.models(req({}))).groups).toHaveLength(2)
    expect(valueOf(await api.llm.discoverModels(req({} as never), new AbortController().signal)).models.length).toBeGreaterThan(0)
    expect((await api.downloads.sessionLog(
      { sessionId: sid('fx-alpha') },
      new AbortController().signal,
    )).status).toBe(404)
  })

  it('covers subagent shims, queue rejection, model defaults, and retry guard failures', async () => {
    const api = createFixtureApi()
    expect(valueOf(await api.subagents.list(req({ parentSessionId: sid('fx-alpha') }))).parentAvailable).toBe(true)
    expect(valueOf(await api.subagents.history(req({
      parentSessionId: sid('fx-alpha'), childSessionId: sid('missing'), mode: 'continuable',
    })))).toEqual({ events: [], hasMore: false })
    expect(valueOf(await api.subagents.prompt(req({
      parentSessionId: sid('fx-alpha'), childSessionId: sid('fx-beta'), mode: 'continuable',
      content: [{ type: 'text', text: 'x' }],
    }), new AbortController().signal)).messageId).toContain('fx-beta')
    expect(valueOf(await api.subagents.interrupt(req({
      parentSessionId: sid('fx-alpha'), childSessionId: sid('fx-beta'), mode: 'continuable',
    }))).accepted).toBe(true)
    await expect(api.sessions.updateQueue(req({ sessionId: sid('fx-alpha'), itemId: 'missing', content: [] } as never)))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'queue-item-not-found' } } })
    expect(valueOf(await api.sessions.models(req({ sessionId: sid('missing') }))).current).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    expect(valueOf(await api.sessions.selectModel(req({
      sessionId: sid('fx-alpha'), provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max',
    }))).selected).toMatchObject({ reasoningEffort: 'max' })
    expect(() => { fixtureTiming().scheduleModelRetry('missing') }).toThrow(/no model retry scenario/)
    expect(() => { fixtureTiming().cancelModelRetryDuringBackoff('missing') }).toThrow(/no model retry scenario/)
    expect(() => { fixtureTiming().completeModelRetry('missing') }).toThrow(/no model retry scenario/)

    vi.useFakeTimers()
    fixtureTiming().beginModelRetry('retry-new')
    fixtureTiming().scheduleModelRetry('retry-new')
    fixtureTiming().scheduleModelRetry('retry-new')
    fixtureTiming().completeModelRetry('retry-new')
    fixtureTiming().startReasoningChunkStorm('storm-new', 65, 65, 1)
    await vi.runAllTimersAsync()

    const goalSession = valueOf(await api.sessions.create(req({ sessionId: sid('legacy-options') }))).sessionId
    const goal = valueOf(await api.goals.create(req({
      sessionId: goalSession, objective: 'legacy', maxGoalRounds: 5,
    })))
    await expect(api.goals.edit(req({
      sessionId: goalSession, ref: goal.ref, maxGoalRounds: 6,
    }))).resolves.toMatchObject({ result: { ok: true } })

    const selected = valueOf(await api.sessions.selectModel(req({
      sessionId: goalSession,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })))
    expect(selected.selected.reasoningEffort).toBe('max')
    await api.sessions.prompt(req({
      sessionId: goalSession,
      mode: 'queue',
      content: [{ type: 'text', text: 'report model' }],
    }))
    await api.sessions.cancel(req({ sessionId: goalSession }))
  })

  it('ranks search candidates and bounds snippets at both ends', async () => {
    const api = createFixtureApi({ empty: true })
    const cases = [
      ['search-a', `needle ${'tail '.repeat(40)}`],
      ['search-b', `${'head '.repeat(40)}needle`],
      ['search-c', 'needle needle'],
      ['search-d', 'needle short'],
      ['search-e', 'needle short'],
    ] as const
    for (const [id, message] of cases) {
      valueOf(await api.sessions.create(req({ sessionId: sid(id) })))
      fixtureTiming().appendUser(id, message)
    }
    fixtureTiming().appendUser('search-e', 'needle short')
    const result = valueOf(await api.sessions.search(req({ query: 'NEEDLE' }), new AbortController().signal))
    expect(result.items[0]?.sessionId).toBe(sid('search-c'))
    expect(result.items.some(item => item.snippet.startsWith('needle') && item.snippet.endsWith('…'))).toBe(true)
    expect(result.items.some(item => item.snippet.startsWith('…') && item.snippet.endsWith('needle'))).toBe(true)

    fixtureTiming().appendUser('search-a', `combining café ${String.fromCodePoint(0xE000)}`)
    await expect(api.sessions.search(req({ query: `CAFE ${String.fromCodePoint(0xE000)}` }), new AbortController().signal))
      .resolves.toMatchObject({ result: { ok: true, value: { items: [{ sessionId: 'search-a' }] } } })
    await expect(api.sessions.search(req({ query: '\u0301' }), new AbortController().signal))
      .resolves.toMatchObject({ result: { ok: true, value: { items: [] } } })

    vi.useFakeTimers()
    vi.setSystemTime(1)
    const ordered = createFixtureApi({ empty: true })
    for (const id of ['z-order', 'a-order']) {
      valueOf(await ordered.sessions.create(req({ sessionId: sid(id) })))
      fixtureTiming().appendUser(id, 'same needle')
    }
    const orderedResult = valueOf(await ordered.sessions.search(req({ query: 'needle' }), new AbortController().signal))
    expect(orderedResult.items.map(item => item.sessionId)).toEqual([sid('a-order'), sid('z-order')])
  })
})

describe('FixtureApiClient remaining dispatch rows', () => {
  it('routes every browser API family through the in-memory protocol dispatcher', async () => {
    const client = new FixtureApiClient()
    const id = sid('fx-alpha')
    await client.sessions.models({ sessionId: id })
    await client.sessions.selectModel({ sessionId: id, provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    await client.sessions.rename({ sessionId: id, title: 'dispatch title' })
    await client.sessions.fork({ sessionId: id })
    await client.sessions.attachment({ sessionId: id, attachmentId: 'fixture:image' as AttachmentIdType })
    await client.sessions.updateQueue({ sessionId: id, itemId: 'missing', content: [] } as never)
    await client.subagents.list({ parentSessionId: id })
    await client.subagents.history({ parentSessionId: id, childSessionId: sid('fx-beta'), mode: 'continuable' })
    await client.subagents.prompt({
      parentSessionId: id,
      childSessionId: sid('fx-beta'),
      mode: 'continuable',
      content: [{ type: 'text', text: 'x' }],
    }, new AbortController().signal)
    await client.subagents.interrupt({
      parentSessionId: id, childSessionId: sid('fx-beta'), mode: 'continuable',
    })
    await client.host.pickDirectory({})
    await client.host.listDirectory({})
    await client.host.createDirectory({ path: '/home/fixture', name: 'client-dir' })
    await client.host.openPath({ path: '/tmp/fixture' })

    const workspace = valueOf(await client.workspace.create({ path: '/tmp/client-dispatch' })).workspace
    await client.workspace.insertBefore({ workspaceId: workspace.workspaceId })
    const session = valueOf(await client.sessions.create({ workspaceId: workspace.workspaceId })).sessionId
    await client.workspace.archiveSession({ sessionId: session })
    await client.workspace.delete({ workspaceId: workspace.workspaceId })

    await client.agentPresets.list({})
    await client.agentPresets.select({ sessionId: id, agentPreset: 'minimal' })
    await client.agentPresets.read({ agentPreset: 'minimal' })
    await client.agentPresets.copy({ from: 'minimal', agentPreset: 'client-copy' })
    await client.agentPresets.openDocument({ agentPreset: 'client-copy' })
    await client.agentPresets.remove({ agentPreset: 'client-copy' })
    await client.settings.describe({})
    await client.settings.openDocument({})
    await client.settings.update({ ns: 'x', revision: 0, value: {} } as never)
    await client.settings.replace({ ns: 'x', revision: 0, value: {} } as never)
    await client.settings.mutate({ ns: 'x', revision: 0, operations: [] } as never)
    await client.credentials.describe({ refs: ['CLIENT_KEY'] })
    await client.credentials.set({ ref: 'CLIENT_KEY', value: 'secret' })
    await client.credentials.unset({ ref: 'CLIENT_KEY' })
    await client.llm.providers({})
    await client.llm.models({})
    await client.llm.discoverModels({} as never, new AbortController().signal)
  })
})
