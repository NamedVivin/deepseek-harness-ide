/** Deterministic resource assembly shared by the Forge hook and package tests. */

import { createHash } from 'node:crypto'
import { fork, spawn, type ChildProcess, type ForkOptions } from 'node:child_process'
import { constants as fsConstants, existsSync } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extract } from '@electron-internal/extract-zip'
import { scrubDesktopRuntimeEnvironment } from './main-runtime.ts'
import type { DesktopAssetEntry, DesktopAssetManifest } from './resource-manifest.ts'
import { parseDesktopRuntimeConfig } from './runtime-config.ts'
import {
  DESKTOP_RUNTIME_PROTOCOL_VERSION,
  parseDesktopRuntimeOutboundFrame,
  type DesktopRuntimeInboundFrame,
} from './runtime-protocol.ts'

/** Node.js release carried by every first-version desktop package. */
export const DESKTOP_NODE_VERSION = 'v24.16.0'
/** Electron release whose native distribution and Chromium notices are packaged. */
export const DESKTOP_ELECTRON_VERSION = '43.2.0'
/** Directory generated immediately before Electron Forge packages the application. */
const DESKTOP_STAGE_DIRECTORY = 'desktop-resources'
/** Manifest copied into the signed ASAR and used to authorize external resources. */
const DESKTOP_GENERATED_MANIFEST = 'generated/desktop-resource-manifest.json'
/** Tail retained when a closure probe fails before its Host can publish diagnostics elsewhere. */
const DESKTOP_PROBE_STDERR_BYTES = 256 * 1024

/** Inputs supplied by the native packaging job for an official Node.js runtime. */
export interface DesktopNodeRuntimeInput {
  /** Extracted official Node.js distribution root. */
  root: string
  /** Downloaded official archive whose digest is listed in `SHASUMS256.txt`. */
  archive: string
  /** Official release `SHASUMS256.txt`. */
  shasums: string
}

/** Inputs supplied by the native packaging job for an official Electron distribution. */
export interface DesktopElectronRuntimeInput {
  /** Downloaded official Electron ZIP for the native target. */
  archive: string
  /** Official Electron release `SHASUMS256.txt`. */
  shasums: string
}

/** Target facts used to select and probe the bundled runtime. */
export interface DesktopAssemblyTarget {
  /** Native target operating system. */
  platform: 'darwin' | 'win32'
  /** Native target CPU architecture. */
  arch: 'arm64' | 'x64'
}

interface ClientPackageManifest {
  readonly name?: unknown
  readonly exports?: unknown
  readonly dsh?: unknown
}

interface ClientDeclaration {
  readonly platform?: unknown
}

interface PackageDeclaration {
  readonly client?: unknown
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function shortRevision(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 12)
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.map': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    case '.wasm': return 'application/wasm'
    default: return 'application/octet-stream'
  }
}

function safeRelativeSegments(path: string): string[] {
  const segments = path.split(sep)
  if (segments.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`desktop assembly: unsafe relative path ${JSON.stringify(path)}`)
  }
  return segments
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(`desktop assembly: symbolic link is forbidden in signed resources: ${path}`)
      }
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files
}

function clientExport(manifest: ClientPackageManifest): string | undefined {
  if (typeof manifest.exports !== 'object' || manifest.exports === null) return undefined
  const value = (manifest.exports as Record<string, unknown>)['./client']
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const fallback = (value as Record<string, unknown>).default
  return typeof fallback === 'string' ? fallback : undefined
}

function isWebClientPackage(manifest: ClientPackageManifest): manifest is ClientPackageManifest & { name: string } {
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/dsh-')) return false
  if (typeof manifest.dsh !== 'object' || manifest.dsh === null) return false
  const declaration = manifest.dsh as PackageDeclaration
  if (typeof declaration.client !== 'object' || declaration.client === null) return false
  return (declaration.client as ClientDeclaration).platform === 'web'
}

