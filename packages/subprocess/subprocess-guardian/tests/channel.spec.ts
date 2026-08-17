import { describe, expect, it, vi } from 'vitest'
import {
  FramedGuardianPeer,
  type GuardianMessageEndpoint,
} from '../src/channel.ts'
import {
  GUARDIAN_PROTOCOL_NAMESPACE,
  GUARDIAN_PROTOCOL_VERSION,
  GuardianStreamId,
  type GuardianFrame,
} from '../src/protocol.ts'

const limits = { maxBodyBytes: 1024, maxChunkBytes: 3, maxInflightBytes: 6 }

class TestEndpoint implements GuardianMessageEndpoint {
  readonly messages = new Set<(value: unknown) => void>()
  readonly disconnects = new Set<() => void>()
  peer: TestEndpoint | undefined
  currentInflight = 0
  maximumInflight = 0

  async send(frame: GuardianFrame): Promise<void> {
    if (this.peer === undefined) throw new Error('test endpoint disconnected')
    if (frame.type === 'chunk') {
      this.currentInflight += frame.data.length
      this.maximumInflight = Math.max(this.maximumInflight, this.currentInflight)
    } else if (frame.type === 'ack') {
      this.peer.currentInflight -= frame.bytes
    }
    const target = this.peer
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

  inject(value: unknown): void {
    for (const listener of this.messages) listener(value)
  }

  disconnect(): void {
    const other = this.peer
    this.peer = undefined
    if (other !== undefined) other.peer = undefined
    for (const listener of this.disconnects) listener()
    for (const listener of other?.disconnects ?? []) listener()
  }
}

function peers(): { left: FramedGuardianPeer; right: FramedGuardianPeer; leftEndpoint: TestEndpoint; rightEndpoint: TestEndpoint } {
  const leftEndpoint = new TestEndpoint()
  const rightEndpoint = new TestEndpoint()
  leftEndpoint.peer = rightEndpoint
  rightEndpoint.peer = leftEndpoint
  return {
    left: new FramedGuardianPeer(leftEndpoint, limits),
    right: new FramedGuardianPeer(rightEndpoint, limits),
    leftEndpoint,
    rightEndpoint,
  }
}

describe('FramedGuardianPeer', () => {
  it('round-trips bounded JSON calls and runs post-reply work after body acknowledgement', async () => {
    const { left, right } = peers()
    let replied = false
    const remove = right.handleCalls(async (operation, body) => ({
      value: { operation, body },
      afterReply: () => { replied = true },
    }))
    await expect(left.call('resolve-executable', { text: '你好' })).resolves.toEqual({
      operation: 'resolve-executable',
      body: { text: '你好' },
    })
    await vi.waitFor(() => { expect(replied).toBe(true) })
    remove()
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('preserves stream ordering and caps concurrent unacknowledged bytes hop-wide', async () => {
    const { left, right, leftEndpoint } = peers()
    const first = GuardianStreamId('first')
    const second = GuardianStreamId('second')
    const release = Promise.withResolvers<undefined>()
    const received = new Map<string, string[]>([['first', []], ['second', []]])
    const accept = (id: typeof first) => right.acceptStream(id, {
      write: async (chunk) => {
        await release.promise
        received.get(id)?.push(chunk.toString())
      },
      end: () => {},
      fail: () => {},
    })
    const complete = [accept(first), accept(second)]
    const firstWriter = left.createWriter(first)
    const secondWriter = left.createWriter(second)
    const writes = [firstWriter.write(Buffer.from('abcdef')), secondWriter.write(Buffer.from('123456'))]
    await vi.waitFor(() => { expect(leftEndpoint.maximumInflight).toBe(6) })
    expect(leftEndpoint.currentInflight).toBe(6)
    release.resolve(undefined)
    await Promise.all(writes)
    await Promise.all([firstWriter.end(), secondWriter.end(), ...complete])
    expect(received.get('first')).toEqual(['abc', 'def'])
    expect(received.get('second')).toEqual(['123', '456'])
    expect(leftEndpoint.currentInflight).toBe(0)
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('propagates call cancellation to the remote handler', async () => {
    const { left, right } = peers()
    const entered = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    right.handleCalls(async (_operation, _body, signal) => {
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelled.resolve(undefined)
          if (!(signal.reason instanceof Error)) throw new Error('test fixture expected an Error abort reason')
          reject(signal.reason)
        }, { once: true })
      })
      return { value: {} }
    })
    const abort = new AbortController()
    const call = left.call('process-wait', { processId: 'p' }, abort.signal)
    await entered.promise
    abort.abort(new Error('caller stopped waiting'))
    await expect(call).rejects.toThrow('caller stopped waiting')
    await cancelled.promise
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('turns malformed matching frames into logical peer failure without consuming other namespaces', async () => {
    const { left, right, leftEndpoint } = peers()
    const other = vi.fn()
    leftEndpoint.onMessage(other)
    leftEndpoint.inject({ namespace: 'desktop.connection', type: 'event' })
    expect(other).toHaveBeenCalledOnce()
    const closed = Promise.withResolvers<Error>()
    left.onClosed((error) => { closed.resolve(error) })
    leftEndpoint.inject({
      namespace: GUARDIAN_PROTOCOL_NAMESPACE,
      version: GUARDIAN_PROTOCOL_VERSION,
      type: 'chunk',
      streamId: 'unknown',
      sequence: 0,
      data: Buffer.from('x'),
    })
    await expect(closed.promise).resolves.toMatchObject({ name: 'GuardianProtocolError' })
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('rejects pending work on disconnect and waits for asynchronous sink cleanup', async () => {
    const { left, right, leftEndpoint } = peers()
    const streamId = GuardianStreamId('cleanup')
    const release = Promise.withResolvers<undefined>()
    const failed = vi.fn(async () => { await release.promise })
    const complete = left.acceptStream(streamId, { write: () => {}, end: () => {}, fail: failed })
    const closed = left.dispose(new Error('parent disconnected'))
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    let settled = false
    void closed.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve(undefined)
    await closed
    await expect(complete).rejects.toThrow('parent disconnected')
    leftEndpoint.disconnect()
    await right.dispose()
  })
})
