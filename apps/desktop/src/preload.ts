/** Sandboxed context-isolated preload exposing only closed desktop capabilities. */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  DesktopPortHandoff,
  DesktopPreloadApi,
  DesktopPreloadStreamEnd,
  DesktopRendererLifecycleMethodMap,
} from '@deepseek-ai/dsh-client-connection-desktop'
import {
  createElectronPreloadPortEndpoint,
  DesktopPreloadPortBridge,
} from './electron-port-bridge.ts'
import {
  DESKTOP_PORT_CHANNEL,
} from './preload-api.ts'

type LifecyclePayload = DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['request']
type LifecycleResponse = DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['response']
type InvokeParameters = Parameters<DesktopPreloadApi['invoke']>
type SystemParameters = Parameters<DesktopPreloadApi['system']>
type SubscribeParameters = Parameters<DesktopPreloadApi['subscribe']>
type RegisterLifecycleParameters = Parameters<DesktopPreloadApi['registerLifecycle']>

interface LifecycleSettlement {
  readonly resolve: (response: LifecycleResponse) => void
  readonly reject: (error: Error) => void
  readonly removeAbort: () => void
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function parseHandoff(value: unknown): DesktopPortHandoff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop preload: invalid port handoff')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || typeof record.limits !== 'object' || record.limits === null || Array.isArray(record.limits)
    || Object.keys(record).some(key => key !== 'version' && key !== 'limits')) {
    throw new Error('desktop preload: invalid port handoff')
  }
  const limits = record.limits as Record<string, unknown>
  const names = [
    'maxDesktopBodyBytes',
    'maxDesktopChunkBytes',
    'maxDesktopInflightBytes',
  ] as const
  if (Object.keys(limits).some(key => !names.includes(key as typeof names[number]))) {
    throw new Error('desktop preload: invalid port limits')
  }
  for (const name of names) {
    if (!Number.isSafeInteger(limits[name]) || (limits[name] as number) < 1) {
      throw new Error(`desktop preload: ${name} must be a positive safe integer`)
    }
  }
  return {
    version: 1,
    limits: {
      maxDesktopBodyBytes: limits.maxDesktopBodyBytes as number,
      maxDesktopChunkBytes: limits.maxDesktopChunkBytes as number,
      maxDesktopInflightBytes: limits.maxDesktopInflightBytes as number,
    },
  }
}

function parseLifecycleResponse(value: unknown): LifecycleResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop preload: invalid lifecycle response')
  }
  const record = value as Record<string, unknown>
  if (typeof record.ready !== 'boolean' || Object.keys(record).some(key => key !== 'ready')) {
    throw new Error('desktop preload: invalid lifecycle response')
  }
  return { ready: record.ready }
}

const ready = deferred<DesktopPreloadPortBridge>()
let physicalBridge: DesktopPreloadPortBridge | undefined
const requests = new Map<string, AbortController>()
const subscriptions = new Map<string, AbortController>()
const lifecycleSettlements = new Map<string, LifecycleSettlement>()
let lifecycleCallbacks: {
  readonly onRequest: (id: string, payload: LifecyclePayload) => void
  readonly onCancel: (id: string) => void
} | undefined
let lifecycleInstalled = false

function requireId(id: string): void {
  if (id === '' || id.length > 256) throw new Error('desktop preload: operation id must be non-empty and bounded')
}

function uniqueId(map: ReadonlyMap<string, unknown>, id: string): void {
  requireId(id)
  if (map.has(id)) throw new Error(`desktop preload: duplicate operation id ${JSON.stringify(id)}`)
}

function installLifecycle(bridge: DesktopPreloadPortBridge): void {
  if (lifecycleInstalled || lifecycleCallbacks === undefined) return
  lifecycleInstalled = true
  bridge.handle('desktop.prepareQuit', (payload, signal) => {
    const id = crypto.randomUUID()
    return new Promise<LifecycleResponse>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = lifecycleSettlements.get(id)
        if (pending === undefined) return
        lifecycleSettlements.delete(id)
        pending.removeAbort()
        lifecycleCallbacks?.onCancel(id)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      lifecycleSettlements.set(id, {
        resolve,
        reject,
        removeAbort: () => { signal.removeEventListener('abort', onAbort) },
      })
      lifecycleCallbacks?.onRequest(id, payload)
    })
  })
}