/**
 * Compute the official Node.js archive basename for one supported target.
 * @param target - native desktop target.
 * @returns exact release archive basename.
 */
export function desktopNodeArchiveName(target: DesktopAssemblyTarget): string {
  const suffix = target.platform === 'win32'
    ? `win-${target.arch}.zip`
    : `darwin-${target.arch}.tar.gz`
  return `node-${DESKTOP_NODE_VERSION}-${suffix}`
}

/**
 * Compute the official Electron archive basename for one supported target.
 * @param target - native desktop target.
 * @returns exact release archive basename.
 */
export function desktopElectronArchiveName(target: DesktopAssemblyTarget): string {
  return `electron-v${DESKTOP_ELECTRON_VERSION}-${target.platform}-${target.arch}.zip`
}

/**
 * Parse one official SHA-256 list and return the expected archive digest.
 * @param text - `SHASUMS256.txt` contents.
 * @param archiveName - exact archive basename.
 * @returns lowercase SHA-256 digest.
 */
export function parseNodeArchiveDigest(text: string, archiveName: string): string {
  const matches = text.split(/\r?\n/u).flatMap((line) => {
    const match = /^([0-9a-f]{64})\s{2}(.+)$/u.exec(line)
    return match?.[2] === archiveName ? [match[1] as string] : []
  })
  if (matches.length !== 1) {
    throw new Error(`desktop assembly: official SHA-256 list must contain ${archiveName} exactly once`)
  }
  return matches[0] as string
}

/**
 * Parse one official Electron SHA-256 list and return the expected archive digest.
 * @param text - Electron `SHASUMS256.txt` contents.
 * @param archiveName - exact Electron archive basename.
 * @returns lowercase SHA-256 digest.
 */
export function parseElectronArchiveDigest(text: string, archiveName: string): string {
  const matches = text.split(/\r?\n/u).flatMap((line) => {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/u.exec(line)
    return match?.[2] === archiveName ? [match[1] as string] : []
  })
  if (matches.length !== 1) {
    throw new Error(`desktop assembly: official Electron SHA-256 list must contain ${archiveName} exactly once`)
  }
  return matches[0] as string
}

/**
 * Encode one package id as a filesystem-safe resource segment.
 * @param id - first-party Client package name.
 * @returns reversible base64url segment without path separators.
 */
export function clientResourceSegment(id: string): string {
  if (!id.startsWith('@deepseek-ai/dsh-')) {
    throw new Error(`desktop assembly: third-party Client package is not admitted: ${id}`)
  }
  return Buffer.from(id, 'utf8').toString('base64url')
}

/**
 * Assert that the native target is one of the first-version release targets.
 * @param platform - Node platform name.
 * @param arch - Node architecture name.
 * @returns validated target facts.
 */
export function resolveDesktopAssemblyTarget(platform: NodeJS.Platform, arch: string): DesktopAssemblyTarget {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return { platform, arch }
  if (platform === 'win32' && arch === 'x64') return { platform, arch }
  throw new Error(`desktop assembly: unsupported target ${platform}-${arch}`)
}

/**
 * Require the generated notice to describe every executable payload added by assembly.
 * @param text - complete generated `THIRD_PARTY_NOTICES.md` contents.
 */
export function verifyDesktopLegalNotices(text: string): void {
  const required = [
    '## Packaged desktop executable payloads',
    `Electron ${DESKTOP_ELECTRON_VERSION}`,
    DESKTOP_NODE_VERSION,
    '`LICENSES.chromium.html`',
    '`@vscode/ripgrep`',
    '`koffi`',
    '`dsh-process-capsule`',
  ] as const
  const missing = required.filter(value => !text.includes(value))
  if (missing.length > 0) {
    throw new Error(`desktop assembly: THIRD_PARTY_NOTICES.md is missing ${missing.join(', ')}`)
  }
}

