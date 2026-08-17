/** Native desktop release layout and payload verification shared by CI and focused tests. */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  DESKTOP_NODE_VERSION,
  desktopElectronArchiveName,
  desktopNodeArchiveName,
  verifyDesktopLegalNotices,
} from './assembly.ts'

/** Stable identifier for one supported native desktop release target. */
type DesktopReleaseTargetId = 'macos-arm64' | 'macos-x64' | 'windows-x64'

/** Native build facts that must agree across the runner, Node archive, Forge output, and payload. */
export interface DesktopReleaseTarget {
  /** Workflow and CLI identifier. */
  readonly id: DesktopReleaseTargetId
  /** Required GitHub-hosted runner label. */
  readonly runner: 'macos-15' | 'macos-15-intel' | 'windows-2025'
  /** Node and Electron platform. */
  readonly platform: 'darwin' | 'win32'
  /** Native CPU architecture. */
  readonly arch: 'arm64' | 'x64'
  /** Exact official Node.js distribution archive. */
  readonly nodeArchive: string
  /** Exact official Electron distribution archive. */
  readonly electronArchive: string
}

/** Closed first-release target matrix. */
export const DESKTOP_RELEASE_TARGETS: readonly DesktopReleaseTarget[] = Object.freeze([
  {
    id: 'macos-arm64',
    runner: 'macos-15',
    platform: 'darwin',
    arch: 'arm64',
    nodeArchive: desktopNodeArchiveName({ platform: 'darwin', arch: 'arm64' }),
    electronArchive: desktopElectronArchiveName({ platform: 'darwin', arch: 'arm64' }),
  },
  {
    id: 'macos-x64',
    runner: 'macos-15-intel',
    platform: 'darwin',
    arch: 'x64',
    nodeArchive: desktopNodeArchiveName({ platform: 'darwin', arch: 'x64' }),
    electronArchive: desktopElectronArchiveName({ platform: 'darwin', arch: 'x64' }),
  },
  {
    id: 'windows-x64',
    runner: 'windows-2025',
    platform: 'win32',
    arch: 'x64',
    nodeArchive: desktopNodeArchiveName({ platform: 'win32', arch: 'x64' }),
    electronArchive: desktopElectronArchiveName({ platform: 'win32', arch: 'x64' }),
  },
])

/** Forge output files required before platform signature and lifecycle checks run. */
export interface DesktopReleaseArtifacts {
  /** Target represented by this output tree. */
  readonly target: DesktopReleaseTarget
  /** Packaged application directory (`.app` on macOS). */
  readonly application: string
  /** Forge ZIP maker output. */
  readonly archive: string
  /** macOS DMG maker output. */
  readonly diskImage?: string
  /** Windows Squirrel bootstrap installer. */
  readonly setup?: string
  /** Windows Squirrel full NuGet package. */
  readonly squirrelPackage?: string
  /** Windows Squirrel release index. */
  readonly squirrelReleases?: string
}

/** Important executable and resource paths resolved inside one packaged application. */
export interface DesktopPayloadLayout {
  /** Platform executable started by a user. */
  readonly executable: string
  /** Electron resources directory. */
  readonly resources: string
  /** Assembly directory copied outside ASAR. */
  readonly desktopResources: string
  /** Bundled official Node.js executable. */
  readonly node: string
  /** Pure Node Host sidecar entrypoint. */
  readonly sidecar: string
  /** Process-owning guardian entrypoint. */
  readonly guardian: string
  /** Immutable local renderer entrypoint. */
  readonly shell: string
  /** Project MIT license carried beside the assembled resources. */
  readonly projectLicense: string
  /** Generated disclosure for the complete packaged executable set. */
  readonly thirdPartyNotices: string
  /** Electron MIT license copied from the native distribution. */
  readonly electronLicense: string
  /** Chromium's generated third-party license inventory. */
  readonly chromiumLicenses: string
  /** License for the ripgrep JavaScript wrapper. */
  readonly ripgrepLicense: string
  /** License for the target-specific ripgrep executable package. */
  readonly ripgrepPlatformLicense: string
  /** License for Koffi and its target-specific native module. */
  readonly koffiLicense: string
  /** Signed macOS process-group helper; absent from Windows payloads. */
  readonly processCapsule?: string
}

