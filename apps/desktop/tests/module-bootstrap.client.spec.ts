// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  DshWindow, WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import {
  installDesktopModuleFacade, preloadDesktopModuleBundles,
} from '../src/renderer/module-bootstrap.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'

const graph = (): WebBootGraph => ({
  rev: 'desktop-graph',
  entries: [
    { id: MODULES_ID, url: 'dsh-app://plugins/modules/client.js?rev=m', rev: 'm' },
    { id: RUNTIME_ID, url: 'dsh-app://plugins/runtime/client.js?rev=r', rev: 'r' },
  ],
})

afterEach(() => {
  delete (globalThis as DshWindow).__ModuleLoader__
  vi.restoreAllMocks()
})

describe('Desktop module bootstrap', () => {
  it('materializes the modules bundle and hands queued registrations to the live system', async () => {
    const target = installDesktopModuleFacade()
    const boot = graph()
    target.load({ id: MODULES_ID, factory: () => modulesClient })
    target.load({ id: RUNTIME_ID, factory: () => ({ marker: 'desktop-runtime' }) })

    const system = target.create({ boot, staticModules: {} })

    expect(target.mode).toBe('live')
    expect(target.pendingQueue).toEqual([])
    expect(system.manifest.rev).toBe('desktop-graph')
    expect(await system.import(MODULES_ID)).toBe(modulesClient)
    expect(await system.import(`${RUNTIME_ID}/client`)).toEqual({ marker: 'desktop-runtime' })
  })

  it('loads signed bootstrap rows in modules-then-runtime order', async () => {
    const appended: string[] = []
    vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
      const script = nodes[0]
      if (!(script instanceof HTMLScriptElement)) throw new Error('expected bootstrap script')
      appended.push(script.src)
      queueMicrotask(() => { script.dispatchEvent(new Event('load')) })
    })

    await preloadDesktopModuleBundles(graph())

    expect(appended).toEqual([
      'dsh-app://plugins/modules/client.js?rev=m',
      'dsh-app://plugins/runtime/client.js?rev=r',
    ])
  })

  it('fails create when the signed graph did not preload the modules bundle', () => {
    const target = installDesktopModuleFacade()
    expect(() => target.create({ boot: graph(), staticModules: {} }))
      .toThrow(`Desktop did not preload ${MODULES_ID}/client.js`)
  })
})
