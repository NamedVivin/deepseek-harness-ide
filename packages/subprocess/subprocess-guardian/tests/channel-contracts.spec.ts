import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createNodeGuardianEndpoint,
  FramedGuardianPeer,
  type GuardianByteSink,
  type GuardianMessageEndpoint,
  type NodeGuardianIpcProcess,
} from '../src/channel.ts'
import {
  GUARDIAN_ACTIVE_STREAM_LIMIT,
  GUARDIAN_PROTOCOL_NAMESPACE,
  GUARDIAN_PROTOCOL_VERSION,
  GuardianCallId,
  GuardianProcessId,
  GuardianStreamId,
  type GuardianFrame,
  type GuardianStreamId as GuardianStreamIdType,
} from '../src/protocol.ts'

const limits = { maxBodyBytes: 64, maxChunkBytes: 3, maxInflightBytes: 6 }
const base = { namespace: GUARDIAN_PROTOCOL_NAMESPACE, version: GUARDIAN_PROTOCOL_VERSION }

class ControlledEndpoint implements GuardianMessageEndpoint {
  readonly messages = new Set<(value: unknown) => void>()
  readonly disconnects = new Set<() => void>()
  readonly sent: GuardianFrame[] = []
  sendImpl: (frame: GuardianFrame) => Promise<void> = async () => undefined

  async send(frame: GuardianFrame): Promise<void> {
    this.sent.push(frame)
    await this.sendImpl(frame)
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
    for (const listener of this.disconnects) listener()
  }
}

interface PeerInternals {
  incomingStreams: Map<GuardianStreamIdType, { expectedBytes: number | undefined }>
  receive(value: unknown): void
  route(frame: GuardianFrame): void
  addIncomingStream(streamId: GuardianStreamIdType, sink: GuardianByteSink, expected: number | undefined): Promise<void>
  receiveChunk(streamId: GuardianStreamIdType, sequence: number, data: Buffer): void
  receiveEnd(streamId: GuardianStreamIdType, sequence: number): void
  receiveCancel(streamId: GuardianStreamIdType, error: Error): void
  receiveAck(streamId: GuardianStreamIdType, sequence: number, bytes: number): void
  safeSend(frame: GuardianFrame): Promise<void>
  reserveCredit(bytes: number, signal?: AbortSignal): Promise<void>
  track(promise: Promise<void>): void
  shutdown(error: Error): Promise<void>
}

function peer(endpoint = new ControlledEndpoint(), customLimits = limits): {
  readonly endpoint: ControlledEndpoint
  readonly value: FramedGuardianPeer
  readonly internals: PeerInternals
} {
  const value = new FramedGuardianPeer(endpoint, customLimits)
  return { endpoint, value, internals: value as unknown as PeerInternals }
}

function callFrame(callId: string, streamId: string, bodyBytes: number): GuardianFrame {
  return {
    ...base,
    type: 'call',
    callId: GuardianCallId(callId),
    operation: 'resolve-executable',
    bodyStreamId: GuardianStreamId(streamId),
    bodyBytes,
  }
}

function chunkFrame(streamId: string, sequence: number, data: string): GuardianFrame {
  return { ...base, type: 'chunk', streamId: GuardianStreamId(streamId), sequence, data: Buffer.from(data) }
}

function endFrame(streamId: string, sequence: number): GuardianFrame {
  return { ...base, type: 'end', streamId: GuardianStreamId(streamId), sequence }
}

async function turns(count = 8): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

async function acknowledgeOutgoingBody(fixture: ReturnType<typeof peer>): Promise<void> {
  const acknowledged = new Set<string>()
  for (let round = 0; round < 32; round++) {
    await turns(2)
    for (const frame of fixture.endpoint.sent) {
      if (frame.type !== 'chunk') continue
      const key = `${frame.streamId}:${String(frame.sequence)}`
      if (acknowledged.has(key)) continue
      acknowledged.add(key)
      fixture.endpoint.inject({
        ...base,
        type: 'ack',
        streamId: frame.streamId,
        sequence: frame.sequence,
        bytes: frame.data.length,
      })
    }
    if (fixture.endpoint.sent.some(frame => frame.type === 'end')) return
  }
  throw new Error('test fixture did not finish its outgoing request body')
}

