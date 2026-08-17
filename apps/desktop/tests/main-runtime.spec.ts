import { describe, expect, it } from 'vitest'
import {
  DESKTOP_MAIN_LIVENESS_FD,
  desktopGuardianArguments,
  desktopGuardianStdio,
  isDesktopConnectionOutboundMessage,
  resolveDesktopRuntimePaths,
  scrubDesktopRuntimeEnvironment,
} from '../src/main-runtime.ts'

describe('Electron main runtime inputs', () => {
  it('keeps signed ASAR inputs separate from external executable resources', () => {
    expect(resolveDesktopRuntimePaths({
      appPath: '/Applications/DeepSeek.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/DeepSeek.app/Contents/Resources',
      packaged: true,
      platform: 'darwin',
    })).toEqual({
      runtimeConfig: '/Applications/DeepSeek.app/Contents/Resources/app.asar/config/runtime.json',
      resourceManifest: '/Applications/DeepSeek.app/Contents/Resources/app.asar/generated/desktop-resource-manifest.json',
      preload: '/Applications/DeepSeek.app/Contents/Resources/app.asar/lib/preload.cjs',
      assets: '/Applications/DeepSeek.app/Contents/Resources/desktop-resources/assets',
      host: '/Applications/DeepSeek.app/Contents/Resources/desktop-resources/host',
      guardian: '/Applications/DeepSeek.app/Contents/Resources/desktop-resources/host/lib/guardian.js',
      sidecar: '/Applications/DeepSeek.app/Contents/Resources/desktop-resources/host/lib/sidecar.js',
      processCapsule: '/Applications/DeepSeek.app/Contents/Resources/desktop-resources/native/dsh-process-capsule',
      node: '/Applications/DeepSeek.app/Contents/Resources/desktop-resources/runtime/bin/node',
    })
    expect(resolveDesktopRuntimePaths({
      appPath: 'C:\\Program Files\\DeepSeek\\resources\\app.asar',
      resourcesPath: 'C:\\Program Files\\DeepSeek\\resources',
      packaged: true,
      platform: 'win32',
    }).node).toContain('runtime/node.exe')
  })

  it('passes only the platform-owned native inputs to the guardian', () => {
    const paths = resolveDesktopRuntimePaths({
      appPath: '/Applications/DeepSeek.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/DeepSeek.app/Contents/Resources',
      packaged: true,
      platform: 'darwin',
    })
    const config = {
      version: 1 as const,
      startupTimeoutMs: 30_000,
      gracefulShutdownMs: 10_000,
      forceShutdownMs: 5_000,
      squirrelTimeoutMs: 30_000,
      nativeProcessPollMs: 100,
      mirrorTimeoutMs: 5_000,
      maxDesktopBodyBytes: 160 * 1024 * 1024,
      maxDesktopChunkBytes: 1024 * 1024,
      maxDesktopInflightBytes: 16 * 1024 * 1024,
    }
    const darwin = desktopGuardianArguments(paths, config, 'darwin')
    expect(darwin).toContain(`--main-liveness-fd=${String(DESKTOP_MAIN_LIVENESS_FD)}`)
    expect(darwin).toContain(`--capsule-helper=${paths.processCapsule}`)
    expect(darwin).toContain(`--sidecar-entry=${paths.sidecar}`)
    expect(desktopGuardianArguments(paths, config, 'win32'))
      .not.toContain(`--capsule-helper=${paths.processCapsule}`)
    expect(() => desktopGuardianArguments(paths, config, 'linux'))
      .toThrow('unsupported guardian platform linux')
    expect(desktopGuardianStdio('darwin')).toEqual(['ignore', 'pipe', 'pipe', 'ipc', 'pipe'])
    expect(desktopGuardianStdio('win32')).toEqual(['ignore', 'pipe', 'pipe', 'ipc'])
    expect(() => desktopGuardianStdio('linux')).toThrow('unsupported guardian platform linux')
  })

  it('removes Electron and Node injection without dropping Host credentials', () => {
    expect(scrubDesktopRuntimeEnvironment({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'secret',
      DSH_HOME: '/private/home',
      NODE_OPTIONS: '--inspect',
      ELECTRON_RUN_AS_NODE: '1',
      npm_config_user_agent: 'pnpm',
      UNSET: undefined,
    })).toEqual({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'secret',
      DSH_HOME: '/private/home',
    })
  })

  it('routes only Connection frames to the Connection parser', () => {
    expect(isDesktopConnectionOutboundMessage({ version: 1, type: 'renderer-result' })).toBe(true)
    expect(isDesktopConnectionOutboundMessage({ version: 1, type: 'body-chunk' })).toBe(true)
    expect(isDesktopConnectionOutboundMessage({ version: 1, type: 'desktop-runtime-ready' })).toBe(false)
    expect(isDesktopConnectionOutboundMessage({ namespace: 'dsh.guardian', type: 'call' })).toBe(false)
    expect(isDesktopConnectionOutboundMessage(null)).toBe(false)
  })
})
