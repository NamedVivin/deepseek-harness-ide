import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets, {
  PresetAdmissionError,
  UnknownPresetError,
  type Config,
} from '@deepseek-ai/dsh-agent-presets'
import * as DesktopPresets from '@deepseek-ai/dsh-agent-presets-desktop'
import { load } from 'js-yaml'

let temporaryRoot: string | undefined
let liveContext: Context | undefined

afterEach(async () => {
  await liveContext?.fiber.dispose()
  liveContext = undefined
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

/** Compose the real roster service with optional startup misconfiguration. */
async function harness(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  liveContext = ctx
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(AgentPresets, {
    default: DesktopPresets.DESKTOP_PRESET_ID,
    roots: [{ path: DesktopPresets.DESKTOP_PRESET_ROOT, trust: 'system' }],
    includeUserRoot: false,
    ...config,
  })
  return ctx
}

describe('desktop preset admission', () => {
  it('pins the shipped composition bytes and its consumer-only plugin roster', async () => {
    const path = join(
      DesktopPresets.DESKTOP_PRESET_ROOT,
      DesktopPresets.DESKTOP_PRESET_ID,
      'agent.cordis.yml',
    )
    const content = await readFile(path, 'utf8')
    expect(createHash('sha256').update(content).digest('hex'))
      .toBe(DesktopPresets.DESKTOP_PRESET_COMPOSITION_SHA256)
    const rows = load(content, { schema: entryListSchema }) as Array<{
      name: string
      isolate?: Record<string, unknown>
    }>
    expect(rows.map(row => row.name)).toEqual(DesktopPresets.DESKTOP_PRESET_PLUGINS)
    expect(rows.every(row => row.isolate === undefined)).toBe(true)
    expect(rows.some(row => /(?:subprocess|terminal|pty|dsh-fs-(?:local|sandbox|e2b))/u.test(row.name)))
      .toBe(false)
  })

  it('admits only the package-owned desktop-default roster', async () => {
    const ctx = await harness()
    const discover = vi.spyOn(ctx.agentPresets, 'list')
    await ctx.plugin(DesktopPresets)
    discover.mockClear()

    await expect(ctx.agentPresets.resolve()).resolves.toMatchObject({
      id: 'desktop-default',
      trust: 'system',
    })
    discover.mockClear()
    await expect(ctx.agentPresets.resolve('standard')).rejects.toMatchObject({
      name: 'PresetAdmissionError',
      metadata: {
        code: 'desktop-preset-unsupported',
        operation: 'resolve',
        presetId: 'standard',
        reason: 'desktop agents can use only preset "desktop-default"',
        details: { supportedPreset: 'desktop-default' },
      },
    })
    expect(discover).not.toHaveBeenCalled()
  })

  it('removes admission with its owning fiber', async () => {
    const ctx = await harness()
    const fiber = await ctx.plugin(DesktopPresets)

    await expect(ctx.agentPresets.resolve('standard')).rejects.toBeInstanceOf(PresetAdmissionError)
    await fiber.dispose()
    await expect(ctx.agentPresets.resolve('standard')).rejects.toBeInstanceOf(UnknownPresetError)
  })

  it('fails startup before exposing a mutable or foreign roster', async () => {
    const ctx = await harness({ includeUserRoot: true })
    const startup = ctx.plugin(DesktopPresets)

    await expect(startup).rejects.toMatchObject({
      code: 'desktop-preset-startup-invalid',
    })
    await expect(startup).rejects.toThrow('no user preset root')
  })

  it('allows exactly one live desktop admission provider', async () => {
    const ctx = await harness()
    await ctx.plugin(DesktopPresets)

    await expect(ctx.plugin(DesktopPresets)).rejects.toMatchObject({
      code: 'desktop-preset-startup-invalid',
      reason: 'exactly one desktop admission provider may be active',
    })
  })

  it.each([
    ['no root', { roots: [] }, 'expected one system root'],
    ['user root', {
      roots: [{ path: DesktopPresets.DESKTOP_PRESET_ROOT, trust: 'user' }],
    }, 'expected one system root'],
    ['foreign root', {
      roots: [{ path: '/foreign-presets', trust: 'system' }],
    }, 'expected one system root'],
    ['authoring', { authorable: true }, 'must not expose preset authoring'],
    ['foreign default', { defaultId: 'standard' }, 'default preset must be'],
    ['empty roster', { roster: [] }, 'roster must contain only'],
    ['foreign id', { roster: [{ id: 'standard' }] }, 'roster must contain only'],
    ['user preset', { roster: [{ trust: 'user' }] }, 'roster must contain only'],
    ['foreign preset path', {
      roster: [{ path: '/foreign-presets/desktop-default/agent.cordis.yml' }],
    }, 'roster must contain only'],
    ['broken preset', { roster: [{ broken: 'invalid composition' }] }, 'is not mountable'],
  ] as const)('rejects %s startup configuration', async (_label, changes, message) => {
    const expectedPath = join(
      DesktopPresets.DESKTOP_PRESET_ROOT,
      DesktopPresets.DESKTOP_PRESET_ID,
      'agent.cordis.yml',
    )
    const basePreset = {
      id: DesktopPresets.DESKTOP_PRESET_ID,
      trust: 'system' as const,
      path: expectedPath,
    }
    const rosterChanges = 'roster' in changes ? changes.roster : undefined
    const roster = rosterChanges?.map(change => ({ ...basePreset, ...change })) ?? [basePreset]
    const service = {
      roots: [{ path: DesktopPresets.DESKTOP_PRESET_ROOT, trust: 'system' as const }],
      authorable: false,
      defaultId: DesktopPresets.DESKTOP_PRESET_ID,
      list: () => Promise.resolve(roster),
      registerAdmission: () => () => {},
      ...changes,
      roster: undefined,
    }
    const ctx = new Context()
    ctx.provide('agentPresets', service as never)

    await expect(ctx.plugin(DesktopPresets)).rejects.toThrow(message)
    await ctx.fiber.dispose()
  })
})

describe('desktop policy through a real Loader composition', () => {
  it('boots cordis.yml and refuses an unsupported preset before discovery', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-preset-loader-'))
    const configPath = join(temporaryRoot, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent-presets'",
      '  config:',
      '    default: desktop-default',
      '    includeUserRoot: false',
      '    roots:',
      `      - path: ${JSON.stringify(DesktopPresets.DESKTOP_PRESET_ROOT)}`,
      '        trust: system',
      "- name: '@deepseek-ai/dsh-agent-presets-desktop'",
      '',
    ].join('\n'))

    const ctx = new Context()
    liveContext = ctx
    ctx.baseUrl = pathToFileURL(temporaryRoot).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent-presets', AgentPresets],
      ['@deepseek-ai/dsh-agent-presets-desktop', DesktopPresets],
    ])
    ctx.loader.internal = {
      version: 'v2',
      import(specifier: string) {
        const resolved = modules.get(specifier)
        if (resolved === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return Promise.resolve(resolved)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    await expect(ctx.agentPresets.resolve('minimal')).rejects.toMatchObject({
      metadata: { code: 'desktop-preset-unsupported', presetId: 'minimal' },
    })
  })
})