interface ArtifactInventory {
  readonly applications: string[]
  readonly files: string[]
  readonly windowsPackages: string[]
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`desktop release: ${label} is not a regular file: ${path}`)
  }
}

async function assertNonEmptyRegularFile(path: string, label: string): Promise<void> {
  await assertRegularFile(path, label)
  if ((await stat(path)).size === 0) throw new Error(`desktop release: ${label} is empty: ${path}`)
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`desktop release: ${label} is not a directory: ${path}`)
  }
}

async function inventoryArtifacts(root: string): Promise<ArtifactInventory> {
  const applications: string[] = []
  const files: string[] = []
  const windowsPackages: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile()) {
        files.push(path)
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === 'DeepSeek Harness IDE.app') {
        applications.push(path)
        continue
      }
      if (entry.name === 'DeepSeek Harness IDE-win32-x64') {
        windowsPackages.push(path)
        continue
      }
      await visit(path)
    }
  }
  await visit(root)
  return { applications, files, windowsPackages }
}

function expectOne(paths: readonly string[], label: string): string {
  if (paths.length !== 1) {
    throw new Error(`desktop release: expected one ${label}, found ${String(paths.length)}`)
  }
  return paths[0] as string
}

/**
 * Resolve one target from the closed first-release matrix.
 * @param id - untrusted CLI or workflow target identifier.
 * @returns exact target facts.
 */
export function resolveDesktopReleaseTarget(id: string): DesktopReleaseTarget {
  const target = DESKTOP_RELEASE_TARGETS.find(candidate => candidate.id === id)
  if (target === undefined) throw new Error(`desktop release: unsupported target ${JSON.stringify(id)}`)
  return target
}

/**
 * Find the exact Forge artifact set for one target.
 * @param outRoot - Forge output root.
 * @param target - native target expected in the output tree.
 * @returns canonical artifact paths used by subsequent native checks.
 */
export async function discoverDesktopReleaseArtifacts(
  outRoot: string,
  target: DesktopReleaseTarget,
): Promise<DesktopReleaseArtifacts> {
  const canonicalRoot = await realpath(resolve(outRoot))
  const inventory = await inventoryArtifacts(canonicalRoot)
  const archive = expectOne(inventory.files.filter(path => path.endsWith('.zip')), 'portable ZIP')
  const application = target.platform === 'darwin'
    ? expectOne(inventory.applications, 'packaged macOS application')
    : expectOne(inventory.windowsPackages, 'packaged Windows application directory')
  const selected = target.platform === 'darwin'
    ? {
      target,
      application,
      archive,
      diskImage: expectOne(inventory.files.filter(path => path.endsWith('.dmg')), 'DMG'),
    }
    : {
      target,
      application,
      archive,
      setup: expectOne(inventory.files.filter(path => basename(path) === 'DeepSeekHarnessIDESetup.exe'), 'Squirrel Setup.exe'),
      squirrelPackage: expectOne(inventory.files.filter(path => path.endsWith('-full.nupkg')), 'Squirrel full package'),
      squirrelReleases: expectOne(inventory.files.filter(path => basename(path) === 'RELEASES'), 'Squirrel RELEASES index'),
    }
  for (const [label, path] of Object.entries(selected)) {
    if (typeof path !== 'string' || label === 'target' || label === 'application') continue
    await assertRegularFile(path, label)
    const canonical = await realpath(path)
    if (!isWithin(canonicalRoot, canonical)) {
      throw new Error(`desktop release: ${label} escapes the Forge output root`)
    }
  }
  await assertDirectory(application, 'packaged application')
  return selected
}

/**
 * Resolve and validate the fixed payload locations required by the installed app.
 * @param application - packaged `.app` or Windows application directory.
 * @param target - expected native target.
 * @returns regular executable and resource paths.
 */
