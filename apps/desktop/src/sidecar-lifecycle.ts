/** Single-shot, quiescent Host sidecar shutdown coordination. */

import {
  DESKTOP_RUNTIME_PROTOCOL_VERSION,
  parseDesktopRuntimeInboundFrame,
  type DesktopRuntimeOutboundFrame,
} from './runtime-protocol.ts'

/** Minimal child-IPC lifecycle face used by the sidecar and deterministic tests. */
export interface DesktopSidecarProcess {
  /** Send one application lifecycle frame to Electron main. */
  send(frame: DesktopRuntimeOutboundFrame): boolean
  /** Disconnect the control channel after all owned services are quiescent. */
  disconnect(): void
}

/** Host teardown owner shared by IPC-disconnect, signal, and ordinary app quit paths. */
export class DesktopSidecarLifecycle {
  private settlement: Promise<void> | undefined

  /**
   * @param sidecar - connected process control face.
   * @param disposeHost - reaches Cordis and provider quiescence.
   */
  constructor(
    private readonly sidecar: DesktopSidecarProcess,
    private readonly disposeHost: () => Promise<void>,
  ) {}

  /**
   * Consume a lifecycle message, leaving Connection frames to their adapter.
   * @param value - untrusted child-IPC message.
   * @returns true only when this lifecycle owns the frame.
   */
  handle(value: unknown): boolean {
    const frame = parseDesktopRuntimeInboundFrame(value)
    if (frame === undefined) return false
    void this.shutdown()
    return true
  }

  /**
   * Dispose once, publish completion once, then close IPC.
   * @returns the shared shutdown settlement.
   */
  shutdown(): Promise<void> {
    this.settlement ??= this.run()
    return this.settlement
  }

  private async run(): Promise<void> {
    await this.disposeHost()
    this.sidecar.send({
      version: DESKTOP_RUNTIME_PROTOCOL_VERSION,
      type: 'desktop-runtime-disposed',
    })
    this.sidecar.disconnect()
  }
}
