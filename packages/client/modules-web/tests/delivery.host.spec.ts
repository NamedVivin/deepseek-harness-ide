import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import type {
  ClientModuleDeliveryHost, WebBootGraph,
} from '@deepseek-ai/dsh-client-modules'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import {
  renderIndexInjections, type IndexInjection, type WebRoute, type WebServer,
} from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, bootInjections, WebClientModuleDelivery } from '../src/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'

let temp: string | undefined
afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

function graph(id: string, rev: string): WebBootGraph {
  return { rev: 'graph', entries: [{ id, rev, url: `/plugins/${id}/client.js?rev=${rev}` }] }
}

/** Execute the exact first inline script emitted by the Web delivery provider. */
function injectedFacade(graph: WebBootGraph): { html: string; target: ClientModuleLoaderTarget } {
  const html = renderIndexInjections(
    '<html><head></head><body><script type="module" src="/index.js"></script></body></html>',
    bootInjections(graph),
  )
  const source = /<head><script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (source === undefined) throw new Error('missing injected ModuleLoader facade script')
  const window: { __ModuleLoader__?: ClientModuleLoaderTarget } = {}
  runInNewContext(source, { window })
  if (window.__ModuleLoader__ === undefined) throw new Error('facade script did not install __ModuleLoader__')
  return { html, target: window.__ModuleLoader__ }
}

const bootGraph = (): WebBootGraph => ({
  rev: 'graph',
  entries: [
    { id: MODULES_ID, url: '/plugins/modules.js?rev=m', rev: 'm' },
    { id: RUNTIME_ID, url: '/plugins/runtime.js?rev=r', rev: 'r' },
  ],
})

describe('HTML bootstrap facade', () => {
  it('precedes blocking preloads and the boot graph, then becomes the live registration target', async () => {
    const graph = bootGraph()
    const { html, target } = injectedFacade(graph)
    const facadeAt = html.indexOf('window.__ModuleLoader__=')
    const modulesAt = html.indexOf('<script src="/plugins/modules.js?rev=m"></script>')
    const runtimeAt = html.indexOf('<script src="/plugins/runtime.js?rev=r"></script>')
    const graphAt = html.indexOf('globalThis["__DSH_BOOT__"] = ')
    const entryAt = html.indexOf('<script type="module" src="/index.js"></script>')
    expect([facadeAt, modulesAt, runtimeAt, graphAt, entryAt]).toEqual([...new Set([
      facadeAt, modulesAt, runtimeAt, graphAt, entryAt,
    ])].sort((a, b) => a - b))

    target.load({ id: MODULES_ID, factory: () => modulesClient })
    target.load({ id: RUNTIME_ID, factory: () => ({ marker: 'runtime' }) })
    const system = target.create({ boot: graph, staticModules: {} })

    expect(target.mode).toBe('live')
    expect(target.pendingQueue).toEqual([])
    expect(system.manifest.rev).toBe('graph')
    expect(await system.import(MODULES_ID)).toBe(modulesClient)
    expect(await system.import(`${RUNTIME_ID}/client`)).toEqual({ marker: 'runtime' })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow('create called after module-system boot')
  })

  it('rejects a page that did not preload the modules bundle', () => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`HTML did not preload ${MODULES_ID}/client.js`)
  })

  it('rejects a bootstrap bundle with a runtime external', () => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    target.load({
      id: MODULES_ID,
      factory: (require) => {
        require('react')
        return modulesClient
      },
    })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`${MODULES_ID}/client.js requested external "react"`)
  })

  it.each([
    null,
    { ...modulesClient, createClientModuleSystem: undefined },
    { ...modulesClient, apply: undefined },
  ])('rejects a bootstrap bundle without the complete module face', (exports) => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    target.load({ id: MODULES_ID, factory: () => exports as unknown as Record<string, unknown> })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`${MODULES_ID}/client.js did not export the bootstrap module face`)
  })
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
    let current = graph(id, 'rev-1')
    const missingId = '@fixture/missing'
    const host: ClientModuleDeliveryHost = {
      graph: () => current,
      clientPath: candidate => candidate === id ? clientPath : candidate === missingId ? join(temp!, 'missing.js') : undefined,
      onGraphChanged: () => () => {},
    }
    let route: WebRoute | undefined
    let routeRemovals = 0
    const ctx = new Context()
    ctx.provide('webServer', {
      port: 0,
      register: (candidate: WebRoute) => { route = candidate; return () => { routeRemovals += 1 } },
      registerUpgrade: () => () => {},
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
    const collect = (): IndexInjection[] => {
      const table: IndexInjection[] = []
      ctx.emit('webserver/index-inject', table)
      return table
    }
    expect(collect()).toEqual(bootInjections(current))
    current = graph(id, 'rev-2')
    expect(collect().at(-1)).toEqual({ kind: 'global', name: '__DSH_BOOT__', value: current })

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
    expect(collect()).toEqual([])
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
