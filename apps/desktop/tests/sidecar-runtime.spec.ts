import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { desktopModuleResolverBaseUrl } from '../src/sidecar-runtime.ts'

interface ComposedRow {
  readonly id?: string
  readonly name: string
  readonly disabled?: unknown
  readonly config?: unknown
}

const bundleRoot = fileURLToPath(new URL('../../../packages/bundle/', import.meta.url))

function desktopRows(): ComposedRow[] {
  const layers = ['base', 'web-app', 'ide-app', 'desktop-app'].map(name =>
    loadOverlayPatches('desktop composition test', join(bundleRoot, name, 'cordis.patch.yml')))
  return composeEntries(layers)
}

describe('desktop sidecar runtime', () => {
  it('anchors bare modules beside the packaged Host manifest', () => {
    const installAnchor = join('/signed-host', 'package.json')
    const resolverPath = fileURLToPath(desktopModuleResolverBaseUrl(installAnchor))

    expect(dirname(resolverPath)).toBe(dirname(installAnchor))
    expect(resolverPath).toBe(join('/signed-host', 'desktop-runtime-entry.mjs'))
  })

  it('composes one closed desktop carrier, picker, preset, and subprocess roster', () => {
    const rows = desktopRows()
    const ids = rows.map(row => row.id).filter((id): id is string => id !== undefined)
    const byId = new Map(rows.map(row => [row.id, row]))

    expect(new Set(ids).size).toBe(ids.length)
    expect(byId.get('connection')?.name).toBe('@deepseek-ai/dsh-client-connection')
    expect(byId.get('connection-transport')?.disabled).toBe(true)
    expect(byId.get('connection-transport-desktop')?.name)
      .toBe('@deepseek-ai/dsh-client-connection-desktop')
    expect(byId.get('modules')?.name).toBe('@deepseek-ai/dsh-client-modules')
    expect(byId.get('module-delivery')?.disabled).toBe(true)
    expect(byId.get('module-delivery-desktop')?.name).toBe('@deepseek-ai/dsh-client-modules-desktop')
    expect(byId.get('directory-picker')?.disabled).toBe(true)
    expect(byId.get('directory-picker-electron')?.name)
      .toBe('@deepseek-ai/dsh-host-directory-picker-electron')
    expect(byId.get('ui-directory-picker-desktop')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-directory-picker-desktop')
    expect(byId.get('subprocess')?.disabled).toBe(true)
    expect(byId.get('subprocess-guardian')?.name).toBe('@deepseek-ai/dsh-subprocess-guardian')
    expect(byId.get('workspace-registration')?.name)
      .toBe('@deepseek-ai/dsh-host-workspace-registration')
    expect(byId.get('agent-presets-desktop')?.name).toBe('@deepseek-ai/dsh-agent-presets-desktop')
    expect(byId.get('api-gateway')?.config).toEqual({ nativeOpen: false })

    for (const id of ['web-startup', 'webserver', 'web-runtime', 'client-hmr', 'cordis-host-runner', 'ui-cordis', 'ui-agent-preset']) {
      expect(byId.get(id)?.disabled, id).toBe(true)
    }
    expect(rows.filter(row => row.disabled !== true && /(?:terminal|pty)/u.test(row.name))).toEqual([])
  })
})
