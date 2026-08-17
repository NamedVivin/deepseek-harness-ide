/** Closed desktop Cordis composition booted by the bundled pure Node.js runtime. */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  loadLayeredEnv,
  loadOverlayPatches,
  resolveBundleDir,
} from '@deepseek-ai/dsh-app-boot'
import { DESKTOP_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets-desktop'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { parseDesktopRuntimeConfig, type DesktopRuntimeConfig } from './runtime-config.ts'

const NAME = 'dsh-desktop-sidecar'

/** Bundle layers in the only accepted packaged desktop composition. */
const DESKTOP_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-ide-app',
  '@deepseek-ai/dsh-desktop-app',
] as const)

/** Host facts supplied before any desktop config row evaluates. */
interface DesktopRuntimeFacts {
  /** Immutable package-owned desktop preset root. */
  readonly presetRoot: string
  /** Signed transport and lifecycle configuration shared with Electron main and guardian. */
  readonly config: DesktopRuntimeConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Signed desktop assembly facts supplied by the sidecar entrypoint. */
    desktopRuntime: DesktopRuntimeFacts
  }
}

interface BundleManifest {
  readonly dsh?: {
    readonly bundle?: {
      readonly patch?: unknown
    }
  }
}

/** Absolute app manifest path in both source and built layouts. */
const DESKTOP_INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
/** Signed empty config root in both source and built layouts. */
const DESKTOP_ROOT_CONFIG = fileURLToPath(new URL('../config/cordis.yml', import.meta.url))
/** Signed runtime configuration installed beside the immutable Cordis root. */
const DESKTOP_RUNTIME_CONFIG = fileURLToPath(new URL('../config/runtime.json', import.meta.url))

/**
 * Resolve bare Cordis rows from the installed Host closure, never a user-writable profile tree.
 * @param installAnchor - packaged desktop `package.json` path.
 * @returns file URL whose sibling `node_modules` is the deployed Host closure.
 */
export function desktopModuleResolverBaseUrl(installAnchor: string = DESKTOP_INSTALL_ANCHOR): string {
  return pathToFileURL(join(dirname(installAnchor), 'desktop-runtime-entry.mjs')).href
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function bundlePatchPath(packageName: string): string {
  const packageDir = resolveBundleDir(NAME, packageName, DESKTOP_INSTALL_ANCHOR, dirname(DESKTOP_INSTALL_ANCHOR))
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as BundleManifest
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch === '' || isAbsolute(patch)) {
    throw new Error(`${NAME}: ${packageName} does not declare one relative dsh.bundle.patch`)
  }
  const candidate = resolve(packageDir, normalize(patch))
  if (!isWithin(resolve(packageDir), candidate)) {
    throw new Error(`${NAME}: ${packageName} patch escapes its package directory`)
  }
  return candidate
}

/**
 * Load the immutable bundle patch stack in application order.
 * @returns fresh patch objects safe for Include's in-place composition.
 */
function loadDesktopPatches(): PatchOptions[] {
  return structuredClone(DESKTOP_BUNDLES.flatMap(packageName =>
    loadOverlayPatches(NAME, bundlePatchPath(packageName))))
}

/**
 * Boot the packaged Host with no profile or user patch layer.
 * @returns settled Cordis root whose module graph is ready for the renderer.
 */
export async function bootDesktopSidecar(): Promise<Context> {
  const environment = loadLayeredEnv(NAME)
  const config = parseDesktopRuntimeConfig(JSON.parse(readFileSync(DESKTOP_RUNTIME_CONFIG, 'utf8')) as unknown)
  const runtime: DesktopRuntimeFacts = Object.freeze({ presetRoot: DESKTOP_PRESET_ROOT, config })
  return boot(NAME, DESKTOP_ROOT_CONFIG, loadDesktopPatches(), (ctx) => {
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    ctx.provide('desktopRuntime', runtime)
  }, desktopModuleResolverBaseUrl())
}
