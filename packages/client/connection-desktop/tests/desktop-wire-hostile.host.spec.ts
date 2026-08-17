import { describe, expect, it, vi } from 'vitest'
import {
  DesktopBodyId,
  DesktopBodyLimitError,
  DesktopBodyTransport,
  DesktopProtocolError,
  parseDesktopBodyFrame,
  resolveDesktopIpcLimits,
  type DesktopBodyFrame,
  type DesktopIpcLimits,
} from '../src/index.ts'

const LIMITS: DesktopIpcLimits = {
  maxDesktopBodyBytes: 64,
  maxDesktopChunkBytes: 8,
  maxDesktopInflightBytes: 8,
}

function bodyTransport(
  sent: DesktopBodyFrame[] = [],
  limits: DesktopIpcLimits = LIMITS,
  intercept?: (frame: DesktopBodyFrame) => void,
): DesktopBodyTransport {
  return new DesktopBodyTransport((frame) => {
    sent.push(frame)
    intercept?.(frame)
  }, limits)
}

function bodyIdFrom(sent: readonly DesktopBodyFrame[]): ReturnType<typeof DesktopBodyId> {
  const start = sent.find(frame => frame.type === 'body-start')
  if (start?.type !== 'body-start') throw new Error('body-start was not sent')
  return start.bodyId
}

async function waitForChunk(sent: readonly DesktopBodyFrame[]): Promise<void> {
  await vi.waitFor(() => { expect(sent.some(frame => frame.type === 'body-chunk')).toBe(true) })
}

describe('desktop body limits', () => {
  it('resolves immutable defaults and rejects invalid limits', () => {
    const defaults = resolveDesktopIpcLimits()
    expect(Object.isFrozen(defaults)).toBe(true)
    expect(defaults.maxDesktopBodyBytes).toBeGreaterThan(0)
    for (const value of [Number.NaN, 0]) {
      expect(() => resolveDesktopIpcLimits({ maxDesktopBodyBytes: value })).toThrow('positive safe integer')
    }
    expect(() => resolveDesktopIpcLimits({
      maxDesktopBodyBytes: 10,
      maxDesktopChunkBytes: 5,
      maxDesktopInflightBytes: 4,
    })).toThrow('must not exceed')
  })
})