/**
 * Extract Electron and Chromium license files from the verified native distribution.
 * @param input - official Electron distribution inputs.
 * @param target - native package target.
 * @param destination - absolute stage directory for Electron legal files.
 * @returns after both required license files have been copied and temporary files removed.
 */
export async function assembleElectronLegalNotices(
  input: DesktopElectronRuntimeInput,
  target: DesktopAssemblyTarget,
  destination: string,
): Promise<void> {
  if (!isAbsolute(destination)) {
    throw new Error('desktop assembly: Electron legal destination must be absolute')
  }
  const archiveName = desktopElectronArchiveName(target)
  if (basename(input.archive) !== archiveName) {
    throw new Error(`desktop assembly: Electron archive must be named ${archiveName}`)
  }
  const expected = parseElectronArchiveDigest(await readFile(input.shasums, 'utf8'), archiveName)
  const actual = sha256(await readFile(input.archive))
  if (actual !== expected) {
    throw new Error(`desktop assembly: Electron archive digest mismatch for ${archiveName}`)
  }

  const extracted = await mkdtemp(join(tmpdir(), 'dsh-desktop-electron-'))
  try {
    await extract(input.archive, { dir: extracted })
    const sources = ['LICENSE', 'LICENSES.chromium.html'] as const
    for (const name of sources) {
      const source = join(extracted, name)
      const metadata = await lstat(source)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
        throw new Error(`desktop assembly: Electron distribution has no non-empty regular ${name}`)
      }
      await copyFile(source, join(destination, name))
    }
  } finally {
    await rm(extracted, { recursive: true, force: true })
  }
}

async function assembleLegalNotices(
  repoRoot: string,
  stageRoot: string,
  electron: DesktopElectronRuntimeInput,
  target: DesktopAssemblyTarget,
): Promise<void> {
  const noticeSource = join(repoRoot, 'THIRD_PARTY_NOTICES.md')
  verifyDesktopLegalNotices(await readFile(noticeSource, 'utf8'))
  const electronLegalRoot = join(stageRoot, 'legal', 'electron')
  await mkdir(electronLegalRoot, { recursive: true })
  await Promise.all([
    copyFile(join(repoRoot, 'LICENSE'), join(stageRoot, 'LICENSE')),
    copyFile(noticeSource, join(stageRoot, 'THIRD_PARTY_NOTICES.md')),
    assembleElectronLegalNotices(electron, target, electronLegalRoot),
  ])
}

async function addResource(
  source: string,
  destination: string,
  url: string,
  segments: string[],
): Promise<DesktopAssetEntry> {
  const bytes = await readFile(source)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
  return { url, segments, sha256: sha256(bytes), mediaType: mediaType(destination) }
}

async function assembleShell(rendererRoot: string, assetRoot: string): Promise<DesktopAssetEntry[]> {
  const entries: DesktopAssetEntry[] = []
  for (const source of await walkFiles(rendererRoot)) {
    const rel = relative(rendererRoot, source)
    const relativeSegments = safeRelativeSegments(rel)
    const segments = ['shell', ...relativeSegments]
    entries.push(await addResource(
      source,
      join(assetRoot, ...segments),
      `dsh-app://shell/${relativeSegments.join('/')}`,
      segments,
    ))
  }
  if (!entries.some(entry => entry.url === 'dsh-app://shell/index.html')) {
    throw new Error('desktop assembly: renderer does not contain index.html')
  }
  return entries
}

async function packageManifestPaths(nodeModules: string): Promise<string[]> {
  const manifests: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.bin') continue
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(`desktop assembly: deployed Host contains symbolic link ${path}`)
      }
      if (!metadata.isDirectory()) continue
      if (entry.name.startsWith('@')) {
        await visit(path)
        continue
      }
      const manifestPath = join(path, 'package.json')
      if (existsSync(manifestPath)) manifests.push(manifestPath)
      const nested = join(path, 'node_modules')
      if (existsSync(nested)) await visit(nested)
    }
  }
  await visit(nodeModules)
  return manifests
}

