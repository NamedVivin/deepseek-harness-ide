import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_ELECTRON_VERSION,
  DESKTOP_NODE_VERSION,
} from '../src/assembly.ts'
import {
  DESKTOP_RELEASE_TARGETS,
  discoverDesktopReleaseArtifacts,
  resolveDesktopPayloadLayout,
  resolveDesktopReleaseTarget,
  verifyBundledNodeIdentity,
  verifyDesktopResourceClosure,
  verifySquirrelReleaseIndex,
} from '../src/release-artifacts.ts'

const temporaryRoots: string[] = []

const legalNotice = [
  '## Packaged desktop executable payloads',
  `Electron ${DESKTOP_ELECTRON_VERSION}`,
  DESKTOP_NODE_VERSION,
  '`LICENSES.chromium.html`',
  '`@vscode/ripgrep`',
  '`koffi`',
  '`dsh-process-capsule`',
].join('\n')

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-release-'))
  const canonical = await realpath(root)
  temporaryRoots.push(canonical)
  return canonical
}

async function file(path: string, bytes = 'payload'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function macApplication(root: string): Promise<string> {
  const application = join(root, 'DeepSeek Harness IDE-darwin-arm64', 'DeepSeek Harness IDE.app')
  const resources = join(application, 'Contents', 'Resources')
  await Promise.all([
    file(join(application, 'Contents', 'MacOS', 'deepseek-harness-ide')),
    file(join(resources, 'app.asar')),
    file(join(resources, 'desktop-resources', 'runtime', 'bin', 'node')),
    file(join(resources, 'desktop-resources', 'runtime', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'host', 'lib', 'sidecar.js')),
    file(join(resources, 'desktop-resources', 'host', 'lib', 'guardian.js')),
    file(join(resources, 'desktop-resources', 'host', 'config', 'runtime.json')),
    file(join(resources, 'desktop-resources', 'assets', 'shell', 'index.html')),
    file(join(resources, 'desktop-resources', 'native', 'dsh-process-capsule')),
    file(join(resources, 'desktop-resources', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'THIRD_PARTY_NOTICES.md'), legalNotice),
    file(join(resources, 'desktop-resources', 'legal', 'electron', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'legal', 'electron', 'LICENSES.chromium.html')),
    file(join(resources, 'desktop-resources', 'host', 'node_modules', '@vscode', 'ripgrep', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'host', 'node_modules', '@vscode', 'ripgrep-darwin-arm64', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'host', 'node_modules', 'koffi', 'LICENSE.txt')),
  ])
  return application
}

async function windowsApplication(root: string): Promise<string> {
  const application = join(root, 'DeepSeek Harness IDE-win32-x64')
  const resources = join(application, 'resources')
  await Promise.all([
    file(join(application, 'deepseek-harness-ide.exe')),
    file(join(resources, 'app.asar')),
    file(join(resources, 'desktop-resources', 'runtime', 'node.exe')),
    file(join(resources, 'desktop-resources', 'runtime', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'host', 'lib', 'sidecar.js')),
    file(join(resources, 'desktop-resources', 'host', 'lib', 'guardian.js')),
    file(join(resources, 'desktop-resources', 'host', 'config', 'runtime.json')),
    file(join(resources, 'desktop-resources', 'assets', 'shell', 'index.html')),
    file(join(resources, 'desktop-resources', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'THIRD_PARTY_NOTICES.md'), legalNotice),
    file(join(resources, 'desktop-resources', 'legal', 'electron', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'legal', 'electron', 'LICENSES.chromium.html')),
    file(join(resources, 'desktop-resources', 'host', 'node_modules', '@vscode', 'ripgrep', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'host', 'node_modules', '@vscode', 'ripgrep-win32-x64', 'LICENSE')),
    file(join(resources, 'desktop-resources', 'host', 'node_modules', 'koffi', 'LICENSE.txt')),
  ])
  return application
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop release targets', () => {
  it('pins the three native runners and official runtime archives', () => {
    expect(DESKTOP_RELEASE_TARGETS).toEqual([
      expect.objectContaining({
        id: 'macos-arm64',
        runner: 'macos-15',
        nodeArchive: 'node-v24.16.0-darwin-arm64.tar.gz',
        electronArchive: 'electron-v43.2.0-darwin-arm64.zip',
      }),
      expect.objectContaining({
        id: 'macos-x64',
        runner: 'macos-15-intel',
        nodeArchive: 'node-v24.16.0-darwin-x64.tar.gz',
        electronArchive: 'electron-v43.2.0-darwin-x64.zip',
      }),
      expect.objectContaining({
        id: 'windows-x64',
        runner: 'windows-2025',
        nodeArchive: 'node-v24.16.0-win-x64.zip',
        electronArchive: 'electron-v43.2.0-win32-x64.zip',
      }),
    ])
    expect(() => resolveDesktopReleaseTarget('windows-arm64')).toThrow('unsupported target')
  })

  it('requires the exact bundled Node version, platform, and architecture', () => {
    const target = resolveDesktopReleaseTarget('macos-arm64')
    expect(() => { verifyBundledNodeIdentity('["v24.16.0","darwin","arm64"]\n', target) }).not.toThrow()
    expect(() => { verifyBundledNodeIdentity('["v24.16.1","darwin","arm64"]', target) }).toThrow('identity mismatch')
    expect(() => { verifyBundledNodeIdentity('not-json', target) }).toThrow('not JSON')
  })

  it('keeps the native workflow aligned and leaves public publication unwired', async () => {
    const workflow = await readFile('.github/workflows/desktop-artifacts.yml', 'utf8')
    const packageManifest = await readFile('apps/desktop/package.json', 'utf8')
    const guardianManifest = await readFile('packages/subprocess/subprocess-guardian/package.json', 'utf8')
    const assemblyEntrypoint = await readFile('apps/desktop/scripts/assemble.ts', 'utf8')
    const forgeConfig = await readFile('apps/desktop/forge.config.ts', 'utf8')
    const forgeEntrypoint = await readFile('apps/desktop/scripts/forge.ts', 'utf8')
    const workspaceManifest = await readFile('pnpm-workspace.yaml', 'utf8')
    const lockfile = await readFile('pnpm-lock.yaml', 'utf8')
    const windowsSmoke = await readFile('apps/desktop/scripts/smoke-windows-lifecycle.ps1', 'utf8')
    for (const target of DESKTOP_RELEASE_TARGETS) {
      expect(workflow).toContain(`target: ${target.id}`)
      expect(workflow).toContain(`runner: ${target.runner}`)
      expect(workflow).toContain(`node_archive: ${target.nodeArchive}`)
      expect(workflow).toContain(`electron_archive: ${target.electronArchive}`)
    }
    expect(workflow.match(/^\s+- target:/gmu)).toHaveLength(3)
    expect(workflow).toContain('DSH_DESKTOP_ELECTRON_ZIP_DIR=')
    expect(workflow).toContain('DSH_DESKTOP_ELECTRON_SHASUMS=')
    expect(workflow.match(/electron-SHASUMS256\.txt/gmu)).toHaveLength(2)
    expect(workflow).toMatch(/Electron archive digest mismatch/gmu)
    expect(packageManifest).toContain('"@electron-forge/core": "7.11.2"')
    expect(packageManifest).toContain('"@electron-internal/extract-zip": "1.0.5"')
    expect(guardianManifest).toContain('"lib/channel-*.js"')
    expect(assemblyEntrypoint).toContain("requiredEnvironment('DSH_DESKTOP_ELECTRON_ZIP_DIR')")
    expect(assemblyEntrypoint).toContain("requiredEnvironment('DSH_DESKTOP_ELECTRON_SHASUMS')")
    expect(packageManifest).not.toContain('"@electron-forge/cli"')
    expect(workspaceManifest).toContain(
      "'@electron/packager@18.4.4>extract-zip': 'npm:@electron-internal/extract-zip@1.0.5'",
    )
    expect(lockfile).toContain(
      "'@electron/packager@18.4.4>extract-zip': npm:@electron-internal/extract-zip@1.0.5",
    )
    expect(lockfile).toContain("extract-zip: '@electron-internal/extract-zip@1.0.5'")
    expect(forgeEntrypoint).toContain("import { api } from '@electron-forge/core'")
    expect(forgeEntrypoint).toContain('await api.package(')
    expect(forgeEntrypoint).toContain('await api.make(')
    expect(forgeEntrypoint).toContain('await api.start(')
    expect(forgeConfig).toContain("requiredEnvironment('DSH_DESKTOP_ELECTRON_ZIP_DIR')")
    expect(forgeConfig).toContain('electronZipDir,')
    expect(workflow).toContain('windows_baseline_run_id')
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toMatch(/electron-forge publish|gh release create|actions\/create-release|softprops\/action-gh-release/u)
    expect(windowsSmoke).toContain('$Process.WaitForExit(120000)')
    expect(windowsSmoke).not.toMatch(/Start-Process[^\r\n]+-Wait/u)
  })
})