describe('desktop body receive protocol', () => {
  it('assembles one body, acknowledges copied chunks, and consumes it once', () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent)
    const bodyId = DesktopBodyId('complete')
    const bytes = new TextEncoder().encode('{"value":1}')
    transport.accept({ version: 1, type: 'body-start', bodyId, byteLength: bytes.byteLength })
    transport.accept({ version: 1, type: 'body-chunk', bodyId, sequence: 0, chunk: bytes.slice(0, 8) })
    transport.accept({ version: 1, type: 'body-chunk', bodyId, sequence: 1, chunk: bytes.slice(8) })
    transport.accept({ version: 1, type: 'body-end', bodyId })
    expect(transport.take(bodyId)).toEqual({ value: 1 })
    expect(() => transport.take(bodyId)).toThrow('incomplete body')
    expect(sent.filter(frame => frame.type === 'body-ack')).toHaveLength(2)
  })

  it('rejects duplicate, unknown, empty, oversized, and over-declared chunks', () => {
    const duplicate = bodyTransport()
    duplicate.accept({ version: 1, type: 'body-start', bodyId: DesktopBodyId('duplicate'), byteLength: 1 })
    expect(() =>{  duplicate.accept({
      version: 1,
      type: 'body-start',
      bodyId: DesktopBodyId('duplicate'),
      byteLength: 1,
    }) }).toThrow('duplicate body')

    const unknown = bodyTransport()
    expect(() =>{  unknown.accept({
      version: 1,
      type: 'body-chunk',
      bodyId: DesktopBodyId('unknown'),
      sequence: 0,
      chunk: new Uint8Array([1]),
    }) }).toThrow('chunk for unknown body')

    for (const chunk of [new Uint8Array(), new Uint8Array(9)]) {
      const invalid = bodyTransport()
      const bodyId = DesktopBodyId(`invalid-${String(chunk.byteLength)}`)
      invalid.accept({ version: 1, type: 'body-start', bodyId, byteLength: chunk.byteLength })
      expect(() =>{  invalid.accept({
        version: 1,
        type: 'body-chunk',
        bodyId,
        sequence: 0,
        chunk,
      }) }).toThrow('invalid byte length')
    }

    const exceeded = bodyTransport()
    const exceededId = DesktopBodyId('exceeded')
    exceeded.accept({ version: 1, type: 'body-start', bodyId: exceededId, byteLength: 1 })
    expect(() =>{  exceeded.accept({
      version: 1,
      type: 'body-chunk',
      bodyId: exceededId,
      sequence: 0,
      chunk: new Uint8Array([1, 2]),
    }) }).toThrow('exceeds its declared byte length')
  })

  it('rejects unknown and incomplete endings plus invalid encodings', () => {
    const unknown = bodyTransport()
    expect(() =>{  unknown.accept({
      version: 1,
      type: 'body-end',
      bodyId: DesktopBodyId('unknown'),
    }) }).toThrow('end for unknown body')

    const incomplete = bodyTransport()
    const incompleteId = DesktopBodyId('incomplete')
    incomplete.accept({ version: 1, type: 'body-start', bodyId: incompleteId, byteLength: 2 })
    incomplete.accept({
      version: 1,
      type: 'body-chunk',
      bodyId: incompleteId,
      sequence: 0,
      chunk: new Uint8Array([1]),
    })
    expect(() =>{  incomplete.accept({ version: 1, type: 'body-end', bodyId: incompleteId }) }).toThrow(
      'ended at 1 of 2',
    )

    for (const [name, bytes, message] of [
      ['utf8', new Uint8Array([0xff]), 'not valid UTF-8'],
      ['json', new TextEncoder().encode('x'), 'not valid JSON'],
    ] as const) {
      const invalid = bodyTransport()
      const bodyId = DesktopBodyId(name)
      invalid.accept({ version: 1, type: 'body-start', bodyId, byteLength: bytes.byteLength })
      invalid.accept({ version: 1, type: 'body-chunk', bodyId, sequence: 0, chunk: bytes })
      expect(() =>{  invalid.accept({ version: 1, type: 'body-end', bodyId }) }).toThrow(message)
    }
  })

  it('forgets receiving and completed values when the peer cancels a body', () => {
    const receiving = bodyTransport()
    const receivingId = DesktopBodyId('receiving')
    receiving.accept({ version: 1, type: 'body-start', bodyId: receivingId, byteLength: 1 })
    receiving.accept({ version: 1, type: 'body-cancel', bodyId: receivingId })
    expect(() =>{  receiving.accept({ version: 1, type: 'body-end', bodyId: receivingId }) }).toThrow(
      'end for unknown body',
    )

    const completed = bodyTransport()
    const completedId = DesktopBodyId('completed')
    const bytes = new TextEncoder().encode('1')
    completed.accept({ version: 1, type: 'body-start', bodyId: completedId, byteLength: 1 })
    completed.accept({ version: 1, type: 'body-chunk', bodyId: completedId, sequence: 0, chunk: bytes })
    completed.accept({ version: 1, type: 'body-end', bodyId: completedId })
    completed.accept({ version: 1, type: 'body-cancel', bodyId: completedId })
    expect(() => completed.take(completedId)).toThrow('incomplete body')
  })
})