async function assembleClientBundles(hostRoot: string, assetRoot: string): Promise<DesktopAssetEntry[]> {
  const entries: DesktopAssetEntry[] = []
  const seenIds = new Set<string>()
  for (const manifestPath of await packageManifestPaths(join(hostRoot, 'node_modules'))) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ClientPackageManifest
    if (!isWebClientPackage(manifest)) continue
    if (seenIds.has(manifest.name)) continue
    const exported = clientExport(manifest)
    if (exported === undefined || !exported.startsWith('./')) {
      throw new Error(`desktop assembly: ${manifest.name} has no relative exports["./client"]`)
    }
    const packageRoot = dirname(manifestPath)
    const source = await realpath(resolve(packageRoot, exported))
    const canonicalPackageRoot = await realpath(packageRoot)
    if (!isWithin(canonicalPackageRoot, source) || !(await stat(source)).isFile()) {
      throw new Error(`desktop assembly: ${manifest.name} Client export escapes its package`)
    }
    const bytes = await readFile(source)
    const revision = shortRevision(bytes)
    const encoded = clientResourceSegment(manifest.name)
    const segments = ['plugins', encoded, 'client.js']
    const destination = join(assetRoot, ...segments)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
    entries.push({
      url: `dsh-app://plugins/${manifest.name}/client.js?rev=${revision}`,
      segments,
      sha256: sha256(bytes),
      mediaType: 'text/javascript; charset=utf-8',
    })
    seenIds.add(manifest.name)
  }
  return entries
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(
        `desktop assembly: ${command} failed with ${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`}`,
      ))
    })
  })
}

async function materializeSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      if (entry.name === '.bin' || path.includes(`${sep}.bin${sep}`)) {
        await rm(path, { recursive: true, force: true })
        continue
      }
      const source = await realpath(path)
      await rm(path, { recursive: true, force: true })
      await cp(source, path, { recursive: true, dereference: true })
      await materializeSymlinks(path)
      continue
    }
    if (metadata.isDirectory()) await materializeSymlinks(path)
  }
}

const OMITTED_DESKTOP_PLATFORM_PACKAGES = Object.freeze([
  'node-addon-landlock-run-linux-arm64',
  'node-addon-landlock-run-linux-x64',
] as const)

/**
 * Remove Linux-only launcher payloads that pnpm deploy carries from workspace optional dependencies.
 * @param hostRoot - absolute deployed desktop Host root.
 * @returns after every unsupported platform package has been removed.
 */
export async function pruneDesktopHostPlatformPayloads(hostRoot: string): Promise<void> {
  if (!isAbsolute(hostRoot)) {
    throw new Error('desktop assembly: Host deployment root must be absolute')
  }
  const scope = join(resolve(hostRoot), 'node_modules', '@deepseek-ai')
  await Promise.all(OMITTED_DESKTOP_PLATFORM_PACKAGES.map(packageName =>
    rm(join(scope, packageName), { recursive: true, force: true })))
}

/**
 * Build the locked modern-deploy invocation for the portable Host closure.
 * @param hostRoot - absolute deployment destination under the assembly stage.
 * @returns pnpm arguments that forbid legacy resolution and lockfile drift.
 */
export function desktopDeployArguments(hostRoot: string): string[] {
  if (!isAbsolute(hostRoot)) {
    throw new Error('desktop assembly: Host deployment destination must be absolute')
  }
  return [
    '--filter',
    '@deepseek-ai/dsh-desktop',
    'deploy',
    '--prod',
    '--config.inject-workspace-packages=true',
    '--config.frozen-lockfile=true',
    '--config.node-linker=hoisted',
    '--config.link-workspace-packages=true',
    hostRoot,
  ]
}

async function deployHost(repoRoot: string, hostRoot: string): Promise<void> {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  await run(pnpm, desktopDeployArguments(hostRoot), repoRoot)
  await pruneDesktopHostPlatformPayloads(hostRoot)
  await materializeSymlinks(hostRoot)
  if (!existsSync(join(hostRoot, 'lib', 'sidecar.js'))) {
    throw new Error('desktop assembly: deployed Host is missing lib/sidecar.js')
  }
  const guardianHost = join(
    hostRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-subprocess-guardian',
    'lib',
    'host.js',
  )
  try {
    const revision = sha256(await readFile(guardianHost))
    await import(`${pathToFileURL(guardianHost).href}?rev=${revision}`)
  } catch (cause) {
    throw new Error('desktop assembly: deployed guardian Host entry cannot be linked', { cause })
  }
}

interface DesktopProbeExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface DesktopProbeStderr {
  bytes: Buffer
  truncated: boolean
}

function boundedProbeWait<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`desktop assembly: deployed Host closure ${label} timed out after ${String(milliseconds)} ms`))
    }, milliseconds)
    timer.unref()
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error
          ? error
          : new Error('desktop assembly: deployed Host closure wait failed', { cause: error }))
      },
    )
  })
}

function appendProbeStderr(state: DesktopProbeStderr, chunk: Uint8Array): void {
  const combined = Buffer.concat([state.bytes, Buffer.from(chunk)])
  if (combined.byteLength <= DESKTOP_PROBE_STDERR_BYTES) {
    state.bytes = combined
    return
  }
  state.bytes = combined.subarray(combined.byteLength - DESKTOP_PROBE_STDERR_BYTES)
  state.truncated = true
}

function claimsDesktopRuntimeLifecycle(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === 'string'
    && ((value as Record<string, unknown>).type as string).startsWith('desktop-runtime-')
}

function sendProbeDispose(child: ChildProcess): Promise<void> {
  const frame: DesktopRuntimeInboundFrame = {
    version: DESKTOP_RUNTIME_PROTOCOL_VERSION,
    type: 'desktop-runtime-dispose',
    reason: 'app-quit',
  }
  return new Promise<void>((resolvePromise, reject) => {
    if (!child.connected) {
      reject(new Error('desktop assembly: deployed Host closure IPC disconnected before disposal'))
      return
    }
    try {
      child.send(frame, (error) => {
        if (error === null) resolvePromise()
        else reject(error)
      })
    } catch (error) {
      reject(error instanceof Error
        ? error
        : new Error('desktop assembly: deployed Host closure disposal send failed', { cause: error }))
    }
  })
}

async function forceProbeJoin(
  child: ChildProcess,
  exited: Promise<DesktopProbeExit>,
  closed: Promise<void>,
  milliseconds: number,
): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  if (child.pid === undefined) {
    await boundedProbeWait(closed, milliseconds, 'failed-spawn cleanup')
    return
  }
  await boundedProbeWait(Promise.all([exited, closed]).then(() => undefined), milliseconds, 'forced join')
}

function probeFailure(error: unknown, cleanupError: unknown, stderr: DesktopProbeStderr): Error {
  const primary = error instanceof Error ? error : new Error(String(error))
  const cleanup = cleanupError === undefined
    ? undefined
    : cleanupError instanceof Error
      ? cleanupError
      : new Error('desktop Host closure probe cleanup threw a non-Error value', { cause: cleanupError })
  const stderrText = stderr.bytes.toString('utf8').trimEnd()
  const cleanupText = cleanup === undefined ? '' : `; cleanup failed: ${cleanup.message}`
  const diagnostic = stderrText === ''
    ? ''
    : `\n[sidecar stderr tail${stderr.truncated ? ', truncated' : ''}]\n${stderrText}`
  const cause = cleanup === undefined
    ? primary
    : new AggregateError([primary, cleanup], 'desktop Host closure probe and cleanup failed')
  return new Error(
    `desktop assembly: deployed Host closure probe failed: ${primary.message}${cleanupText}${diagnostic}`,
    { cause },
  )
}

/**
 * Boot and quiesce the deployed Host with the bundled Node runtime before packaging.
 * @param nodeBinary - verified bundled Node executable for the native target.
 * @param hostRoot - deployed desktop Host root containing `lib/sidecar.js` and signed runtime config.
 * @returns after ready, disposal, IPC disconnect, stderr close, and a clean process exit.
 */
export async function probeDesktopHostClosure(nodeBinary: string, hostRoot: string): Promise<void> {
  if (!isAbsolute(nodeBinary) || !isAbsolute(hostRoot)) {
    throw new Error('desktop assembly: Host closure probe paths must be absolute')
  }
  const sidecar = join(hostRoot, 'lib', 'sidecar.js')
  await Promise.all([
    access(nodeBinary, fsConstants.X_OK),
    access(sidecar, fsConstants.R_OK),
  ])
  const config = parseDesktopRuntimeConfig(
    JSON.parse(await readFile(join(hostRoot, 'config', 'runtime.json'), 'utf8')) as unknown,
  )
  const probeHome = await mkdtemp(join(tmpdir(), 'dsh-desktop-host-probe-'))
  const stderr: DesktopProbeStderr = { bytes: Buffer.alloc(0), truncated: false }
  let child: ChildProcess | undefined
  let probeExited: Promise<DesktopProbeExit> | undefined
  let probeClosed: Promise<void> | undefined
  try {
    try {
      const forkOptions = {
        cwd: hostRoot,
        execPath: nodeBinary,
        execArgv: [],
        env: {
          ...scrubDesktopRuntimeEnvironment(process.env),
          DSH_HOME: probeHome,
          DSH_TELEMETRY_DISABLED: '1',
          DSH_TELEMETRY_MODE: 'DISABLED',
        },
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      } satisfies ForkOptions & { readonly windowsHide: true }
      child = fork(sidecar, [], forkOptions)
      child.stderr?.on('data', (chunk: Uint8Array) => { appendProbeStderr(stderr, chunk) })

      const ready = Promise.withResolvers<void>()
      const disposed = Promise.withResolvers<void>()
      const disconnected = Promise.withResolvers<void>()
      const exited = Promise.withResolvers<DesktopProbeExit>()
      const closed = Promise.withResolvers<void>()
      probeExited = exited.promise
      probeClosed = closed.promise
      const fatal = Promise.withResolvers<never>()
      void fatal.promise.catch(() => undefined)
      let terminalFailure: Error | undefined
      let readySeen = false
      let disposeSent = false
      let disposedSeen = false
      const fail = (error: Error): void => {
        terminalFailure ??= error
        fatal.reject(terminalFailure)
      }

      child.on('message', (value: unknown) => {
        const frame = parseDesktopRuntimeOutboundFrame(value)
        if (frame === undefined) {
          if (claimsDesktopRuntimeLifecycle(value)) {
            fail(new Error('desktop assembly: deployed Host sent an invalid lifecycle frame'))
          }
          return
        }
        switch (frame.type) {
          case 'desktop-runtime-ready':
            if (readySeen) {
              fail(new Error('desktop assembly: deployed Host sent desktop-runtime-ready more than once'))
              return
            }
            readySeen = true
            ready.resolve()
            return
          case 'desktop-runtime-failed':
            fail(new Error(`desktop assembly: deployed Host reported startup failure: ${frame.message}`))
            return
          case 'desktop-runtime-disposed':
            if (!disposeSent || disposedSeen) {
              fail(new Error('desktop assembly: deployed Host sent desktop-runtime-disposed out of sequence'))
              return
            }
            disposedSeen = true
            disposed.resolve()
            return
        }
      })
      child.once('error', (error) => {
        fail(new Error('desktop assembly: deployed Host process error', { cause: error }))
      })
      child.once('disconnect', () => {
        disconnected.resolve()
        if (!disposedSeen) {
          fail(new Error('desktop assembly: deployed Host IPC disconnected before disposal completed'))
        }
      })
      child.once('exit', (code, signal) => {
        exited.resolve({ code, signal })
        if (!readySeen) {
          fail(new Error(
            `desktop assembly: deployed Host exited before ready (${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`})`,
          ))
        } else if (!disposedSeen) {
          fail(new Error('desktop assembly: deployed Host exited before disposal completed'))
        } else if (code !== 0 || signal !== null) {
          fail(new Error(
            `desktop assembly: deployed Host exited uncleanly (${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`})`,
          ))
        }
      })
      child.once('close', () => { closed.resolve() })

      await boundedProbeWait(
        Promise.race([ready.promise, fatal.promise]),
        config.startupTimeoutMs,
        'startup',
      )
      disposeSent = true
      await boundedProbeWait(
        (async () => {
          await Promise.race([sendProbeDispose(child), fatal.promise])
          await Promise.race([
            Promise.all([
              disposed.promise,
              disconnected.promise,
              exited.promise,
              closed.promise,
            ]).then(() => undefined),
            fatal.promise,
          ])
        })(),
        config.gracefulShutdownMs,
        'graceful shutdown',
      )
    } catch (error) {
      let cleanupError: unknown
      if (child !== undefined && probeExited !== undefined && probeClosed !== undefined) {
        try {
          await forceProbeJoin(child, probeExited, probeClosed, config.forceShutdownMs)
        } catch (forceError) {
          cleanupError = forceError
        }
      }
      throw probeFailure(error, cleanupError, stderr)
    }
  } finally {
    await rm(probeHome, { recursive: true, force: true })
  }
}

async function probeNode(binary: string, target: DesktopAssemblyTarget): Promise<void> {
  await access(binary, fsConstants.X_OK)
  const output: Uint8Array[] = []
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, ['-p', 'JSON.stringify([process.version,process.platform,process.arch])'], {
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: false,
    })
    child.stdout.on('data', (chunk) => { output.push(chunk as Uint8Array) })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop assembly: bundled Node probe exited ${String(code)}`))
    })
  })
  const value = JSON.parse(Buffer.concat(output).toString('utf8')) as unknown
  if (!Array.isArray(value) || value[0] !== DESKTOP_NODE_VERSION
    || value[1] !== target.platform || value[2] !== target.arch) {
    throw new Error(`desktop assembly: bundled Node probe mismatch: ${JSON.stringify(value)}`)
  }
}