describe('Forge artifact discovery', () => {
  it('finds one macOS application, DMG, and portable ZIP', async () => {
    const root = await temporaryRoot()
    const application = await macApplication(root)
    await Promise.all([
      file(join(root, 'make', 'DeepSeek-Harness-IDE.dmg')),
      file(join(root, 'make', 'zip', 'DeepSeek Harness IDE-darwin-arm64.zip')),
    ])
    await expect(discoverDesktopReleaseArtifacts(root, resolveDesktopReleaseTarget('macos-arm64')))
      .resolves.toEqual(expect.objectContaining({
        application,
        diskImage: join(root, 'make', 'DeepSeek-Harness-IDE.dmg'),
        archive: join(root, 'make', 'zip', 'DeepSeek Harness IDE-darwin-arm64.zip'),
      }))
  })

  it('rejects ambiguous maker output', async () => {
    const root = await temporaryRoot()
    await macApplication(root)
    await Promise.all([
      file(join(root, 'make', 'DeepSeek-Harness-IDE.dmg')),
      file(join(root, 'make', 'first.zip')),
      file(join(root, 'make', 'second.zip')),
    ])
    await expect(discoverDesktopReleaseArtifacts(root, resolveDesktopReleaseTarget('macos-arm64')))
      .rejects.toThrow('expected one portable ZIP, found 2')
  })

  it('finds the complete Windows Squirrel set', async () => {
    const root = await temporaryRoot()
    const application = join(root, 'DeepSeek Harness IDE-win32-x64')
    await mkdir(application, { recursive: true })
    const squirrelPackage = join(root, 'make', 'deepseek_harness_ide-0.1.0-full.nupkg')
    await Promise.all([
      file(join(root, 'make', 'DeepSeekHarnessIDESetup.exe')),
      file(squirrelPackage),
      file(join(root, 'make', 'RELEASES')),
      file(join(root, 'make', 'zip', 'DeepSeek Harness IDE-win32-x64.zip')),
    ])
    await expect(discoverDesktopReleaseArtifacts(root, resolveDesktopReleaseTarget('windows-x64')))
      .resolves.toEqual(expect.objectContaining({ application, squirrelPackage }))
  })
})

