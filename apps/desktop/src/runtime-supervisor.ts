/** Electron-main ownership of the guardian/sidecar lifecycle. */

import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import {
  DESKTOP_RUNTIME_PROTOCOL_VERSION,
  parseDesktopRuntimeOutboundFrame,
  type DesktopRuntimeInboundFrame,
} from './runtime-protocol.ts'
import type { DesktopRuntimeConfig } from './runtime-config.ts'

/** Lifecycle timings consumed by the Electron-owned runtime supervisor. */
export type DesktopRuntimeSupervisorConfig = Pick<
  DesktopRuntimeConfig,
  'startupTimeoutMs' | 'gracefulShutdownMs' | 'forceShutdownMs'
>

/** Child-process face retained by Electron main. */
export interface DesktopRuntimeChild {
  readonly pid?: number | undefined
  readonly connected?: boolean | undefined
  send(message: DesktopRuntimeInboundFrame): boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (value: unknown) => void): unknown
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function timeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`desktop runtime: ${label} timed out`)) }, milliseconds)
    timer.unref()
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(asError(error)) },
    )
  })
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Bounded startup, graceful disposal, forced kill, and join owner. */
export class DesktopRuntimeSupervisor {
  private readonly ready = deferred<WebBootGraph>()
  private readonly disposed = deferred<void>()
  private readonly exited = deferred<void>()
  private shutdownTask: Promise<void> | undefined
  private started = false
  private exitObserved = false

  /**
   * @param child - guardian process carrying lifecycle and Connection IPC.
   * @param config - signed lifecycle timeout configuration.
   */
  constructor(
    readonly child: DesktopRuntimeChild,
    private readonly config: DesktopRuntimeSupervisorConfig,
  ) {}

  /**
   * Wait until the Host graph is settled and published.
   * @returns live Client boot graph.
   */
  start(): Promise<WebBootGraph> {
    if (!this.started) {
      this.started = true
      this.child.on('message', this.onMessage)
      this.child.on('exit', this.onExit)
      this.child.on('error', this.onError)
      this.child.on('disconnect', this.onDisconnect)
      if (!Number.isSafeInteger(this.child.pid) || (this.child.pid as number) <= 0) {
        this.failStartup(new Error('desktop runtime: guardian did not publish a positive PID'))
      }
    }
    return timeout(this.ready.promise, this.config.startupTimeoutMs, 'startup')
  }

  /**
   * Request Cordis disposal, then force-kill and join a hung guardian.
   * @param reason - lifecycle owner initiating shutdown.
   * @returns after the owned process has exited.
   */
  shutdown(reason: DesktopRuntimeInboundFrame['reason']): Promise<void> {
    this.shutdownTask ??= this.runShutdown(reason)
    return this.shutdownTask
  }

  private readonly onMessage = (value: unknown): void => {
    const frame = parseDesktopRuntimeOutboundFrame(value)
    if (frame === undefined) return
    switch (frame.type) {
      case 'desktop-runtime-ready':
        this.ready.resolve(frame.graph)
        return
      case 'desktop-runtime-failed':
        this.failStartup(new Error(`desktop runtime failed: ${frame.message}`))
        return
      case 'desktop-runtime-disposed':
        this.disposed.resolve()
        return
    }
  }

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.exitObserved = true
    this.exited.resolve()
    this.failStartup(new Error(
      `desktop runtime exited before ready (code ${String(code)}, signal ${String(signal)})`,
    ))
    this.removeListeners()
  }

  private readonly onError = (error: Error): void => {
    this.failStartup(new Error('desktop runtime process error', { cause: error }))
  }

  private readonly onDisconnect = (): void => {
    if (!this.exitObserved) {
      this.failStartup(new Error('desktop runtime disconnected before ready'))
    }
  }

  private failStartup(error: Error): void {
    this.ready.reject(error)
  }

  private async runShutdown(reason: DesktopRuntimeInboundFrame['reason']): Promise<void> {
    if (!this.started) void this.start().catch(() => {})
    if (!this.exitObserved && this.child.connected !== false) {
      try {
        await this.runGracefulShutdown(reason)
      } catch {
        // Protocol-send, disposal, and join failures are superseded by the forced join below.
      }
    }
    if (!this.exitObserved) {
      this.child.kill('SIGKILL')
      await timeout(this.exited.promise, this.config.forceShutdownMs, 'forced guardian join')
    }
    this.removeListeners()
  }

  private async runGracefulShutdown(reason: DesktopRuntimeInboundFrame['reason']): Promise<void> {
    this.child.send({
      version: DESKTOP_RUNTIME_PROTOCOL_VERSION,
      type: 'desktop-runtime-dispose',
      reason,
    })
    await timeout(this.disposed.promise, this.config.gracefulShutdownMs, 'graceful shutdown')
    await timeout(this.exited.promise, this.config.gracefulShutdownMs, 'guardian join')
  }

  private removeListeners(): void {
    this.child.off('message', this.onMessage)
    this.child.off('exit', this.onExit)
    this.child.off('error', this.onError)
    this.child.off('disconnect', this.onDisconnect)
  }
}