async function assembleNodeRuntime(
  input: DesktopNodeRuntimeInput,
  target: DesktopAssemblyTarget,
  destination: string,
): Promise<void> {
  const archiveName = desktopNodeArchiveName(target)
  if (basename(input.archive) !== archiveName) {
    throw new Error(`desktop assembly: Node archive must be named ${archiveName}`)
  }
  const expected = parseNodeArchiveDigest(await readFile(input.shasums, 'utf8'), archiveName)
  const actual = sha256(await readFile(input.archive))
  if (actual !== expected) throw new Error(`desktop assembly: Node archive digest mismatch for ${archiveName}`)
  const sourceBinary = target.platform === 'win32'
    ? join(input.root, 'node.exe')
    : join(input.root, 'bin', 'node')
  await probeNode(sourceBinary, target)
  const destinationBinary = target.platform === 'win32'
    ? join(destination, 'node.exe')
    : join(destination, 'bin', 'node')
  await mkdir(dirname(destinationBinary), { recursive: true })
  await copyFile(sourceBinary, destinationBinary)
  if (target.platform !== 'win32') await chmod(destinationBinary, 0o755)
  const license = join(input.root, 'LICENSE')
  if (!existsSync(license)) throw new Error('desktop assembly: official Node runtime is missing LICENSE')
  await copyFile(license, join(destination, 'LICENSE'))
}