describe('Node guardian endpoint failure contract', () => {
  type MutableNodeFace = Omit<NodeGuardianIpcProcess, 'connected' | 'send'> & {
    connected: boolean
    send?: NonNullable<NodeGuardianIpcProcess['send']>
  }

  function nodeFace(send: NodeGuardianIpcProcess['send'] | undefined): MutableNodeFace & EventEmitter {
    const events = new EventEmitter() as unknown as MutableNodeFace & EventEmitter
    events.connected = true
    if (send !== undefined) events.send = send
    return events
  }

  it('settles Node callbacks and catches synchronous send failure', async () => {
    const success = nodeFace((_message, callback) => { callback?.(null); return true })
    const successEndpoint = createNodeGuardianEndpoint(success)
    await expect(successEndpoint.send(endFrame('s', 0))).resolves.toBeUndefined()

    const callbackFailure = nodeFace((_message, callback) => { callback?.(new Error('callback failed')); return false })
    await expect(createNodeGuardianEndpoint(callbackFailure).send(endFrame('s', 0))).rejects.toThrow('callback failed')

    const thrown = nodeFace(() => { throw new Error('send threw') })
    await expect(createNodeGuardianEndpoint(thrown).send(endFrame('s', 0))).rejects.toThrow('send threw')
  })

  it('rejects channels disconnected before construction or before a later send', async () => {
    const absent = nodeFace(undefined)
    expect(() => createNodeGuardianEndpoint(absent)).toThrow('connected Node child IPC')
    const initiallyDisconnected = nodeFace(() => true)
    initiallyDisconnected.connected = false
    expect(() => createNodeGuardianEndpoint(initiallyDisconnected)).toThrow('connected Node child IPC')

    const later = nodeFace((_message, callback) => { callback?.(null); return true })
    const endpoint = createNodeGuardianEndpoint(later)
    later.connected = false
    await expect(endpoint.send(endFrame('s', 0))).rejects.toThrow('disconnected')
    later.connected = true
    delete later.send
    await expect(endpoint.send(endFrame('s', 0))).rejects.toThrow('disconnected')
  })
})

