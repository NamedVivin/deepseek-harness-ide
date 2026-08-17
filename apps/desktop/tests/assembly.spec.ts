import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ELECTRON_VERSION,
  DESKTOP_NODE_VERSION,
  assembleElectronLegalNotices,
  clientResourceSegment,
  desktopDeployArguments,
  desktopElectronArchiveName,
  desktopNodeArchiveName,
  parseElectronArchiveDigest,
  parseNodeArchiveDigest,
  probeDesktopHostClosure,
  pruneDesktopHostPlatformPayloads,
  resolveDesktopAssemblyTarget,
  verifyDesktopLegalNotices,
} from '../src/assembly.ts'

const ELECTRON_LEGAL_ZIP = Buffer.from(
  'UEsDBAoAAAAAACqZDl0cWKQuGQAAABkAAAAHABwATElDRU5TRVVUCQADYPd+amD3fmp1eAsAAQT1AQAABAAAAABFbGVjdHJvbiBmaXh0dXJlIGxpY2Vuc2UKUEsDBBQAAAAIACqZDl3iOmwFJgAAACcAAAAWABwATElDRU5TRVMuY2hyb21pdW0uaHRtbFVUCQADYPd+amD3fmp1eAsAAQT1AQAABAAAAACzySjJzbFzzijKz80szVVIy6woKS1KVcjJTE7NK04tttEHy3MBAFBLAQIeAwoAAAAAACqZDl0cWKQuGQAAABkAAAAHABgAAAAAAAEAAACkgQAAAABMSUNFTlNFVVQFAANg935qdXgLAAEE9QEAAAQAAAAAUEsBAh4DFAAAAAgAKpkOXeI6bAUmAAAAJwAAABYAGAAAAAAAAQAAAKSBWgAAAExJQ0VOU0VTLmNocm9taXVtLmh0bWxVVAUAA2D3fmp1eAsAAQT1AQAABAAAAABQSwUGAAAAAAIAAgCpAAAA0AAAAAAA',
  'base64',
)