async function assembleIcons(appRoot: string): Promise<void> {
  const [{ default: sharp }, png2icons] = await Promise.all([
    import('sharp'),
    import('png2icons'),
  ])
  const source = await readFile(join(appRoot, 'assets', 'icon.svg'))
  const png = await sharp(source).resize(1024, 1024, { fit: 'contain' }).png().toBuffer()
  const icns = png2icons.createICNS(png, png2icons.BICUBIC2, 0)
  const ico = png2icons.createICO(png, png2icons.BICUBIC2, 0, false, true)
  if (icns === null || ico === null) throw new Error('desktop assembly: icon conversion failed')
  const generated = join(appRoot, 'generated')
  await mkdir(generated, { recursive: true })
  await Promise.all([
    writeFile(join(generated, 'app.png'), png),
    writeFile(join(generated, 'app.icns'), icns),
    writeFile(join(generated, 'app.ico'), ico),
  ])
}

async function assembleNativePayload(
  appRoot: string,
  stageRoot: string,
  target: DesktopAssemblyTarget,
): Promise<void> {
  if (target.platform === 'win32') return
  const architecture = target.arch === 'arm64' ? 'arm64' : 'x86_64'
  await run('sh', [
    join(appRoot, 'native', 'process-capsule', 'build.sh'),
    architecture,
    join(stageRoot, 'native', 'dsh-process-capsule'),
  ], appRoot)
}

