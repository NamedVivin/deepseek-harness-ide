/** Pure runtime path, environment, and child-message selection for Electron main. */

import { join, resolve } from 'node:path'
import type { StdioOptions } from 'node:child_process'
import type { DesktopRuntimeConfig } from './runtime-config.ts'

/** Guardian descriptor inherited from Electron main and then by every macOS capsule. */
export const DESKTOP_MAIN_LIVENESS_FD = 4

/**
 * Select the guardian descriptors owned by Electron main.
 * @param platform - packaged target platform.
 * @returns stdio entries with a dedicated inherited main-liveness pipe on macOS.
 */
export function desktopGuardianStdio(platform: NodeJS.Platform): StdioOptions {
  if (platform === 'darwin') return ['ignore', 'pipe', 'pipe', 'ipc', 'pipe']
  if (platform === 'win32') return ['ignore', 'pipe', 'pipe', 'ipc']
  throw new Error(`desktop runtime: unsupported guardian platform ${platform}`)
}

/** Signed and external paths consumed by Electron main. */
export interface DesktopRuntimePaths {
  /** ASAR-visible signed runtime configuration. */
  readonly runtimeConfig: string
  /** ASAR-visible signed resource manifest. */
  readonly resourceManifest: string
  /** Bundled context-isolated preload. */
  readonly preload: string
  /** External immutable renderer and Client assets. */
  readonly assets: string
  /** External pure Node Host deployment. */
  readonly host: string
  /** External guardian entry within the Host deployment. */
  readonly guardian: string
  /** External pure Node sidecar entry owned by the guardian. */
  readonly sidecar: string
  /** Fixed signed macOS process-capsule helper. */
  readonly processCapsule: string
  /** Verified pure Node.js executable. */
  readonly node: string
}

/** Inputs supplied by Electron without exposing them to the renderer. */
export interface DesktopRuntimePathInput {
  /** `app.getAppPath()` result. */
  readonly appPath: string
  /** Electron `process.resourcesPath`. */
  readonly resourcesPath: string
  /** Whether Electron is running a packaged application. */
  readonly packaged: boolean
  /** Target platform selecting the Node executable layout. */
  readonly platform: NodeJS.Platform
}

/**
 * Resolve the fixed packaged resource layout.
 * @param input - Electron application and resource roots.
 * @returns absolute main-process-only resource paths.
 */
export function resolveDesktopRuntimePaths(input: DesktopRuntimePathInput): DesktopRuntimePaths {
  const appPath = resolve(input.appPath)
  const external = input.packaged
    ? join(resolve(input.resourcesPath), 'desktop-resources')
    : join(appPath, 'desktop-resources')
  const host = join(external, 'host')
  return {
    runtimeConfig: join(appPath, 'config', 'runtime.json'),
    resourceManifest: join(appPath, 'generated', 'desktop-resource-manifest.json'),
    preload: join(appPath, 'lib', 'preload.cjs'),
    assets: join(external, 'assets'),
    host,
    guardian: join(host, 'lib', 'guardian.js'),
    sidecar: join(host, 'lib', 'sidecar.js'),
    processCapsule: join(external, 'native', 'dsh-process-capsule'),
    node: input.platform === 'win32'
      ? join(external, 'runtime', 'node.exe')
      : join(external, 'runtime', 'bin', 'node'),
  }
}

/**
 * Build the guardian's closed app-owned command line.
 * @param paths - signed runtime resource paths.
 * @param config - validated signed lifecycle and transport settings.
 * @param platform - packaged target platform.
 * @returns exact guardian arguments, including the macOS ownership inputs only on Darwin.
 */
export function desktopGuardianArguments(
  paths: DesktopRuntimePaths,
  config: DesktopRuntimeConfig,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop runtime: unsupported guardian platform ${platform}`)
  }
  return [
    `--sidecar-entry=${paths.sidecar}`,
    `--max-body-bytes=${String(config.maxDesktopBodyBytes)}`,
    `--max-chunk-bytes=${String(config.maxDesktopChunkBytes)}`,
    `--max-inflight-bytes=${String(config.maxDesktopInflightBytes)}`,
    `--native-poll-ms=${String(config.nativeProcessPollMs)}`,
    `--graceful-shutdown-ms=${String(config.gracefulShutdownMs)}`,
    `--force-shutdown-ms=${String(config.forceShutdownMs)}`,
    `--mirror-timeout-ms=${String(config.mirrorTimeoutMs)}`,
    ...(platform === 'darwin'
      ? [
        `--capsule-helper=${paths.processCapsule}`,
        `--main-liveness-fd=${String(DESKTOP_MAIN_LIVENESS_FD)}`,
      ]
      : []),
  ]
}

const FORBIDDEN_EXACT_ENV = new Set([
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_UNIQUE_ID',
])

/**
 * Remove Electron and package-manager injection variables before pure Node starts.
 * @param source - Electron main environment.
 * @returns fresh sidecar environment retaining user credentials and application settings.
 */
export function scrubDesktopRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined
      || FORBIDDEN_EXACT_ENV.has(name)
      || name.startsWith('ELECTRON_')
      || name.startsWith('npm_')
      || name.startsWith('PNPM_')) continue
    result[name] = value
  }
  return result
}

const CONNECTION_OUTBOUND_TYPES = new Set([
  'body-start',
  'body-chunk',
  'body-ack',
  'body-end',
  'body-cancel',
  'renderer-result',
  'renderer-event',
  'renderer-end',
  'host-request',
  'host-cancel',
])

/**
 * Select only sidecar Connection frames from the shared guardian IPC channel.
 * @param value - raw guardian child message.
 * @returns whether the message belongs to the Connection peer.
 */
export function isDesktopConnectionOutboundMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).version === 1
    && typeof (value as Record<string, unknown>).type === 'string'
    && CONNECTION_OUTBOUND_TYPES.has((value as Record<string, unknown>).type as string)
}