describe('FramedGuardianPeer failure paths', () => {
  it('enforces one handler and makes handler removal conditional', async () => {
    const fixture = peer()
    const handler = async () => ({ value: {} })
    const remove = fixture.value.handleCalls(handler)
    expect(() => fixture.value.handleCalls(handler)).toThrow('already installed')
    remove()
    remove()
    await fixture.value.dispose()
  })

  it('cancels pending calls and handles abort racing a failed physical send', async () => {
    const pending = peer()
    const abort = new AbortController()
    const called = pending.value.call('resolve-executable', { command: 'node' }, abort.signal)
    await acknowledgeOutgoingBody(pending)
    abort.abort('cancelled without Error')
    await expect(called).rejects.toThrow('guardian operation aborted')
    expect(pending.endpoint.sent.some(value => value.type === 'call-cancel')).toBe(true)

    const raced = peer()
    const release = Promise.withResolvers<undefined>()
    raced.endpoint.sendImpl = async (frame) => {
      if (frame.type === 'call') await release.promise
      throw new Error('physical send failed')
    }
    const raceAbort = new AbortController()
    const racing = raced.value.call('resolve-executable', {}, raceAbort.signal)
    raceAbort.abort(new Error('caller left'))
    release.resolve(undefined)
    await expect(racing).rejects.toThrow('caller left')
  })

  it('rejects physical send failure and non-JSON or oversized call bodies', async () => {
    const fixture = peer()
    fixture.endpoint.sendImpl = async () => { throw new Error('send unavailable') }
    await expect(fixture.value.call('resolve-executable', {})).rejects.toThrow('send unavailable')

    const encoding = peer()
    const circular: { self?: unknown } = {}
    circular.self = circular
    await expect(encoding.value.call('resolve-executable', circular)).rejects.toThrow('not JSON serializable')
    await expect(encoding.value.call('resolve-executable', undefined)).rejects.toThrow('not JSON serializable')
    await expect(encoding.value.call('resolve-executable', { value: 'x'.repeat(100) })).rejects.toThrow('exceeds 64 bytes')
    await encoding.value.dispose()
  })

  it('rejects duplicate writers and writer use after end or cancellation', async () => {
    const fixture = peer()
    const id = GuardianStreamId('writer')
    const writer = fixture.value.createWriter(id)
    expect(() => fixture.value.createWriter(id)).toThrow('duplicate outgoing stream')
    await writer.write(Buffer.alloc(0))
    await writer.end()
    await expect(writer.cancel()).resolves.toBeUndefined()
    await expect(writer.write(Buffer.from('x'))).rejects.toThrow('already ended')
    await expect(writer.end()).rejects.toThrow('already ended')

    const cancelledId = GuardianStreamId('cancelled')
    const cancelled = fixture.value.createWriter(cancelledId)
    await cancelled.cancel()
    await cancelled.cancel(new Error('ignored second reason'))
    await expect(cancelled.write(Buffer.from('x'))).rejects.toThrow('cancelled')
    await fixture.value.dispose()
  })

  it('reports closed peers immediately and ignores messages received after closure', async () => {
    const fixture = peer()
    const first = vi.fn(() => { throw new Error('listener failed') })
    const second = vi.fn()
    fixture.value.onClosed(first)
    fixture.value.onClosed(second)
    await fixture.value.dispose(new Error('closed now'))
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    const late = vi.fn()
    const remove = fixture.value.onClosed(late)
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ message: 'closed now' }))
    remove()
    fixture.endpoint.inject({ ...base, type: 'mystery' })
    fixture.internals.receive({ ...base, type: 'mystery' })
    await fixture.internals.shutdown(new Error('second close'))
  })

  it('contains settlement listener failure and routes stream cancellation', async () => {
    const fixture = peer()
    const failed = vi.fn(() => { throw new Error('consumer failed') })
    const observed = vi.fn()
    const removeFailed = fixture.value.onProcessSettled(failed)
    fixture.value.onProcessSettled(observed)
    fixture.endpoint.inject({
      ...base,
      type: 'process-settled',
      processId: GuardianProcessId('p'),
      settlement: { ok: true, outcome: { exitCode: 0, signal: null } },
    })
    expect(observed).toHaveBeenCalledOnce()
    removeFailed()

    const incoming = fixture.value.acceptStream(GuardianStreamId('incoming'), {
      write: () => undefined,
      end: () => undefined,
      fail: () => undefined,
    })
    fixture.endpoint.inject({
      ...base,
      type: 'stream-cancel',
      streamId: GuardianStreamId('incoming'),
      error: { code: 'internal', message: 'sender cancelled' },
    })
    await expect(incoming).rejects.toThrow('sender cancelled')
    await fixture.value.dispose()
  })

  it('rejects duplicate calls, absent handlers, invalid JSON, and declared body length violations', async () => {
    const noHandler = peer()
    noHandler.endpoint.inject(callFrame('no-handler', 'body-1', 2))
    noHandler.endpoint.inject(chunkFrame('body-1', 0, '{}'))
    noHandler.endpoint.inject(endFrame('body-1', 1))
    await vi.waitFor(() => { expect(noHandler.endpoint.sent.some(value => value.type === 'failure')).toBe(true) })

    const duplicate = peer()
    duplicate.value.handleCalls(async () => ({ value: {} }))
    duplicate.endpoint.inject(callFrame('duplicate', 'body-a', 2))
    duplicate.endpoint.inject(callFrame('duplicate', 'body-b', 2))
    await vi.waitFor(() => { expect((duplicate.value as unknown as { closedError?: Error }).closedError).toBeDefined() })

    const invalidJson = peer()
    invalidJson.value.handleCalls(async () => ({ value: {} }))
    invalidJson.endpoint.inject(callFrame('invalid-json', 'body-json', 1))
    invalidJson.endpoint.inject(chunkFrame('body-json', 0, '!'))
    invalidJson.endpoint.inject(endFrame('body-json', 1))
    await vi.waitFor(() => { expect(invalidJson.endpoint.sent.some(value => value.type === 'failure')).toBe(true) })

    const exceeded = peer()
    exceeded.endpoint.inject(callFrame('exceeded', 'body-long', 1))
    exceeded.endpoint.inject(chunkFrame('body-long', 0, '{}'))
    await vi.waitFor(() => { expect((exceeded.value as unknown as { closedError?: Error }).closedError).toBeDefined() })

    const short = peer()
    short.endpoint.inject(callFrame('short', 'body-short', 2))
    short.endpoint.inject(endFrame('body-short', 0))
    await vi.waitFor(() => { expect((short.value as unknown as { closedError?: Error }).closedError).toBeDefined() })
  })

  it('cancels unknown and duplicate results and handles result-stream cancellation races', async () => {
    const unknown = peer()
    unknown.endpoint.inject({
      ...base,
      type: 'result',
      callId: GuardianCallId('unknown'),
      bodyStreamId: GuardianStreamId('unknown-result'),
      bodyBytes: 2,
    })
    await turns()
    expect(unknown.endpoint.sent.some(value => value.type === 'stream-cancel')).toBe(true)

    const duplicate = peer()
    const called = duplicate.value.call('resolve-executable', {})
    await acknowledgeOutgoingBody(duplicate)
    const call = duplicate.endpoint.sent.find(value => value.type === 'call')
    if (call?.type !== 'call') throw new Error('test fixture omitted outgoing call')
    duplicate.endpoint.inject({ ...base, type: 'result', callId: call.callId, bodyStreamId: GuardianStreamId('result-a'), bodyBytes: 2 })
    duplicate.endpoint.inject({ ...base, type: 'result', callId: call.callId, bodyStreamId: GuardianStreamId('result-b'), bodyBytes: 2 })
    duplicate.endpoint.inject({
      ...base,
      type: 'stream-cancel',
      streamId: GuardianStreamId('result-a'),
      error: { code: 'internal', message: 'result failed' },
    })
    await expect(called).rejects.toThrow('result failed')

    const aborted = peer()
    const controller = new AbortController()
    const abortedCall = aborted.value.call('resolve-executable', {}, controller.signal)
    await acknowledgeOutgoingBody(aborted)
    const abortedFrame = aborted.endpoint.sent.find(value => value.type === 'call')
    if (abortedFrame?.type !== 'call') throw new Error('test fixture omitted abortable call')
    aborted.endpoint.inject({
      ...base,
      type: 'result',
      callId: abortedFrame.callId,
      bodyStreamId: GuardianStreamId('aborted-result'),
      bodyBytes: 2,
    })
    controller.abort(new Error('stop result'))
    aborted.endpoint.inject({
      ...base,
      type: 'stream-cancel',
      streamId: GuardianStreamId('aborted-result'),
      error: { code: 'internal', message: 'late result failure' },
    })
    await expect(abortedCall).rejects.toThrow('stop result')
  })

  it('ignores failures for unknown calls and maps malformed internal error names defensively', async () => {
    const fixture = peer()
    fixture.endpoint.inject({
      ...base,
      type: 'failure',
      callId: GuardianCallId('unknown'),
      error: { code: 'internal', message: 'ignored' },
    })
    const malformed = fixture.value.acceptStream(GuardianStreamId('malformed-error'), {
      write: () => undefined,
      end: () => undefined,
      fail: (error) => { expect(error.name).toBe('GuardianError') },
    })
    fixture.internals.route({
      ...base,
      type: 'stream-cancel',
      streamId: GuardianStreamId('malformed-error'),
      error: { code: '-' as never, message: 'malformed' },
    })
    await expect(malformed).rejects.toMatchObject({ name: 'GuardianError' })
    fixture.internals.receiveCancel(GuardianStreamId('none'), new Error('ignored'))
    await fixture.value.dispose()
  })

  it('contains stale abort and late successful-result races after a call has settled', async () => {
    const failed = peer()
    const failedController = new AbortController()
    vi.spyOn(failedController.signal, 'removeEventListener').mockImplementation(() => undefined)
    const failedCall = failed.value.call('resolve-executable', {}, failedController.signal)
    await acknowledgeOutgoingBody(failed)
    const failedFrame = failed.endpoint.sent.find(value => value.type === 'call')
    if (failedFrame?.type !== 'call') throw new Error('test fixture omitted outgoing call')
    failed.endpoint.inject({
      ...base,
      type: 'failure',
      callId: failedFrame.callId,
      error: { code: 'internal', message: 'remote failed first' },
    })
    await expect(failedCall).rejects.toThrow('remote failed first')
    failedController.abort(new Error('late cancellation'))

    const completed = peer()
    const completedController = new AbortController()
    const completedCall = completed.value.call('resolve-executable', {}, completedController.signal)
    await acknowledgeOutgoingBody(completed)
    const completedFrame = completed.endpoint.sent.find(value => value.type === 'call')
    if (completedFrame?.type !== 'call') throw new Error('test fixture omitted outgoing call')
    completed.endpoint.inject({
      ...base,
      type: 'result',
      callId: completedFrame.callId,
      bodyStreamId: GuardianStreamId('late-success'),
      bodyBytes: 2,
    })
    completedController.abort(new Error('caller left'))
    completed.endpoint.inject(chunkFrame('late-success', 0, '{}'))
    await turns()
    completed.endpoint.inject(endFrame('late-success', 1))
    await expect(completedCall).rejects.toThrow('caller left')
    await completed.value.dispose()
  })

  it('retains JSON body length checks when stream metadata is unavailable', async () => {
    const exceeded = peer()
    exceeded.endpoint.inject(callFrame('body-exceeded', 'body-exceeded-stream', 1))
    const exceededState = exceeded.internals.incomingStreams.get(GuardianStreamId('body-exceeded-stream'))
    if (exceededState === undefined) throw new Error('test fixture omitted incoming body stream')
    exceededState.expectedBytes = undefined
    exceeded.endpoint.inject(chunkFrame('body-exceeded-stream', 0, '{}'))
    await vi.waitFor(() => {
      const failure = exceeded.endpoint.sent.find(value => value.type === 'failure')
      expect(failure?.error.message).toContain('exceeded its declared length')
    })

    const short = peer()
    short.endpoint.inject(callFrame('body-short', 'body-short-stream', 2))
    const shortState = short.internals.incomingStreams.get(GuardianStreamId('body-short-stream'))
    if (shortState === undefined) throw new Error('test fixture omitted incoming body stream')
    shortState.expectedBytes = undefined
    short.endpoint.inject(endFrame('body-short-stream', 0))
    await vi.waitFor(() => {
      const failure = short.endpoint.sent.find(value => value.type === 'failure')
      expect(failure?.error.message).toContain('ended before its declared length')
    })
  })

  it('uses a stable fallback for non-Error handler failures without a message', async () => {
    const fixture = peer()
    fixture.value.handleCalls(async () => { throw '' })
    fixture.endpoint.inject(callFrame('empty-error', 'empty-error-body', 2))
    fixture.endpoint.inject(chunkFrame('empty-error-body', 0, '{}'))
    await turns()
    fixture.endpoint.inject(endFrame('empty-error-body', 1))
    await vi.waitFor(() => {
      expect(fixture.endpoint.sent).toContainEqual(expect.objectContaining({
        type: 'failure',
        error: { code: 'internal', message: 'guardian operation failed' },
      }))
    })
  })

  it('enforces incoming stream count, uniqueness, ordering, length, and sink cleanup', async () => {
    const duplicate = peer()
    const id = GuardianStreamId('duplicate')
    void duplicate.value.acceptStream(id, { write: () => undefined, end: () => undefined, fail: () => undefined })
    expect(() => duplicate.value.acceptStream(id, { write: () => undefined, end: () => undefined, fail: () => undefined }))
      .toThrow('duplicate incoming stream')

    const saturated = peer()
    for (let index = 0; index < GUARDIAN_ACTIVE_STREAM_LIMIT; index++) {
      void saturated.value.acceptStream(GuardianStreamId(`s-${String(index)}`), {
        write: () => undefined,
        end: () => undefined,
        fail: () => undefined,
      })
    }
    expect(() => saturated.value.acceptStream(GuardianStreamId('overflow'), {
      write: () => undefined,
      end: () => undefined,
      fail: () => undefined,
    })).toThrow('active incoming stream limit')
    await saturated.value.dispose()

    const ordering = peer()
    void ordering.value.acceptStream(GuardianStreamId('ordered'), { write: () => undefined, end: () => undefined, fail: () => undefined })
    expect(() => { ordering.internals.receiveChunk(GuardianStreamId('missing'), 0, Buffer.from('x')) }).toThrow('unknown stream')
    expect(() => { ordering.internals.receiveChunk(GuardianStreamId('ordered'), 1, Buffer.from('x')) }).toThrow('out-of-order')
    expect(() => { ordering.internals.receiveEnd(GuardianStreamId('missing'), 0) }).toThrow('unknown stream')
    expect(() => { ordering.internals.receiveEnd(GuardianStreamId('ordered'), 1) }).toThrow('invalid terminal')

    const expected = peer()
    const expectedId = GuardianStreamId('expected')
    void expected.internals.addIncomingStream(expectedId, { write: () => undefined, end: () => undefined, fail: () => undefined }, 1)
    expect(() => { expected.internals.receiveChunk(expectedId, 0, Buffer.from('xx')) }).toThrow('exceeded its declared')

    const writeFailure = peer()
    const failed = vi.fn(async () => { throw new Error('sink cleanup failed') })
    const complete = writeFailure.value.acceptStream(GuardianStreamId('write-failure'), {
      write: () => { throw 'sink write failed' },
      end: () => undefined,
      fail: failed,
    })
    writeFailure.internals.receiveChunk(GuardianStreamId('write-failure'), 0, Buffer.from('x'))
    await expect(complete).rejects.toBe('sink write failed')
    expect(failed).toHaveBeenCalledOnce()

    const endFailure = peer()
    const ended = endFailure.value.acceptStream(GuardianStreamId('end-failure'), {
      write: () => undefined,
      end: () => { throw 'sink end failed' },
      fail: () => undefined,
    })
    endFailure.internals.receiveEnd(GuardianStreamId('end-failure'), 0)
    await expect(ended).rejects.toBe('sink end failed')
  })

  it('handles incoming and outgoing stream cancellation success and failure', async () => {
    const fixture = peer()
    const success = fixture.value.acceptStream(GuardianStreamId('cancel-success'), {
      write: () => undefined,
      end: () => undefined,
      fail: () => undefined,
    })
    fixture.internals.receiveCancel(GuardianStreamId('cancel-success'), new Error('cancelled'))
    await expect(success).rejects.toThrow('cancelled')

    const failed = fixture.value.acceptStream(GuardianStreamId('cancel-failure'), {
      write: () => undefined,
      end: () => undefined,
      fail: () => { throw 'sink cancellation failed' },
    })
    fixture.internals.receiveCancel(GuardianStreamId('cancel-failure'), new Error('cancelled'))
    await expect(failed).rejects.toBe('sink cancellation failed')

    const outgoing = fixture.value.createWriter(GuardianStreamId('remote-cancel'))
    const writing = outgoing.write(Buffer.from('abc'))
    await turns()
    fixture.internals.receiveCancel(GuardianStreamId('remote-cancel'), new Error('remote cancelled'))
    await expect(writing).rejects.toThrow('remote cancelled')
    await fixture.value.dispose()
  })

  it('validates acknowledgements and cleans credit after physical chunk-send failure', async () => {
    const fixture = peer()
    expect(() => { fixture.internals.receiveAck(GuardianStreamId('missing'), 0, 1) }).toThrow('invalid acknowledgement')
    const writer = fixture.value.createWriter(GuardianStreamId('ack'))
    const writing = writer.write(Buffer.from('abc'))
    await turns()
    expect(() => { fixture.internals.receiveAck(GuardianStreamId('ack'), 0, 2) }).toThrow('invalid acknowledgement')
    fixture.internals.receiveAck(GuardianStreamId('ack'), 0, 3)
    await writing

    const failed = peer()
    failed.endpoint.sendImpl = async (frame) => {
      if (frame.type === 'chunk') throw new Error('chunk send failed')
    }
    const failedWriter = failed.value.createWriter(GuardianStreamId('failed-send'))
    await expect(failedWriter.write(Buffer.from('abc'))).rejects.toThrow('chunk send failed')
    await failed.value.dispose()

    const raced = peer()
    const chunkEntered = Promise.withResolvers<undefined>()
    const releaseChunk = Promise.withResolvers<undefined>()
    raced.endpoint.sendImpl = async (frame) => {
      if (frame.type !== 'chunk') return
      chunkEntered.resolve(undefined)
      await releaseChunk.promise
      throw new Error('physical chunk failure')
    }
    const racedWriter = raced.value.createWriter(GuardianStreamId('raced-send'))
    const racedWrite = racedWriter.write(Buffer.from('abc'))
    await chunkEntered.promise
    raced.internals.receiveCancel(GuardianStreamId('raced-send'), new Error('remote cancelled first'))
    releaseChunk.resolve(undefined)
    await expect(racedWrite).rejects.toThrow('physical chunk failure')
    await raced.value.dispose()
  })

  it('aborts credit waits and skips unrelated pending acknowledgements during cancellation', async () => {
    const fixture = peer(undefined, { ...limits, maxInflightBytes: 3 })
    const first = fixture.value.createWriter(GuardianStreamId('first'))
    const second = fixture.value.createWriter(GuardianStreamId('second'))
    const firstWrite = first.write(Buffer.from('abc'))
    await turns()
    const controller = new AbortController()
    const secondWrite = second.write(Buffer.from('xyz'), controller.signal)
    await turns()
    controller.abort('credit wait cancelled')
    await expect(secondWrite).rejects.toThrow('guardian operation aborted')
    await first.cancel(new Error('first cancelled'))
    await expect(firstWrite).rejects.toThrow('first cancelled')

    const a = fixture.value.createWriter(GuardianStreamId('a'))
    const b = fixture.value.createWriter(GuardianStreamId('b'))
    const aWrite = a.write(Buffer.from('a'))
    const bWrite = b.write(Buffer.from('b'))
    await turns()
    await a.cancel(new Error('a cancelled'))
    await expect(aWrite).rejects.toThrow('a cancelled')
    fixture.internals.receiveAck(GuardianStreamId('b'), 0, 1)
    await bWrite
    await fixture.value.dispose()
  })

  it('contains safe-send and tracked-work rejection and rejects retained work during shutdown', async () => {
    const fixture = peer()
    fixture.endpoint.sendImpl = async () => { throw new Error('safe send failed') }
    await expect(fixture.internals.safeSend(endFrame('safe', 0))).resolves.toBeUndefined()
    fixture.internals.track(Promise.reject(new Error('tracked rejection')))
    await turns()

    const incoming = fixture.value.acceptStream(GuardianStreamId('shutdown-incoming'), {
      write: () => undefined,
      end: () => undefined,
      fail: () => { throw 'shutdown sink failed' },
    })
    const outgoing = fixture.value.createWriter(GuardianStreamId('shutdown-outgoing'))
    const writing = outgoing.write(Buffer.from('abc'))
    const waiting = fixture.internals.reserveCredit(7)
    await turns()
    await fixture.value.dispose(new Error('shutdown'))
    await expect(incoming).rejects.toBe('shutdown sink failed')
    await expect(writing).rejects.toThrow()
    await expect(waiting).rejects.toThrow('shutdown')
    await expect(fixture.internals.safeSend(endFrame('safe', 0))).resolves.toBeUndefined()
  })
})
