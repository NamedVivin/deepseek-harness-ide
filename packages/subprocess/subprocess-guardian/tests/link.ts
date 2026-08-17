import type { GuardianFrame } from '../src/protocol.ts'
import type { GuardianMessageEndpoint } from '../src/channel.ts'

/** Deterministic, advanced-serialization-like child IPC link for guardian tests. */
export class MemoryGuardianEndpoint implements GuardianMessageEndpoint {
  private readonly messages = new Set<(value: unknown) => void>()
  private readonly disconnects = new Set<() => void>()
  peer: MemoryGuardianEndpoint | undefined

  async send(frame: GuardianFrame): Promise<void> {
    const target = this.peer
    if (target === undefined) throw new Error('memory guardian endpoint disconnected')
    queueMicrotask(() => {
      for (const listener of target.messages) listener(structuredClone(frame))
    })
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.messages.add(listener)
    return () => { this.messages.delete(listener) }
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnects.add(listener)
    return () => { this.disconnects.delete(listener) }
  }

  disconnect(): void {
    const target = this.peer
    this.peer = undefined
    if (target !== undefined) target.peer = undefined
    for (const listener of this.disconnects) listener()
    for (const listener of target?.disconnects ?? []) listener()
  }
}

/** Create two connected logical endpoints. */
export function memoryGuardianLink(): readonly [MemoryGuardianEndpoint, MemoryGuardianEndpoint] {
  const left = new MemoryGuardianEndpoint()
  const right = new MemoryGuardianEndpoint()
  left.peer = right
  right.peer = left
  return [left, right]
}
