#!/usr/bin/env node
/** Pure Node.js desktop Host sidecar entrypoint. */

import type {} from '@deepseek-ai/dsh-client-modules'
import {
  DESKTOP_RUNTIME_PROTOCOL_VERSION,
  type DesktopRuntimeOutboundFrame,
} from './runtime-protocol.ts'
import { DesktopSidecarLifecycle } from './sidecar-lifecycle.ts'
import { bootDesktopSidecar } from './sidecar-runtime.ts'

function send(frame: DesktopRuntimeOutboundFrame): boolean {
  if (typeof process.send !== 'function' || !process.connected) return false
  return process.send(frame)
}

async function main(): Promise<void> {
  if (typeof process.send !== 'function' || !process.connected) {
    throw new Error('dsh-desktop-sidecar: a connected same-Node advanced IPC parent is required')
  }
  const ctx = await bootDesktopSidecar()
  const lifecycle = new DesktopSidecarLifecycle({
    send,
    disconnect: () => { if (process.connected) process.disconnect() },
  }, async () => { await ctx.fiber.dispose() })
  process.on('message', (value) => { lifecycle.handle(value) })
  process.once('disconnect', () => { void lifecycle.shutdown() })
  process.once('SIGTERM', () => { void lifecycle.shutdown() })
  process.once('SIGINT', () => { void lifecycle.shutdown() })
  send({
    version: DESKTOP_RUNTIME_PROTOCOL_VERSION,
    type: 'desktop-runtime-ready',
    graph: ctx.clientModules.graph(),
  })
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  send({
    version: DESKTOP_RUNTIME_PROTOCOL_VERSION,
    type: 'desktop-runtime-failed',
    message,
  })
  process.stderr.write(`dsh-desktop-sidecar: ${message}\n`)
  process.exitCode = 1
}