describe('packaged payload verification', () => {
  it('admits the Landlock JavaScript wrapper but rejects Linux launcher payloads', async () => {
    const root = await temporaryRoot()
    await Promise.all([
      file(join(root, 'assets', 'plugins', 'client', 'client.js')),
      file(join(root, 'host', 'node_modules', '@deepseek-ai', 'node-addon-landlock-run', 'package.json')),
    ])
    await expect(verifyDesktopResourceClosure(root)).resolves.toBeUndefined()
    await file(join(
      root,
      'host',
      'node_modules',
      '@deepseek-ai',
      'node-addon-landlock-run-linux-arm64',
      'package.json',
    ))
    await expect(verifyDesktopResourceClosure(root)).rejects.toThrow('unsupported native provider')
  })

  it('rejects an unpackaged Landlock executable independently of its parent directory', async () => {
    const root = await temporaryRoot()
    await Promise.all([
      file(join(root, 'assets', 'plugins', 'client', 'client.js')),
      file(join(root, 'host', 'bin', 'landlock-run')),
    ])
    await expect(verifyDesktopResourceClosure(root)).rejects.toThrow('unsupported native provider')
  })

  it('resolves the fixed macOS resource topology', async () => {
    const root = await temporaryRoot()
    const application = await macApplication(root)
    const layout = await resolveDesktopPayloadLayout(application, resolveDesktopReleaseTarget('macos-arm64'))
    expect(layout.node).toBe(join(application, 'Contents', 'Resources', 'desktop-resources', 'runtime', 'bin', 'node'))
    expect(layout.guardian).toBe(join(application, 'Contents', 'Resources', 'desktop-resources', 'host', 'lib', 'guardian.js'))
    expect(layout.processCapsule).toBe(join(application, 'Contents', 'Resources', 'desktop-resources', 'native', 'dsh-process-capsule'))
    expect(layout.chromiumLicenses).toBe(join(
      application,
      'Contents',
      'Resources',
      'desktop-resources',
      'legal',
      'electron',
      'LICENSES.chromium.html',
    ))
  })

  it('rejects a link-shaped required payload', async () => {
    const root = await temporaryRoot()
    const application = await macApplication(root)
    const guardian = join(application, 'Contents', 'Resources', 'desktop-resources', 'host', 'lib', 'guardian.js')
    await rm(guardian)
    await symlink('sidecar.js', guardian)
    await expect(resolveDesktopPayloadLayout(application, resolveDesktopReleaseTarget('macos-arm64')))
      .rejects.toThrow('runtime guardian is not a regular file')
  })

  it('rejects the macOS process capsule in a Windows payload', async () => {
    const root = await temporaryRoot()
    const application = await windowsApplication(root)
    await file(join(application, 'resources', 'desktop-resources', 'native', 'dsh-process-capsule'))
    await expect(resolveDesktopPayloadLayout(application, resolveDesktopReleaseTarget('windows-x64')))
      .rejects.toThrow('Windows payload contains the macOS process capsule')
  })

  it('rejects a stale executable-payload notice', async () => {
    const root = await temporaryRoot()
    const application = await windowsApplication(root)
    await file(
      join(application, 'resources', 'desktop-resources', 'THIRD_PARTY_NOTICES.md'),
      legalNotice.replace('`koffi`', ''),
    )
    await expect(resolveDesktopPayloadLayout(application, resolveDesktopReleaseTarget('windows-x64')))
      .rejects.toThrow('THIRD_PARTY_NOTICES.md is missing `koffi`')
  })
})

describe('Squirrel release index', () => {
  it('pins the exact full package digest and size', () => {
    const bytes = Buffer.from('full package')
    const name = 'deepseek_harness_ide-0.1.0-full.nupkg'
    const digest = createHash('sha1').update(bytes).digest('hex')
    expect(() => { verifySquirrelReleaseIndex(`${digest} ${name} ${String(bytes.byteLength)}\n`, name, bytes) }).not.toThrow()
    expect(() => { verifySquirrelReleaseIndex(`${'0'.repeat(40)} ${name} ${String(bytes.byteLength)}\n`, name, bytes) })
      .toThrow(`does not match ${basename(name)}`)
  })
})
