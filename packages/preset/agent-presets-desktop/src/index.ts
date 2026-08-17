/**
 * Immutable first-release desktop preset roster and admission policy.
 * @module @deepseek-ai/dsh-agent-presets-desktop
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { PresetAdmissionContribution } from '@deepseek-ai/dsh-agent-presets'

/** The only preset id accepted by the first desktop release. */
export const DESKTOP_PRESET_ID = 'desktop-default'

/** Stable RPC/admission code for a preset outside the desktop roster. */
export const DESKTOP_PRESET_UNSUPPORTED = 'desktop-preset-unsupported'

/** Absolute root containing the package-owned desktop roster. */
export const DESKTOP_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

/** SHA-256 of the complete package-owned `desktop-default` composition. */
export const DESKTOP_PRESET_COMPOSITION_SHA256 =
  '50e596b267b8edf4fbf94f6cb6c54400a5342eacf9ad4347367e0d8e65f99e88'

/** Plugin rows the immutable desktop composition contains, in file order. */
export const DESKTOP_PRESET_PLUGINS = Object.freeze([
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-todo',
] as const)

/** Desktop roster configuration failed its load-time safety checks. */
export class DesktopPresetStartupError extends Error {
  /** Stable startup failure code for launch diagnostics. */
  readonly code = 'desktop-preset-startup-invalid'

  /**
   * Construct a desktop roster startup failure.
   * @param reason - exact violated roster condition.
   */
  constructor(readonly reason: string) {
    super(`agent-presets-desktop: ${reason}`)
    this.name = 'DesktopPresetStartupError'
  }
}

/** Cordis plugin name. */
export const name = 'agent-presets-desktop'

/** The roster service whose operations this provider admits. */
export const inject = ['agentPresets']

const installations = new WeakSet<Context>()

const admission: PresetAdmissionContribution = {
  admit(request) {
    if (request.presetId === DESKTOP_PRESET_ID) return undefined
    return {
      code: DESKTOP_PRESET_UNSUPPORTED,
      reason: `desktop agents can use only preset "${DESKTOP_PRESET_ID}"`,
      details: { supportedPreset: DESKTOP_PRESET_ID },
    }
  },
}

/**
 * Assert that the service is configured over this package's exact roster.
 * @param presets - live agent-preset service before desktop admission is registered.
 */
async function validateRoster(presets: AgentPresets): Promise<void> {
  const roots = presets.roots
  if (roots.length !== 1
    || roots[0]?.trust !== 'system'
    || resolve(roots[0].path) !== resolve(DESKTOP_PRESET_ROOT)) {
    throw new DesktopPresetStartupError(
      `expected one system root at ${DESKTOP_PRESET_ROOT} and no user preset root`,
    )
  }
  if (presets.authorable) {
    throw new DesktopPresetStartupError('desktop roster must not expose preset authoring')
  }
  if (presets.defaultId !== DESKTOP_PRESET_ID) {
    throw new DesktopPresetStartupError(
      `default preset must be "${DESKTOP_PRESET_ID}", got "${presets.defaultId}"`,
    )
  }

  const roster = await presets.list()
  const only = roster[0]
  const expectedPath = join(DESKTOP_PRESET_ROOT, DESKTOP_PRESET_ID, 'agent.cordis.yml')
  if (roster.length !== 1
    || only?.id !== DESKTOP_PRESET_ID
    || only.trust !== 'system'
    || resolve(only.path) !== resolve(expectedPath)) {
    throw new DesktopPresetStartupError(
      `roster must contain only the system preset "${DESKTOP_PRESET_ID}"`,
    )
  }
  if (only.broken !== undefined) {
    throw new DesktopPresetStartupError(`desktop-default is not mountable: ${only.broken}`)
  }

  let content: string
  try {
    content = await readFile(expectedPath, 'utf8')
  } catch (error) {
    /* v8 ignore next -- package publication carries this required file; artifact smokes own missing-resource failures */
    throw new DesktopPresetStartupError(`cannot read desktop-default: ${String(error)}`)
  }
  const digest = createHash('sha256').update(content).digest('hex')
  /* v8 ignore next 3 -- the source test pins resource bytes to this digest; packaged-artifact tests own tampering */
  if (digest !== DESKTOP_PRESET_COMPOSITION_SHA256) {
    throw new DesktopPresetStartupError(
      'desktop-default differs from the package-owned immutable composition',
    )
  }
}

/**
 * Validate the package-owned roster and admit only `desktop-default`.
 * @param ctx - Host context carrying the agent-preset service.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => {
    const root = ctx.root
    if (installations.has(root)) {
      throw new DesktopPresetStartupError('exactly one desktop admission provider may be active')
    }
    installations.add(root)
    return () => { installations.delete(root) }
  }, 'agentPresetsDesktop.installation()')

  await validateRoster(ctx.agentPresets)
  ctx.agentPresets.registerAdmission(admission)
}
