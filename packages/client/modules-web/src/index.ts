/** HTTP asset and index-manifest provider for the Client module registry. */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  ClientModuleDelivery,
  type ClientModuleDeliveryHost,
  type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'client-modules-web'
/** Required Web route and index-tap owner. */
export const inject = ['webServer']

/**
 * Inject the boot graph before the Web shell executes.
 * @param html - rendered index document.
 * @param graph - current Client module graph.
 * @returns document with a safe inline manifest assignment.
 */
export function injectBootManifest(html: string, graph: WebBootGraph): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const script = `<script>window.__DSH_BOOT__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}

/** Web delivery provider for `/plugins/*` and index bootstrap injection. */
export class WebClientModuleDelivery extends ClientModuleDelivery {
  private host: ClientModuleDeliveryHost | undefined

  /** @inheritdoc */
  bundleUrl(id: string, revision: string): string {
    return `/plugins/${id}/client.js?rev=${revision}`
  }

  /** @inheritdoc */
  install(host: ClientModuleDeliveryHost): () => void {
    if (this.host !== undefined) throw new Error('client-modules-web: delivery already installed')
    this.host = host
    const removeRoute = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/plugins',
      handler: this.serveBundle,
    })
    const removeIndexTap = this.ctx.webServer.tapIndex(html => injectBootManifest(html, host.graph()))
    return () => {
      removeIndexTap()
      removeRoute()
      if (this.host === host) this.host = undefined
    }
  }

  /** @inheritdoc */
  resolveBundleUrl(url: string): string | undefined {
    const host = this.host
    if (host === undefined) return undefined
    let relative = url
    try {
      const parsed = new URL(url, 'http://dsh.internal')
      relative = `${parsed.pathname}${parsed.search}`
    } catch {
      return undefined
    }
    const row = host.graph().entries.find(candidate => candidate.url === relative)
    return row === undefined ? undefined : host.clientPath(row.id)
  }

  private readonly serveBundle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    const prefix = '/plugins/'
    const mapSuffix = '/client.js.map'
    const bundleSuffix = '/client.js'
    const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix)
    const suffix = isSourceMap ? mapSuffix : bundleSuffix
    const clientPath = pathname.startsWith(prefix) && pathname.endsWith(suffix)
      ? this.host?.clientPath(pathname.slice(prefix.length, -suffix.length))
      : undefined
    const path = clientPath === undefined ? undefined : `${clientPath}${isSourceMap ? '.map' : ''}`
    if (path === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      const body = await readFile(path)
      res.writeHead(200, {
        'content-type': isSourceMap
          ? 'application/json; charset=utf-8'
          : 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }
}

/**
 * Provide Web module delivery.
 * @param ctx - Host context carrying the Web server.
 */
export function apply(ctx: Context): void {
  new WebClientModuleDelivery(ctx)
}
