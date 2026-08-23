/** HTTP asset and index-manifest provider for the Client module registry. */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  ClientModuleDelivery,
  type ClientModuleDeliveryHost,
  type WebBootEntry,
  type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'client-modules-web'
/** Required Web route and index-tap owner. */
export const inject = ['webServer']

/** Bootstrap package whose ordinary client bundle supplies the module system. */
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** Dynamic package registered before Client plugin boot starts. */
const CLIENT_RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'

/** Ordinary dynamic bundles executed before the Vite shell. */
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID, CLIENT_RUNTIME_ID] as const

/**
 * Build the Web boot protocol as structured index rows. The same rows feed
 * served HTML and worker boot payloads.
 * @param graph - current composed Client graph.
 * @returns queue facade, parser preloads, and graph global in execution order.
 */
export function bootInjections(graph: WebBootGraph): IndexInjection[] {
  const bootstrapId = JSON.stringify(CLIENT_MODULES_ID)
  const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${bootstrapId})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`
  const preload = PARSER_PRELOAD_IDS.map(id => graph.entries.find(entry => entry.id === id))
    .filter((entry): entry is WebBootEntry => entry !== undefined)
    .map((entry): IndexInjection => ({ kind: 'script-src', placement: 'head', src: entry.url }))
  return [
    { kind: 'script', placement: 'head', text: queue },
    ...preload,
    { kind: 'global', name: '__DSH_BOOT__', value: graph },
  ]
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
    const removeIndexInjection = this.ctx.on('webserver/index-inject', (table) => {
      table.push(...bootInjections(host.graph()))
    })
    return () => {
      removeIndexInjection()
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