describe('desktop body send protocol', () => {
  it('rejects unexpected and length-mismatched acknowledgements', async () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent)
    expect(() =>{  transport.accept({
      version: 1,
      type: 'body-ack',
      bodyId: DesktopBodyId('unknown'),
      sequence: 0,
      byteLength: 1,
    }) }).toThrow('unexpected acknowledgement')

    const sending = transport.send({ value: 1 })
    void sending.catch(() => undefined)
    await waitForChunk(sent)
    const bodyId = bodyIdFrom(sent)
    const chunk = sent.find(frame => frame.type === 'body-chunk')
    if (chunk?.type !== 'body-chunk') throw new Error('body-chunk was not sent')
    expect(() =>{  transport.accept({
      version: 1,
      type: 'body-ack',
      bodyId,
      sequence: 0,
      byteLength: chunk.chunk.byteLength + 1,
    }) }).toThrow('has byte length')
    transport.close(new Error('stop'))
    await expect(sending).rejects.toThrow('stop')
  })

  it('rejects sends cancelled while waiting for credit', async () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent)
    const abort = new AbortController()
    const sending = transport.send({ value: 'more than one chunk' }, abort.signal)
    void sending.catch(() => undefined)
    await waitForChunk(sent)
    abort.abort(new Error('cancelled credit wait'))
    await expect(sending).rejects.toThrow('cancelled credit wait')
    expect(sent.some(frame => frame.type === 'body-cancel')).toBe(true)
    expect(transport.inflightBytes).toBe(0)
  })

  it('rejects a signal aborted before the next credit reservation', async () => {
    const sent: DesktopBodyFrame[] = []
    const abort = new AbortController()
    const transport = bodyTransport(sent, LIMITS, (frame) => {
      if (frame.type === 'body-chunk' && frame.sequence === 0) abort.abort(new Error('between chunks'))
    })
    await expect(transport.send({ value: 'more than one chunk' }, abort.signal)).rejects.toThrow('between chunks')
    expect(sent.some(frame => frame.type === 'body-cancel')).toBe(true)
  })

  it('rejects an acknowledged-credit send when its signal aborts before the peer acknowledgement', async () => {
    const sent: DesktopBodyFrame[] = []
    const abort = new AbortController()
    const transport = bodyTransport(sent)
    const sending = transport.send(null, abort.signal)
    await waitForChunk(sent)
    await Promise.resolve()
    abort.abort(new Error('cancelled acknowledgement wait'))

    await expect(sending).rejects.toThrow('cancelled acknowledgement wait')
    expect(sent.some(frame => frame.type === 'body-cancel')).toBe(true)
    expect(transport.inflightBytes).toBe(0)
  })

  it('releases granted credit when cancellation wins before the send continuation resumes', async () => {
    const sent: DesktopBodyFrame[] = []
    const abort = new AbortController()
    const transport = bodyTransport(sent)
    const sending = transport.send({ value: 1 }, abort.signal)
    abort.abort('cancelled after credit grant')

    await expect(sending).rejects.toThrow('desktop operation aborted')
    expect(sent.map(frame => frame.type)).toEqual(['body-start', 'body-cancel'])
    expect(transport.inflightBytes).toBe(0)
  })

  it('rejects a signal that aborts after the final chunk but before acknowledgement waiting starts', async () => {
    const sent: DesktopBodyFrame[] = []
    const abort = new AbortController()
    const transport = bodyTransport(sent, LIMITS, (frame) => {
      if (frame.type === 'body-end') abort.abort(new Error('cancelled at body end'))
    })

    await expect(transport.send(null, abort.signal)).rejects.toThrow('cancelled at body end')
    expect(transport.inflightBytes).toBe(0)
  })

  it('settles signal-aware acknowledgement waits on acknowledgement and terminal failure', async () => {
    const acknowledgedSignal = new AbortController()
    const acknowledged = bodyTransport([], LIMITS, (frame) => {
      if (frame.type !== 'body-chunk') return
      acknowledged.accept({
        version: 1,
        type: 'body-ack',
        bodyId: frame.bodyId,
        sequence: frame.sequence,
        byteLength: frame.chunk.byteLength,
      })
    })
    await expect(acknowledged.send({ value: 1 }, acknowledgedSignal.signal)).resolves.toBeDefined()
    acknowledgedSignal.abort(new Error('late abort is detached'))

    const failedSignal = new AbortController()
    const failed = bodyTransport()
    const sending = failed.send(null, failedSignal.signal)
    await vi.waitFor(() => { expect(failed.inflightBytes).toBeGreaterThan(0) })
    await Promise.resolve()
    failed.close('acknowledgement transport closed')
    await expect(sending).rejects.toThrow('acknowledgement transport closed')
    expect(failed.inflightBytes).toBe(0)
  })

  it('rejects peer cancellation of pending acknowledgements', async () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent)
    const sending = transport.send({ value: 1 })
    void sending.catch(() => undefined)
    await waitForChunk(sent)
    transport.accept({ version: 1, type: 'body-cancel', bodyId: bodyIdFrom(sent) })
    await expect(sending).rejects.toThrow('peer cancelled body')
  })

  it('leaves unrelated pending bodies intact when one peer body is cancelled', async () => {
    const sent: DesktopBodyFrame[] = []
    const limits = { ...LIMITS, maxDesktopInflightBytes: 128 }
    const transport = bodyTransport(sent, limits)
    const first = transport.send({ first: 'more than one chunk' })
    const second = transport.send({ second: 'more than one chunk' })
    void first.catch(() => undefined)
    void second.catch(() => undefined)
    await vi.waitFor(() => {
      const bodyIds = new Set(sent.filter(frame => frame.type === 'body-chunk').map(frame => frame.bodyId))
      expect(bodyIds.size).toBe(2)
    })
    const starts = sent.filter(frame => frame.type === 'body-start')
    const firstId = starts[0]?.bodyId
    if (firstId === undefined) throw new Error('first body-start was not sent')
    transport.accept({ version: 1, type: 'body-cancel', bodyId: firstId })
    await expect(first).rejects.toThrow('peer cancelled body')
    transport.close(new Error('stop unrelated body'))
    await expect(second).rejects.toThrow('stop unrelated body')
  })

  it('releases pending and queued sends on terminal close', async () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent)
    const first = transport.send({ first: 'fills credit' })
    const second = transport.send({ second: 'waits' })
    void first.catch(() => undefined)
    void second.catch(() => undefined)
    await waitForChunk(sent)
    transport.close('closed')
    transport.close(new Error('ignored'))
    await expect(first).rejects.toThrow('closed')
    await expect(second).rejects.toThrow('closed')
    await expect(transport.send({ late: true })).rejects.toThrow('closed')
    expect(() =>{  transport.accept({
      version: 1,
      type: 'body-cancel',
      bodyId: DesktopBodyId('late'),
    }) }).toThrow('closed')
  })

  it('rejects a send closed after credit resolves but before its continuation registers the acknowledgement', async () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent)
    const sending = transport.send({ value: 1 })
    transport.close(new Error('closed before acknowledgement registration'))

    await expect(sending).rejects.toThrow('closed before acknowledgement registration')
    expect(sent.map(frame => frame.type)).toEqual(['body-start', 'body-cancel'])
    expect(transport.inflightBytes).toBe(0)
  })

  it('cancels a body when physical chunk and cancellation sends fail', async () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent, LIMITS, (frame) => {
      if (frame.type === 'body-chunk' || frame.type === 'body-cancel') throw new Error('physical send failed')
    })
    await expect(transport.send({ value: 1 })).rejects.toThrow('physical send failed')
    expect(transport.inflightBytes).toBe(0)
    expect(sent.some(frame => frame.type === 'body-cancel')).toBe(true)
  })

  it('tolerates an acknowledgement that arrives before a failed send returns', async () => {
    const sent: DesktopBodyFrame[] = []
    const transport = bodyTransport(sent, LIMITS, (frame) => {
      if (frame.type !== 'body-chunk') return
      transport.accept({
        version: 1,
        type: 'body-ack',
        bodyId: frame.bodyId,
        sequence: frame.sequence,
        byteLength: frame.chunk.byteLength,
      })
      throw new Error('send reported failure after delivery')
    })
    await expect(transport.send({ value: 1 })).rejects.toThrow('send reported failure after delivery')
  })

  it('rejects pre-aborted, unserializable, and oversized values', async () => {
    for (const reason of [new Error('pre-aborted'), 'pre-aborted']) {
      const transport = bodyTransport()
      const abort = new AbortController()
      abort.abort(reason)
      await expect(transport.send({}, abort.signal)).rejects.toThrow(
        reason instanceof Error ? 'pre-aborted' : 'desktop operation aborted',
      )
    }
    await expect(bodyTransport().send(undefined)).rejects.toBeInstanceOf(DesktopProtocolError)
    await expect(bodyTransport([], {
      maxDesktopBodyBytes: 1,
      maxDesktopChunkBytes: 1,
      maxDesktopInflightBytes: 1,
    }).send({ value: true })).rejects.toBeInstanceOf(DesktopBodyLimitError)
  })
})

