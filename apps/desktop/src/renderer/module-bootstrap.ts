/** Desktop-owned bootstrap for parser-independent Client module loading. */

import type {
  ClientBootstrapModule,
  ClientModuleCreateOptions,
  ClientModuleLoaderTarget,
  ClientModuleSystem,
  DshWindow,
  WebBootEntry,
  WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'

const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'
const CLIENT_RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'
const PRELOAD_IDS = [CLIENT_MODULES_ID, CLIENT_RUNTIME_ID] as const

interface BootstrapModuleExports extends Record<string, unknown> {
  apply: (...args: unknown[]) => unknown
  createClientModuleSystem(
    target: ClientModuleLoaderTarget,
    bootstrapModule: ClientBootstrapModule,
    options: ClientModuleCreateOptions,
  ): ClientModuleSystem
}

/**
 * Install the Desktop registration facade before signed bundle scripts run.
 * @param targetWindow - renderer global receiving the facade.
 * @returns the installed queue-mode facade.
 */
export function installDesktopModuleFacade(
  targetWindow: DshWindow = globalThis as DshWindow,
): ClientModuleLoaderTarget {
  const pendingQueue: ClientModuleLoaderTarget['pendingQueue'] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load(registration) {
      pendingQueue.push(registration)
    },
    create(options) {
      if (target.mode !== 'queue') {
        throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot')
      }
      const index = pendingQueue.findIndex(registration => registration.id === CLIENT_MODULES_ID)
      const registration = pendingQueue[index]
      if (registration === undefined) {
        throw new Error(`client-modules: Desktop did not preload ${CLIENT_MODULES_ID}/client.js`)
      }
      pendingQueue.splice(index, 1)
      const exports = registration.factory((specifier) => {
        throw new Error(`client-modules: ${CLIENT_MODULES_ID}/client.js requested external "${specifier}" before the module system existed`)
      })
      if (
        typeof exports.createClientModuleSystem !== 'function'
        || typeof exports.apply !== 'function'
      ) {
        throw new Error(`client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face`)
      }
      const bootstrap = exports as BootstrapModuleExports
      return bootstrap.createClientModuleSystem(target, {
        id: registration.id,
        exports: bootstrap,
      }, options)
    },
  }
  targetWindow.__ModuleLoader__ = target
  return target
}

function loadClassicScript(entry: WebBootEntry, document: Document): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.async = false
    script.src = entry.url
    script.addEventListener('load', () => {
      script.remove()
      resolve()
    }, { once: true })
    script.addEventListener('error', () => {
      script.remove()
      reject(new Error(`desktop boot: bootstrap bundle ${entry.url} failed to load`))
    }, { once: true })
    document.head.append(script)
  })
}

/**
 * Execute the signed modules and runtime bundles before AppWebEntry creates
 * the live module system.
 * @param graph - validated Desktop boot graph.
 * @param targetDocument - renderer document that can execute `dsh-app:` scripts.
 */
export async function preloadDesktopModuleBundles(
  graph: WebBootGraph,
  targetDocument: Document = document,
): Promise<void> {
  for (const id of PRELOAD_IDS) {
    const entry = graph.entries.find(candidate => candidate.id === id)
    if (entry !== undefined) await loadClassicScript(entry, targetDocument)
  }
}