export async function resolveDesktopPayloadLayout(
  application: string,
  target: DesktopReleaseTarget,
): Promise<DesktopPayloadLayout> {
  const canonicalApplication = await realpath(resolve(application))
  const resources = target.platform === 'darwin'
    ? join(canonicalApplication, 'Contents', 'Resources')
    : join(canonicalApplication, 'resources')
  const executable = target.platform === 'darwin'
    ? join(canonicalApplication, 'Contents', 'MacOS', 'deepseek-harness-ide')
    : join(canonicalApplication, 'deepseek-harness-ide.exe')
  const desktopResources = join(resources, 'desktop-resources')
  const node = target.platform === 'darwin'
    ? join(desktopResources, 'runtime', 'bin', 'node')
    : join(desktopResources, 'runtime', 'node.exe')
  const ripgrepPlatform = target.platform === 'win32'
    ? 'ripgrep-win32-x64'
    : `ripgrep-darwin-${target.arch}`
  const layout: DesktopPayloadLayout = {
    executable,
    resources,
    desktopResources,
    node,
    sidecar: join(desktopResources, 'host', 'lib', 'sidecar.js'),
    guardian: join(desktopResources, 'host', 'lib', 'guardian.js'),
    shell: join(desktopResources, 'assets', 'shell', 'index.html'),
    projectLicense: join(desktopResources, 'LICENSE'),
    thirdPartyNotices: join(desktopResources, 'THIRD_PARTY_NOTICES.md'),
    electronLicense: join(desktopResources, 'legal', 'electron', 'LICENSE'),
    chromiumLicenses: join(desktopResources, 'legal', 'electron', 'LICENSES.chromium.html'),
    ripgrepLicense: join(desktopResources, 'host', 'node_modules', '@vscode', 'ripgrep', 'LICENSE'),
    ripgrepPlatformLicense: join(
      desktopResources,
      'host',
      'node_modules',
      '@vscode',
      ripgrepPlatform,
      'LICENSE',
    ),
    koffiLicense: join(desktopResources, 'host', 'node_modules', 'koffi', 'LICENSE.txt'),
    ...(target.platform === 'darwin'
      ? { processCapsule: join(desktopResources, 'native', 'dsh-process-capsule') }
      : {}),
  }
  await assertDirectory(resources, 'Electron resources')
  await assertDirectory(desktopResources, 'desktop resources')
  await Promise.all([
    assertRegularFile(executable, 'application executable'),
    assertRegularFile(join(resources, 'app.asar'), 'application ASAR'),
    assertRegularFile(node, 'bundled Node.js'),
    assertRegularFile(join(desktopResources, 'runtime', 'LICENSE'), 'bundled Node.js license'),
    assertRegularFile(layout.sidecar, 'Host sidecar'),
    assertRegularFile(layout.guardian, 'runtime guardian'),
    assertRegularFile(layout.shell, 'renderer shell'),
    assertRegularFile(join(desktopResources, 'host', 'config', 'runtime.json'), 'desktop runtime configuration'),
    assertNonEmptyRegularFile(layout.projectLicense, 'project license'),
    assertNonEmptyRegularFile(layout.thirdPartyNotices, 'third-party notices'),
    assertNonEmptyRegularFile(layout.electronLicense, 'Electron license'),
    assertNonEmptyRegularFile(layout.chromiumLicenses, 'Chromium licenses'),
    assertNonEmptyRegularFile(layout.ripgrepLicense, 'ripgrep wrapper license'),
    assertNonEmptyRegularFile(layout.ripgrepPlatformLicense, 'ripgrep executable license'),
    assertNonEmptyRegularFile(layout.koffiLicense, 'Koffi license'),
    ...(layout.processCapsule === undefined
      ? []
      : [assertRegularFile(layout.processCapsule, 'macOS process capsule')]),
  ])
  if (target.platform === 'win32' && existsSync(join(desktopResources, 'native', 'dsh-process-capsule'))) {
    throw new Error('desktop release: Windows payload contains the macOS process capsule')
  }
  verifyDesktopLegalNotices(await readFile(layout.thirdPartyNotices, 'utf8'))
  return layout
}

/**
 * Reject native provider payloads outside the desktop target matrix while retaining platform-neutral wrappers.
 * @param root - assembled desktop resources root.
 * @returns after the resource tree and Client bundle roster have been checked.
 */
export async function verifyDesktopResourceClosure(root: string): Promise<void> {
  let clientBundles = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`desktop release: signed desktop resources contain a symbolic link: ${path}`)
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node-pty' || entry.name.startsWith('node-addon-landlock-run-linux-')) {
          throw new Error(`desktop release: unsupported native provider is packaged: ${path}`)
        }
        await visit(path)
      } else if (entry.isFile() && entry.name === 'landlock-run') {
        throw new Error(`desktop release: unsupported native provider is packaged: ${path}`)
      } else if (entry.isFile() && entry.name === 'client.js' && path.includes(`${sep}assets${sep}plugins${sep}`)) {
        clientBundles += 1
      }
    }
  }
  await visit(root)
  if (clientBundles === 0) throw new Error('desktop release: packaged resources contain no Client bundle')
}

