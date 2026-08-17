/** Native-only Electron Forge packaging for the installable desktop IDE. */

import { resolve } from 'node:path'
import { MakerDMG } from '@electron-forge/maker-dmg'
import { MakerSquirrel } from '@electron-forge/maker-squirrel'
import { MakerZIP } from '@electron-forge/maker-zip'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { FuseVersion, FuseV1Options } from '@electron/fuses'

const appRoot = import.meta.dirname
const entitlementPath = resolve(appRoot, 'entitlements.mac.plist')
const iconBase = resolve(appRoot, 'generated', 'app')

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`desktop Forge: ${name} must identify the verified Electron ZIP directory`)
  }
  return value
}

function completeEnvironment(
  names: readonly string[],
  label: string,
): Record<string, string> | undefined {
  const values = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const present = names.filter(name => values[name] !== undefined && values[name] !== '')
  if (present.length === 0) return undefined
  if (present.length !== names.length) {
    throw new Error(`desktop Forge: ${label} requires ${names.join(', ')}`)
  }
  return Object.fromEntries(names.map(name => [name, values[name] as string]))
}

const notarization = completeEnvironment([
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
] as const, 'macOS notarization')
const windowsSigning = completeEnvironment([
  'WINDOWS_CERTIFICATE_FILE',
  'WINDOWS_CERTIFICATE_PASSWORD',
] as const, 'Windows signing')
const windowsTimestampServer = process.env.WINDOWS_TIMESTAMP_SERVER ?? 'http://timestamp.digicert.com'
const electronZipDir = resolve(requiredEnvironment('DSH_DESKTOP_ELECTRON_ZIP_DIR'))
const windowsSignOptions = windowsSigning === undefined ? undefined : {
  certificateFile: windowsSigning.WINDOWS_CERTIFICATE_FILE as string,
  certificatePassword: windowsSigning.WINDOWS_CERTIFICATE_PASSWORD as string,
  timestampServer: windowsTimestampServer,
  description: 'DeepSeek Harness IDE',
  continueOnError: false,
}

const config: ForgeConfig = {
  packagerConfig: {
    name: 'DeepSeek Harness IDE',
    executableName: 'deepseek-harness-ide',
    appBundleId: 'ai.deepseek.harness.ide',
    appCategoryType: 'public.app-category.developer-tools',
    asar: true,
    icon: iconBase,
    electronZipDir,
    extraResource: [resolve(appRoot, 'desktop-resources')],
    ignore: [
      /^\/(?:assets|desktop-resources|node_modules|renderer|scripts|src|tests)(?:\/|$)/u,
      /^\/(?:entitlements\.mac\.plist|forge\.config\.ts|index\.html|tsconfig[^/]*\.json|tsdown\.config\.ts|vite\.config\.ts)$/u,
    ],
    ...(process.env.APPLE_SIGN_IDENTITY === undefined ? {} : {
      osxSign: {
        identity: process.env.APPLE_SIGN_IDENTITY,
        optionsForFile: () => ({
          entitlements: entitlementPath,
          hardenedRuntime: true,
        }),
      },
    }),
    ...(notarization === undefined ? {} : {
      osxNotarize: {
        appleApiKey: notarization.APPLE_API_KEY as string,
        appleApiKeyId: notarization.APPLE_API_KEY_ID as string,
        appleApiIssuer: notarization.APPLE_API_ISSUER as string,
      },
    }),
    ...(windowsSignOptions === undefined ? {} : { windowsSign: windowsSignOptions }),
  },
  makers: [
    new MakerDMG({
      format: 'ULFO',
      icon: `${iconBase}.icns`,
      name: 'DeepSeek-Harness-IDE',
    }, ['darwin']),
    new MakerSquirrel({
      name: 'deepseek_harness_ide',
      setupExe: 'DeepSeekHarnessIDESetup.exe',
      setupIcon: `${iconBase}.ico`,
      noMsi: true,
      ...(windowsSignOptions === undefined ? {} : { windowsSign: windowsSignOptions }),
    }, ['win32']),
    new MakerZIP({}, ['darwin', 'win32']),
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}

export default config
