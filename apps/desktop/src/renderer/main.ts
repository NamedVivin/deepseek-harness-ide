/** Signed desktop bootloader: fetch the Host graph before importing the shared shell. */

import {
  parseBootManifest, type DshWindow,
} from '@deepseek-ai/dsh-client-modules/manifest'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type {
  DesktopRendererBridge,
  DesktopRendererLifecycleHost,
  DesktopPreloadApi,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import {
  installDesktopModuleFacade, preloadDesktopModuleBundles,
} from './module-bootstrap.ts'
import { createDesktopRendererCapabilities } from './preload-adapter.ts'

declare global {
  /** Narrow capabilities written by the context-isolated preload. */
  var __DSH_DESKTOP__: DesktopRendererBridge | undefined
  /** App-owned dirty-state exchange kept separate from sidecar RPC. */
  var __DSH_DESKTOP_LIFECYCLE__: DesktopRendererLifecycleHost | undefined
  /** Context-bridge-safe function table written by the sandboxed preload. */
  var __DSH_DESKTOP_PRELOAD__: DesktopPreloadApi | undefined
}

async function start(): Promise<void> {
  const preload = globalThis.__DSH_DESKTOP_PRELOAD__
  if (preload === undefined) throw new Error('desktop boot: preload capabilities are unavailable')
  const capabilities = createDesktopRendererCapabilities(preload)
  globalThis.__DSH_DESKTOP__ = capabilities.bridge
  globalThis.__DSH_DESKTOP_LIFECYCLE__ = capabilities.lifecycle
  const bridge = capabilities.bridge
  const graph = await bridge.system('desktop.bootManifest', {})
  // Parse before publication so no malformed graph reaches the shell loader.
  parseBootManifest(graph)
  ;(globalThis as DshWindow).__DSH_BOOT__ = graph
  const root = document.getElementById('root')
  if (root === null) throw new Error('desktop boot: missing #root')
  installDesktopModuleFacade()
  await preloadDesktopModuleBundles(graph)
  await new AppWebEntry(root).run()
}

void start().catch((error: unknown) => {
  const root = document.getElementById('root')
  if (root !== null) root.textContent = error instanceof Error ? error.message : String(error)
  console.error(error)
})