/**
 * Parse and check the bundled Node.js identity probe.
 * @param text - stdout from the fixed identity expression.
 * @param target - target required by the artifact.
 */
export function verifyBundledNodeIdentity(text: string, target: DesktopReleaseTarget): void {
  let value: unknown
  try {
    value = JSON.parse(text.trim()) as unknown
  } catch {
    throw new Error('desktop release: bundled Node.js identity probe is not JSON')
  }
  if (!Array.isArray(value) || value.length !== 3
    || value[0] !== DESKTOP_NODE_VERSION || value[1] !== target.platform || value[2] !== target.arch) {
    throw new Error(`desktop release: bundled Node.js identity mismatch: ${JSON.stringify(value)}`)
  }
}

function probe(executable: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const stdout: Uint8Array[] = []
    const child = spawn(executable, [
      '-p',
      'JSON.stringify([process.version,process.platform,process.arch])',
    ], { stdio: ['ignore', 'pipe', 'inherit'], shell: false, windowsHide: true })
    child.stdout.on('data', (chunk) => { stdout.push(chunk as Uint8Array) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(`desktop release: bundled Node.js probe ended by ${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`}`))
    })
  })
}

/**
 * Verify files in a packaged application and execute its bundled Node identity probe.
 * @param application - packaged `.app` or Windows application directory.
 * @param target - native target required by the payload.
 * @returns resolved payload paths for native signature and lifecycle checks.
 */
export async function verifyDesktopReleasePayload(
  application: string,
  target: DesktopReleaseTarget,
): Promise<DesktopPayloadLayout> {
  const layout = await resolveDesktopPayloadLayout(application, target)
  if (layout.processCapsule !== undefined) {
    try {
      await access(layout.processCapsule, fsConstants.X_OK)
    } catch (cause) {
      throw new Error('desktop release: macOS process capsule is not executable', { cause })
    }
  }
  await verifyDesktopResourceClosure(layout.desktopResources)
  verifyBundledNodeIdentity(await probe(layout.node), target)
  return layout
}

/**
 * Validate that the Squirrel index pins the exact full package bytes.
 * @param releases - Squirrel `RELEASES` text.
 * @param packageName - full NuGet package basename.
 * @param packageBytes - package bytes written by the maker.
 */
export function verifySquirrelReleaseIndex(
  releases: string,
  packageName: string,
  packageBytes: Uint8Array,
): void {
  const rows = releases.split(/\r?\n/u).flatMap((line) => {
    const match = /^([0-9a-fA-F]{40})\s+([^\s]+)\s+(\d+)$/u.exec(line.trim())
    return match === null ? [] : [{ digest: match[1] as string, name: match[2] as string, size: match[3] as string }]
  }).filter(row => row.name === packageName)
  if (rows.length !== 1) {
    throw new Error(`desktop release: Squirrel RELEASES must contain ${packageName} exactly once`)
  }
  const row = rows[0] as { digest: string; name: string; size: string }
  const digest = createHash('sha1').update(packageBytes).digest('hex')
  if (row.digest.toLowerCase() !== digest || Number(row.size) !== packageBytes.byteLength) {
    throw new Error(`desktop release: Squirrel RELEASES does not match ${packageName}`)
  }
}

/**
 * Verify the Squirrel full-package row from disk.
 * @param artifacts - discovered Windows artifact set.
 */
export async function verifySquirrelArtifacts(artifacts: DesktopReleaseArtifacts): Promise<void> {
  if (artifacts.target.platform !== 'win32' || artifacts.squirrelPackage === undefined
    || artifacts.squirrelReleases === undefined) {
    throw new Error('desktop release: Squirrel verification requires Windows artifacts')
  }
  verifySquirrelReleaseIndex(
    await readFile(artifacts.squirrelReleases, 'utf8'),
    basename(artifacts.squirrelPackage),
    await readFile(artifacts.squirrelPackage),
  )
  if ((await stat(artifacts.squirrelPackage)).size === 0) {
    throw new Error('desktop release: Squirrel full package is empty')
  }
}