ipcRenderer.once(DESKTOP_PORT_CHANNEL, (event: IpcRendererEvent, value: unknown) => {
  try {
    const [port] = event.ports
    if (physicalBridge !== undefined || event.ports.length !== 1 || port === undefined) {
      throw new Error('desktop preload: expected one port handoff')
    }
    const handoff = parseHandoff(value)
    const bridge = new DesktopPreloadPortBridge(
      createElectronPreloadPortEndpoint(port),
      handoff.limits,
    )
    physicalBridge = bridge
    installLifecycle(bridge)
    ready.resolve(bridge)
  } catch (error) {
    ready.reject(error)
  }
})

async function invokeWithController<T>(
  id: string,
  operation: (bridge: DesktopPreloadPortBridge, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  uniqueId(requests, id)
  const abort = new AbortController()
  requests.set(id, abort)
  try {
    return await operation(await ready.promise, abort.signal)
  } finally {
    requests.delete(id)
  }
}

const api: DesktopPreloadApi = Object.freeze({
  invoke: (id: InvokeParameters[0], invocation: InvokeParameters[1]) => invokeWithController(
    id,
    (bridge, signal) => bridge.invoke(invocation, signal),
  ),
  system: (id: SystemParameters[0], method: SystemParameters[1], payload: SystemParameters[2]) => invokeWithController(
    id,
    (bridge, signal) => bridge.system(method, payload, signal),
  ),
  cancel(id: string) {
    requireId(id)
    requests.get(id)?.abort(new Error('desktop renderer request cancelled'))
  },
  subscribe(
    id: SubscribeParameters[0],
    stream: SubscribeParameters[1],
    onEvent: SubscribeParameters[2],
    onEnd: SubscribeParameters[3],
  ) {
    uniqueId(subscriptions, id)
    const abort = new AbortController()
    subscriptions.set(id, abort)
    void ready.promise.then(async (bridge) => {
      try {
        for await (const event of bridge.subscribe(stream, abort.signal)) onEvent(event)
        onEnd({ ok: true })
      } catch (error) {
        const result: DesktopPreloadStreamEnd = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
        onEnd(result)
      } finally {
        subscriptions.delete(id)
      }
    }, (error: unknown) => {
      subscriptions.delete(id)
      onEnd({ ok: false, message: error instanceof Error ? error.message : String(error) })
    })
  },
  unsubscribe(id: string) {
    requireId(id)
    subscriptions.get(id)?.abort(new Error('desktop renderer subscription cancelled'))
  },
  registerLifecycle(
    onRequest: RegisterLifecycleParameters[0],
    onCancel: RegisterLifecycleParameters[1],
  ) {
    if (lifecycleCallbacks !== undefined) throw new Error('desktop preload: lifecycle callbacks already registered')
    lifecycleCallbacks = { onRequest, onCancel }
    if (physicalBridge !== undefined) installLifecycle(physicalBridge)
  },
  settleLifecycle(id: string, response: LifecycleResponse) {
    requireId(id)
    const pending = lifecycleSettlements.get(id)
    if (pending === undefined) return
    lifecycleSettlements.delete(id)
    pending.removeAbort()
    try {
      pending.resolve(parseLifecycleResponse(response))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  },
})

contextBridge.exposeInMainWorld('__DSH_DESKTOP_PRELOAD__', api)

globalThis.addEventListener('unload', () => {
  for (const abort of requests.values()) abort.abort(new Error('desktop renderer unloaded'))
  for (const abort of subscriptions.values()) abort.abort(new Error('desktop renderer unloaded'))
  for (const pending of lifecycleSettlements.values()) {
    pending.removeAbort()
    pending.reject(new Error('desktop renderer unloaded'))
  }
  requests.clear()
  subscriptions.clear()
  lifecycleSettlements.clear()
  void physicalBridge?.dispose()
}, { once: true })

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop preload operation aborted')
}