describe('desktop physical frame parser', () => {
  it.each([
    undefined,
    null,
    [],
    { version: 2, type: 'body-start' },
    { version: 1, type: 1 },
    { version: 1, type: 'renderer-invoke' },
  ])('ignores non-body value %#', (value) => {
    expect(parseDesktopBodyFrame(value)).toBeUndefined()
  })

  it.each([
    [{ version: 1, type: 'body-start' }, 'non-empty bodyId'],
    [{ version: 1, type: 'body-start', bodyId: '' }, 'non-empty bodyId'],
    [{ version: 1, type: 'body-start', bodyId: 'x', byteLength: 1, extra: true }, 'body-start'],
    [{ version: 1, type: 'body-start', bodyId: 'x', byteLength: -1 }, 'body-start'],
    [{ version: 1, type: 'body-chunk', bodyId: 'x', sequence: 0, chunk: new Uint8Array(), extra: true }, 'body-chunk'],
    [{ version: 1, type: 'body-chunk', bodyId: 'x', sequence: -1, chunk: new Uint8Array() }, 'body-chunk'],
    [{ version: 1, type: 'body-chunk', bodyId: 'x', sequence: 0, chunk: [] }, 'body-chunk'],
    [{ version: 1, type: 'body-ack', bodyId: 'x', sequence: 0, byteLength: 1, extra: true }, 'body-ack'],
    [{ version: 1, type: 'body-ack', bodyId: 'x', sequence: -1, byteLength: 1 }, 'body-ack'],
    [{ version: 1, type: 'body-ack', bodyId: 'x', sequence: 0, byteLength: -1 }, 'body-ack'],
    [{ version: 1, type: 'body-end', bodyId: 'x', extra: true }, 'body-end'],
    [{ version: 1, type: 'body-cancel', bodyId: 'x', extra: true }, 'body-cancel'],
    [{ version: 1, type: 'body-unknown', bodyId: 'x' }, 'unknown body frame'],
  ])('rejects hostile frame %#', (value, message) => {
    expect(() => parseDesktopBodyFrame(value)).toThrow(message)
  })

  it('parses every body frame variant', () => {
    const bodyId = 'body'
    const frames = [
      { version: 1, type: 'body-start', bodyId, byteLength: 1 },
      { version: 1, type: 'body-chunk', bodyId, sequence: 0, chunk: new Uint8Array([1]) },
      { version: 1, type: 'body-ack', bodyId, sequence: 0, byteLength: 1 },
      { version: 1, type: 'body-end', bodyId },
      { version: 1, type: 'body-cancel', bodyId },
    ]
    for (const frame of frames) expect(parseDesktopBodyFrame(frame)).toMatchObject(frame)
  })
})
