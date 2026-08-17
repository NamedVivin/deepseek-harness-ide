import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ClientModuleDeliveryHost, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, injectBootManifest, WebClientModuleDelivery } from '../src/index.ts'

let temp: string | undefined
afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

function graph(id: string, rev: string): WebBootGraph {
  return { rev: 'graph', entries: [{ id, rev, url: `/plugins/${id}/client.js?rev=${rev}` }] }
}

it('injects escaped boot data before the Web shell', () => {
  const output = injectBootManifest('<html><head></head></html>', {
    rev: 'r',
    entries: [{ id: '<unsafe>', rev: 'x', url: '/plugins/x' }],
  })
  expect(output).toContain('window.__DSH_BOOT__')
  expect(output).toContain('\\u003cunsafe>')
  expect(output.indexOf('window.__DSH_BOOT__')).toBeLessThan(output.indexOf('</head>'))
  expect(injectBootManifest('<main>shell</main>', { rev: 'r', entries: [] }))
    .toBe('<script>window.__DSH_BOOT__ = {"rev":"r","entries":[]}</script><main>shell</main>')
})

function responseCapture(): {
  readonly response: ServerResponse
  readonly result: () => { status: number; headers: Record<string, string> | undefined; body: string }
} {
  let status = 0
  let headers: Record<string, string> | undefined
  let body = ''
  const response = {
    writeHead(next: number, nextHeaders?: Record<string, string>) {
      status = next
      headers = nextHeaders
      return response
    },
    end(chunk?: Uint8Array) {
      body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
      return response
    },
  } as unknown as ServerResponse
  return { response, result: () => ({ status, headers, body }) }
}

describe('WebClientModuleDelivery', () => {
  it('serves source maps beside registered bundles and resolves exact advertised URLs', async () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-modules-web-'))
    const id = '@fixture/source-map'
    const clientPath = join(temp, 'client.js')
    const map = '{"version":3}\n'
    writeFileSync(clientPath, 'module.exports = {}\n')
    writeFileSync(`${clientPath}.map`, map)
    const current = graph(id, 'rev-1')
    const missingId = '@fixture/missing'
    const host: ClientModuleDeliveryHost = {
      graph: () => current,
      clientPath: candidate => candidate === id ? clientPath : candidate === missingId ? join(temp!, 'missing.js') : undefined,
      onGraphChanged: () => () => {},
    }
    let route: WebRoute | undefined
    let routeRemovals = 0
    let indexRemovals = 0
    let transformIndex: ((html: string) => string) | undefined
    const ctx = new Context()
    ctx.provide('webServer', {
      port: 0,
      register: (candidate: WebRoute) => { route = candidate; return () => { routeRemovals += 1 } },
      registerUpgrade: () => () => {},
      tapIndex: (transform: (html: string) => string) => {
        transformIndex = transform
        return () => { indexRemovals += 1 }
      },
    } as unknown as WebServer)
    const delivery = new WebClientModuleDelivery(ctx)
    expect(delivery.resolveBundleUrl(current.entries[0]!.url)).toBeUndefined()
    expect(delivery.resolveBundleUrl('http://[invalid')).toBeUndefined()
    const dispose = delivery.install(host)
    expect(() => delivery.install(host)).toThrow('delivery already installed')
    expect(delivery.resolveBundleUrl(current.entries[0]!.url)).toBe(clientPath)
    expect(delivery.resolveBundleUrl(`${current.entries[0]!.url}-stale`)).toBeUndefined()
    expect(delivery.resolveBundleUrl('http://[invalid')).toBeUndefined()
    expect(delivery.bundleUrl(id, 'next')).toBe(`/plugins/${id}/client.js?rev=next`)
    expect(transformIndex?.('<html><head></head></html>')).toContain('window.__DSH_BOOT__')

    let capture = responseCapture()
    await route!.handler({ method: 'GET', url: `/plugins/${id}/client.js.map` } as IncomingMessage, capture.response)
    expect(capture.result()).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' },
      body: map,
    })

    capture = responseCapture()
    await route!.handler({ method: 'HEAD', url: `/plugins/${id}/client.js` } as IncomingMessage, capture.response)
    expect(capture.result().status).toBe(200)
    expect(capture.result().headers?.['content-type']).toBe('text/javascript; charset=utf-8')

    for (const request of [
      { method: 'POST', url: `/plugins/${id}/client.js`, status: 405 },
      { method: 'GET', url: '/plugins/%E0%A4%A/client.js', status: 404 },
      { method: 'GET', url: '/plugins/not-a-bundle', status: 404 },
      { method: 'GET', url: `/plugins/${missingId}/client.js`, status: 404 },
      { method: 'GET', status: 404 },
    ]) {
      capture = responseCapture()
      await route!.handler(request as unknown as IncomingMessage, capture.response)
      expect(capture.result().status).toBe(request.status)
      expect(capture.result().body).toBe('')
    }

    dispose()
    dispose()
    expect(routeRemovals).toBe(2)
    expect(indexRemovals).toBe(2)
    expect(delivery.resolveBundleUrl(current.entries[0]!.url)).toBeUndefined()
    capture = responseCapture()
    await route!.handler({ method: 'GET', url: `/plugins/${id}/client.js` } as IncomingMessage, capture.response)
    expect(capture.result().status).toBe(404)
    await ctx.fiber.dispose()
  })

  it('provides the carrier service through its Cordis plugin', async () => {
    const ctx = new Context()
    ctx.provide('webServer', {
      port: 0,
      register: () => () => {},
      registerUpgrade: () => () => {},
      tapIndex: () => () => {},
    } as unknown as WebServer)
    apply(ctx)
    expect(ctx.clientModuleDelivery).toBeInstanceOf(WebClientModuleDelivery)
    await ctx.fiber.dispose()
  })
})