/** Full deterministic desktop resource assembly performed before Forge packaging. */
export class DesktopResourceAssembler {
  private readonly appRoot: string
  private readonly repoRoot: string
  private readonly stageRoot: string

  /**
   * @param appRoot - `apps/desktop` directory.
   */
  constructor(appRoot: string) {
    this.appRoot = resolve(appRoot)
    this.repoRoot = resolve(this.appRoot, '..', '..')
    this.stageRoot = join(this.appRoot, DESKTOP_STAGE_DIRECTORY)
  }

  /**
   * Rebuild the Host deployment, signed assets, and verified Node runtime.
   * @param runtime - official Node distribution inputs.
   * @param electron - official Electron distribution inputs.
   * @param target - native package target.
   */
  async assemble(
    runtime: DesktopNodeRuntimeInput,
    electron: DesktopElectronRuntimeInput,
    target: DesktopAssemblyTarget,
  ): Promise<void> {
    if (this.stageRoot === this.repoRoot || this.repoRoot.startsWith(`${this.stageRoot}${sep}`)) {
      throw new Error(`desktop assembly: refusing to replace unsafe stage root ${this.stageRoot}`)
    }
    await rm(this.stageRoot, { recursive: true, force: true })
    await mkdir(this.stageRoot, { recursive: true })
    await assembleLegalNotices(this.repoRoot, this.stageRoot, electron, target)
    const hostRoot = join(this.stageRoot, 'host')
    const assetRoot = join(this.stageRoot, 'assets')
    await deployHost(this.repoRoot, hostRoot)
    const assets = [
      ...await assembleShell(join(this.appRoot, 'renderer'), assetRoot),
      ...await assembleClientBundles(hostRoot, assetRoot),
    ].sort((left, right) => left.url.localeCompare(right.url))
    const manifest: DesktopAssetManifest = { version: 1, assets }
    const generatedManifest = join(this.appRoot, DESKTOP_GENERATED_MANIFEST)
    await mkdir(dirname(generatedManifest), { recursive: true })
    await writeFile(generatedManifest, `${JSON.stringify(manifest, null, 2)}\n`)
    const runtimeRoot = join(this.stageRoot, 'runtime')
    await assembleNodeRuntime(runtime, target, runtimeRoot)
    await probeDesktopHostClosure(
      target.platform === 'win32' ? join(runtimeRoot, 'node.exe') : join(runtimeRoot, 'bin', 'node'),
      hostRoot,
    )
    await assembleNativePayload(this.appRoot, this.stageRoot, target)
    await assembleIcons(this.appRoot)
  }
}

/** Absolute application root for assembly entrypoints. */
export const DESKTOP_APP_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