describe('desktop resource assembly', () => {
  it('selects exact native Node release archives', () => {
    expect(desktopNodeArchiveName({ platform: 'darwin', arch: 'arm64' }))
      .toBe(`node-${DESKTOP_NODE_VERSION}-darwin-arm64.tar.gz`)
    expect(desktopNodeArchiveName({ platform: 'darwin', arch: 'x64' }))
      .toBe(`node-${DESKTOP_NODE_VERSION}-darwin-x64.tar.gz`)
    expect(desktopNodeArchiveName({ platform: 'win32', arch: 'x64' }))
      .toBe(`node-${DESKTOP_NODE_VERSION}-win-x64.zip`)
  })

  it('selects exact native Electron release archives', () => {
    expect(desktopElectronArchiveName({ platform: 'darwin', arch: 'arm64' }))
      .toBe(`electron-v${DESKTOP_ELECTRON_VERSION}-darwin-arm64.zip`)
    expect(desktopElectronArchiveName({ platform: 'darwin', arch: 'x64' }))
      .toBe(`electron-v${DESKTOP_ELECTRON_VERSION}-darwin-x64.zip`)
    expect(desktopElectronArchiveName({ platform: 'win32', arch: 'x64' }))
      .toBe(`electron-v${DESKTOP_ELECTRON_VERSION}-win32-x64.zip`)
  })

  it('requires one exact digest row', () => {
    const digest = 'a'.repeat(64)
    expect(parseNodeArchiveDigest(`${digest}  node.tar.gz\n`, 'node.tar.gz')).toBe(digest)
    expect(() => parseNodeArchiveDigest('', 'node.tar.gz')).toThrow('exactly once')
    expect(() => parseNodeArchiveDigest(
      `${digest}  node.tar.gz\n${digest}  node.tar.gz\n`,
      'node.tar.gz',
    )).toThrow('exactly once')
  })

  it('parses one exact Electron digest row with either checksum marker', () => {
    const digest = 'b'.repeat(64)
    expect(parseElectronArchiveDigest(`${digest} *electron.zip\n`, 'electron.zip')).toBe(digest)
    expect(parseElectronArchiveDigest(`${digest}  electron.zip\n`, 'electron.zip')).toBe(digest)
    expect(() => parseElectronArchiveDigest('', 'electron.zip')).toThrow('exactly once')
    expect(() => parseElectronArchiveDigest(
      `${digest} *electron.zip\n${digest}  electron.zip\n`,
      'electron.zip',
    )).toThrow('exactly once')
  })

  it('extracts required legal files from the digest-verified Electron archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-electron-legal-'))
    const target = { platform: 'darwin', arch: 'arm64' } as const
    const archiveName = desktopElectronArchiveName(target)
    const archive = join(root, archiveName)
    const shasums = join(root, 'SHASUMS256.txt')
    const destination = join(root, 'legal')
    const digest = createHash('sha256').update(ELECTRON_LEGAL_ZIP).digest('hex')
    try {
      await Promise.all([
        writeFile(archive, ELECTRON_LEGAL_ZIP),
        writeFile(shasums, `${digest} *${archiveName}\n`),
        mkdir(destination),
      ])
      await assembleElectronLegalNotices({ archive, shasums }, target, destination)
      await expect(readFile(join(destination, 'LICENSE'), 'utf8'))
        .resolves.toBe('Electron fixture license\n')
      await expect(readFile(join(destination, 'LICENSES.chromium.html'), 'utf8'))
        .resolves.toBe('<html>Chromium fixture licenses</html>\n')

      await expect(assembleElectronLegalNotices({
        archive,
        shasums: await writeBadElectronDigest(root, archiveName),
      }, target, destination)).rejects.toThrow('archive digest mismatch')
      await expect(assembleElectronLegalNotices({
        archive: join(root, 'electron.zip'),
        shasums,
      }, target, destination)).rejects.toThrow(`must be named ${archiveName}`)
      await expect(assembleElectronLegalNotices({ archive, shasums }, target, 'relative/legal'))
        .rejects.toThrow('destination must be absolute')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('admits only first-party Client ids into safe resource segments', () => {
    const encoded = clientResourceSegment('@deepseek-ai/dsh-client-ui-ide')
    expect(encoded).not.toMatch(/[\\/]/u)
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe('@deepseek-ai/dsh-client-ui-ide')
    expect(() => clientResourceSegment('@example/plugin')).toThrow('third-party')
  })

  it('rejects unsupported release targets', () => {
    expect(resolveDesktopAssemblyTarget('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(resolveDesktopAssemblyTarget('win32', 'x64')).toEqual({ platform: 'win32', arch: 'x64' })
    expect(() => resolveDesktopAssemblyTarget('win32', 'arm64')).toThrow('unsupported target')
    expect(() => resolveDesktopAssemblyTarget('linux', 'x64')).toThrow('unsupported target')
  })

  it('requires notices for every packaged executable payload', () => {
    const complete = [
      '## Packaged desktop executable payloads',
      `Electron ${DESKTOP_ELECTRON_VERSION}`,
      DESKTOP_NODE_VERSION,
      '`LICENSES.chromium.html`',
      '`@vscode/ripgrep`',
      '`koffi`',
      '`dsh-process-capsule`',
    ].join('\n')
    expect(() => { verifyDesktopLegalNotices(complete) }).not.toThrow()
    expect(() => { verifyDesktopLegalNotices(complete.replace('`koffi`', '')) })
      .toThrow('THIRD_PARTY_NOTICES.md is missing `koffi`')
  })

  it('uses modern deploy without legacy resolution or lockfile drift', () => {
    const destination = resolve('desktop-stage', 'host')
    const args = desktopDeployArguments(destination)
    expect(args).toContain('--config.inject-workspace-packages=true')
    expect(args).toContain('--config.frozen-lockfile=true')
    expect(args).not.toContain('--legacy')
    expect(args.at(-1)).toBe(destination)
    expect(() => desktopDeployArguments('relative/host')).toThrow('must be absolute')
  })

  it('boots and quiesces a deployed Host with isolated probe state', async () => {
    const root = await writeHostProbeFixture([
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "fs.writeFileSync(path.join(process.cwd(), 'probe-environment.json'), JSON.stringify({ home: process.env.DSH_HOME, telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED, telemetryMode: process.env.DSH_TELEMETRY_MODE }))",
      "process.send({ version: 1, type: 'desktop-runtime-ready', graph: { rev: 'fixture', entries: [] } })",
      "process.on('message', (frame) => {",
      "  if (frame?.type !== 'desktop-runtime-dispose') return",
      "  process.send({ version: 1, type: 'desktop-runtime-disposed' }, (error) => {",
      '    if (error) process.exit(8)',
      '    process.disconnect()',
      '  })',
      '})',
      '',
    ].join('\n'))
    try {
      await probeDesktopHostClosure(process.execPath, root)
      const observed = JSON.parse(
        await readFile(join(root, 'probe-environment.json'), 'utf8'),
      ) as { home: string; telemetryDisabled: string; telemetryMode: string }
      expect(observed.telemetryDisabled).toBe('1')
      expect(observed.telemetryMode).toBe('DISABLED')
      expect(observed.home).toContain('dsh-desktop-host-probe-')
      await expect(access(observed.home)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps sidecar stderr when the deployed Host reports a startup failure', async () => {
    const root = await writeHostProbeFixture([
      "process.stderr.write('fixture loader row: missing service definition\\n')",
      "process.send({ version: 1, type: 'desktop-runtime-failed', message: 'loader entries failed to apply' }, () => {",
      '  process.disconnect()',
      '  process.exitCode = 1',
      '})',
      '',
    ].join('\n'))
    try {
      const failure = await probeFailureOf(root)
      expect(failure.message).toContain('loader entries failed to apply')
      expect(failure.message).toContain('fixture loader row: missing service definition')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a malformed ready frame instead of accepting an unvalidated graph', async () => {
    const root = await writeHostProbeFixture([
      "process.stderr.write('fixture malformed graph\\n')",
      "process.send({ version: 1, type: 'desktop-runtime-ready', graph: {} })",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
    try {
      const failure = await probeFailureOf(root)
      expect(failure.message).toContain('sent an invalid lifecycle frame')
      expect(failure.message).toContain('fixture malformed graph')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('force-joins a Host that misses the signed startup or graceful deadline', async () => {
    const startupRoot = await writeHostProbeFixture([
      "process.stderr.write('fixture startup remained pending\\n')",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
    const shutdownRoot = await writeHostProbeFixture([
      "process.send({ version: 1, type: 'desktop-runtime-ready', graph: { rev: 'fixture', entries: [] } })",
      "process.on('message', () => { process.stderr.write('fixture disposal remained pending\\n') })",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
    try {
      const startupFailure = await probeFailureOf(startupRoot)
      expect(startupFailure.message).toContain('startup timed out after 100 ms')
      expect(startupFailure.message).toContain('fixture startup remained pending')

      const shutdownFailure = await probeFailureOf(shutdownRoot)
      expect(shutdownFailure.message).toContain('graceful shutdown timed out after 100 ms')
      expect(shutdownFailure.message).toContain('fixture disposal remained pending')
    } finally {
      await Promise.all([
        rm(startupRoot, { recursive: true, force: true }),
        rm(shutdownRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('rejects a disposed Host whose process exit is not clean', async () => {
    const root = await writeHostProbeFixture([
      "process.send({ version: 1, type: 'desktop-runtime-ready', graph: { rev: 'fixture', entries: [] } })",
      "process.on('message', () => {",
      "  process.stderr.write('fixture exited two\\n')",
      "  process.send({ version: 1, type: 'desktop-runtime-disposed' }, () => {",
      '    process.disconnect()',
      '    process.exitCode = 2',
      '  })',
      '})',
      '',
    ].join('\n'))
    try {
      const failure = await probeFailureOf(root)
      expect(failure.message).toContain('exited uncleanly (exit code 2)')
      expect(failure.message).toContain('fixture exited two')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes Linux launcher payloads while retaining the platform-neutral wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-host-'))
    const scope = join(root, 'node_modules', '@deepseek-ai')
    const wrapper = join(scope, 'node-addon-landlock-run')
    const arm64 = join(scope, 'node-addon-landlock-run-linux-arm64')
    const x64 = join(scope, 'node-addon-landlock-run-linux-x64')
    try {
      await Promise.all([wrapper, arm64, x64].map(async (directory) => {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'package.json'), '{}\n')
      }))
      await pruneDesktopHostPlatformPayloads(root)
      await expect(access(join(wrapper, 'package.json'))).resolves.toBeUndefined()
      await expect(access(join(arm64, 'package.json'))).rejects.toThrow()
      await expect(access(join(x64, 'package.json'))).rejects.toThrow()
      await expect(pruneDesktopHostPlatformPayloads('relative/host')).rejects.toThrow('must be absolute')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeBadElectronDigest(root: string, archiveName: string): Promise<string> {
  const path = join(root, 'BAD-SHASUMS256.txt')
  await writeFile(path, `${'0'.repeat(64)} *${archiveName}\n`)
  return path
}

const PROBE_RUNTIME_CONFIG = {
  version: 1,
  startupTimeoutMs: 100,
  gracefulShutdownMs: 100,
  forceShutdownMs: 300,
  squirrelTimeoutMs: 100,
  nativeProcessPollMs: 100,
  mirrorTimeoutMs: 100,
  maxDesktopBodyBytes: 4096,
  maxDesktopChunkBytes: 1024,
  maxDesktopInflightBytes: 2048,
} as const

async function writeHostProbeFixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-host-fixture-'))
  await Promise.all([
    mkdir(join(root, 'lib'), { recursive: true }),
    mkdir(join(root, 'config'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'lib', 'sidecar.js'), source),
    writeFile(join(root, 'config', 'runtime.json'), `${JSON.stringify(PROBE_RUNTIME_CONFIG)}\n`),
  ])
  return root
}

async function probeFailureOf(root: string): Promise<Error> {
  try {
    await probeDesktopHostClosure(process.execPath, root)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('fixture Host closure probe unexpectedly succeeded')
}
