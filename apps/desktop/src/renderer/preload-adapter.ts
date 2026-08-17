/** Main-world adapter over the context-bridge-safe preload API. */

import type {
  DesktopConnectionStream,
  DesktopPreloadApi,
  DesktopPreloadStreamEnd,
  DesktopRendererBridge,
  DesktopRendererInvocation,
  DesktopRendererInvocationResult,
  DesktopRendererLifecycleHost,
  DesktopRendererLifecycleMethodMap,
  DesktopRendererSystemMethodMap,
  DesktopRendererSystemRequest,
  DesktopRendererSystemResponse,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'

type DesktopDownlinkEvent = AsyncIterableValue<ReturnType<DesktopRendererBridge['subscribe']>>
type AsyncIterableValue<T> = T extends AsyncIterable<infer V> ? V : never

interface QueueWaiter<T> {
  readonly resolve: (value: IteratorResult<T>) => void
  readonly reject: (reason: unknown) => void
}

class RendererAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: QueueWaiter<T>[] = []
  private ended = false
  private failure: Error | undefined

  push(value: T): void {
    if (this.ended || this.failure !== undefined) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ value, done: false })
  }

  end(result: DesktopPreloadStreamEnd): void {
    if (this.ended || this.failure !== undefined) return
    if (!result.ok) {
      this.failure = new Error(result.message)
      for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure)
      return
    }
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.failure !== undefined) return Promise.reject(this.failure)
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      },
    }
  }
}

type LifecycleHandler = (
  payload: DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['request'],
  signal: AbortSignal,
) => Promise<DesktopRendererLifecycleMethodMap['desktop.prepareQuit']['response']>

/** Exact renderer capabilities reconstructed in the main world. */
export interface DesktopRendererCapabilities {
  readonly bridge: DesktopRendererBridge
  readonly lifecycle: DesktopRendererLifecycleHost
}

/**
 * Reconstruct AbortSignal and AsyncIterable semantics without crossing context isolation.
 * @param preload - frozen contextBridge-safe function table.
 * @returns exact Connection and lifecycle capabilities for Client plugins.
 */
export function createDesktopRendererCapabilities(preload: DesktopPreloadApi): DesktopRendererCapabilities {
  const lifecycleCalls = new Map<string, AbortController>()
  let lifecycleHandler: LifecycleHandler | undefined

  preload.registerLifecycle((id, payload) => {
    const handler = lifecycleHandler
    if (handler === undefined) {
      preload.settleLifecycle(id, { ready: false })
      return
    }
    const abort = new AbortController()
    lifecycleCalls.set(id, abort)
    void handler(payload, abort.signal).then(
      (response) => { preload.settleLifecycle(id, response) },
      () => { preload.settleLifecycle(id, { ready: false }) },
    ).finally(() => { lifecycleCalls.delete(id) })
  }, (id) => {
    lifecycleCalls.get(id)?.abort(new Error('desktop lifecycle request cancelled'))
    lifecycleCalls.delete(id)
  })

  const withCancellation = async <T>(
    id: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (signal?.aborted === true) throw abortReason(signal)
    const onAbort = (): void => { preload.cancel(id) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await operation()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const bridge: DesktopRendererBridge = {
    invoke(
      invocation: DesktopRendererInvocation,
      signal?: AbortSignal,
    ): Promise<DesktopRendererInvocationResult> {
      const id = crypto.randomUUID()
      return withCancellation(id, signal, () => preload.invoke(id, invocation))
    },
    system<K extends keyof DesktopRendererSystemMethodMap>(
      method: K,
      payload: DesktopRendererSystemRequest<K>,
      signal?: AbortSignal,
    ): Promise<DesktopRendererSystemResponse<K>> {
      const id = crypto.randomUUID()
      return withCancellation(id, signal, () => preload.system(
        id,
        method,
        payload,
      ))
    },
    async *subscribe(
      stream: DesktopConnectionStream,
      signal: AbortSignal,
    ): AsyncGenerator<DesktopDownlinkEvent> {
      if (signal.aborted) throw abortReason(signal)
      const id = crypto.randomUUID()
      const queue = new RendererAsyncQueue<DesktopDownlinkEvent>()
      const onAbort = (): void => {
        preload.unsubscribe(id)
        queue.end({ ok: false, message: abortReason(signal).message })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      preload.subscribe(id, stream, (event) => { queue.push(event) }, (result) => { queue.end(result) })
      try {
        for await (const event of queue) yield event
      } finally {
        signal.removeEventListener('abort', onAbort)
        preload.unsubscribe(id)
      }
    },
  }

  const lifecycle: DesktopRendererLifecycleHost = {
    handle(method, handler) {
      validateLifecycleMethod(method)
      if (lifecycleHandler !== undefined) throw new Error('desktop renderer: lifecycle handler already registered')
      const registered = handler
      lifecycleHandler = registered
      return () => { if (lifecycleHandler === registered) lifecycleHandler = undefined }
    },
  }
  return { bridge, lifecycle }
}

function validateLifecycleMethod(method: string): void {
  if (method !== 'desktop.prepareQuit') {
    throw new Error(`desktop renderer: unsupported lifecycle method ${JSON.stringify(method)}`)
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop renderer operation aborted')
}
