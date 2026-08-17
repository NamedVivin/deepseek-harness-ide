import { Context } from '@deepseek-ai/cordis'
import type { ClientModuleDeliveryHost, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { describe, expect, it } from 'vitest'
import { apply, DesktopClientModuleDelivery } from '../src/index.ts'

describe('DesktopClientModuleDelivery', () => {
  it('maps only an exact manifest-whitelisted immutable URL', async () => {
    const ctx = new Context()
    const delivery = new DesktopClientModuleDelivery(ctx)
    const id = '@deepseek-ai/dsh-client-ui-ide'
    const url = delivery.bundleUrl(id, 'abc123')
    const graph: WebBootGraph = { rev: 'graph', entries: [{ id, rev: 'abc123', url }] }
    const host: ClientModuleDeliveryHost = {
      graph: () => graph,
      clientPath: candidate => candidate === id ? '/signed/client.js' : undefined,
      onGraphChanged: () => () => {},
    }
    const dispose = delivery.install(host)
    expect(() => delivery.install(host)).toThrow('delivery already installed')
    expect(url).toBe(`dsh-app://plugins/${id}/client.js?rev=abc123`)
    expect(delivery.resolveBundleUrl(url)).toBe('/signed/client.js')
    expect(delivery.resolveBundleUrl(url.replace('abc123', 'stale'))).toBeUndefined()
    expect(delivery.resolveBundleUrl('dsh-app://plugins/../secrets/client.js?rev=abc123')).toBeUndefined()
    expect(delivery.resolveBundleUrl(`${url}#fragment`)).toBeUndefined()
    dispose()
    dispose()
    expect(delivery.resolveBundleUrl(url)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('provides the carrier service through its Cordis plugin', async () => {
    const ctx = new Context()
    apply(ctx)
    expect(ctx.clientModuleDelivery).toBeInstanceOf(DesktopClientModuleDelivery)
    await ctx.fiber.dispose()
  })
})
