import { describe, expect, it } from 'vitest'
import {
  GUARDIAN_PROTOCOL_NAMESPACE,
  GUARDIAN_PROTOCOL_VERSION,
  GuardianCallId,
  GuardianProcessId,
  GuardianProtocolError,
  GuardianStreamId,
  parseGuardianFrame,
  validateGuardianProtocolLimits,
} from '../src/protocol.ts'

const limits = { maxBodyBytes: 16, maxChunkBytes: 4, maxInflightBytes: 8 }
const base = { namespace: GUARDIAN_PROTOCOL_NAMESPACE, version: GUARDIAN_PROTOCOL_VERSION }

describe('guardian protocol validation', () => {
  it('validates startup limits and the chunk-to-credit capacity relation', () => {
    expect(validateGuardianProtocolLimits(limits)).toBe(limits)
    expect(() => validateGuardianProtocolLimits({ ...limits, maxBodyBytes: 0 })).toThrow('positive safe integer')
    expect(() => validateGuardianProtocolLimits({ ...limits, maxChunkBytes: 9 })).toThrow('must not exceed')
  })

  it('ignores unrelated shared-channel messages and parses every frame family', () => {
    expect(parseGuardianFrame({ namespace: 'another.protocol' }, limits)).toBeUndefined()
    expect(parseGuardianFrame({
      ...base, type: 'call', callId: 'c', operation: 'spawn-prepare', bodyStreamId: 'b', bodyBytes: 2,
    }, limits)).toMatchObject({ callId: GuardianCallId('c'), bodyStreamId: GuardianStreamId('b') })
    expect(parseGuardianFrame({ ...base, type: 'call-cancel', callId: 'c' }, limits)?.type).toBe('call-cancel')
    expect(parseGuardianFrame({
      ...base, type: 'result', callId: 'c', bodyStreamId: 'r', bodyBytes: 2,
    }, limits)?.type).toBe('result')
    expect(parseGuardianFrame({
      ...base, type: 'failure', callId: 'c', error: { code: 'internal', message: 'failed' },
    }, limits)?.type).toBe('failure')
    expect(parseGuardianFrame({
      ...base, type: 'chunk', streamId: 's', sequence: 0, data: Buffer.from('abc'),
    }, limits)).toMatchObject({ streamId: GuardianStreamId('s'), sequence: 0, data: Buffer.from('abc') })
    expect(parseGuardianFrame({ ...base, type: 'ack', streamId: 's', sequence: 0, bytes: 3 }, limits)?.type).toBe('ack')
    expect(parseGuardianFrame({ ...base, type: 'end', streamId: 's', sequence: 1 }, limits)?.type).toBe('end')
    expect(parseGuardianFrame({
      ...base, type: 'stream-cancel', streamId: 's', error: { code: 'aborted', message: 'stop' },
    }, limits)?.type).toBe('stream-cancel')
    expect(parseGuardianFrame({
      ...base,
      type: 'process-settled',
      processId: 'p',
      settlement: { ok: true, outcome: { exitCode: 0, signal: null } },
    }, limits)).toMatchObject({ processId: GuardianProcessId('p') })
    expect(parseGuardianFrame({
      ...base,
      type: 'process-settled',
      processId: 'p',
      settlement: { ok: true, outcome: { exitCode: null, signal: 'SIGTERM' } },
    }, limits)).toMatchObject({ settlement: { ok: true, outcome: { signal: 'SIGTERM' } } })
    expect(parseGuardianFrame({
      ...base,
      type: 'process-settled',
      processId: 'p',
      settlement: { ok: false, error: { code: 'internal', message: 'child failed' } },
    }, limits)).toMatchObject({ settlement: { ok: false, error: { code: 'internal' } } })
  })

  it.each([
    [{ ...base, type: 'call', callId: '', operation: 'spawn-prepare', bodyStreamId: 'b', bodyBytes: 2 }],
    [{ ...base, type: 'call', callId: 'c', operation: 'unknown', bodyStreamId: 'b', bodyBytes: 2 }],
    [{ ...base, type: 'call', callId: 'c', operation: 'spawn-prepare', bodyStreamId: 'b', bodyBytes: 17 }],
    [{ ...base, type: 'chunk', streamId: 's', sequence: 0, data: Buffer.alloc(5) }],
    [{ ...base, type: 'chunk', streamId: 's', sequence: -1, data: Buffer.alloc(1) }],
    [{ ...base, type: 'ack', streamId: 's', sequence: 0, bytes: 0 }],
    [{ ...base, type: 'failure', callId: 'c', error: { code: 'wat', message: 'failed' } }],
    [{ ...base, type: 'process-settled', processId: 'p', settlement: null }],
    [{ ...base, type: 'process-settled', processId: 'p', settlement: { ok: true, outcome: null } }],
    [{ ...base, type: 'process-settled', processId: 'p', settlement: { ok: true, outcome: {} } }],
    [{ ...base, type: 'mystery' }],
    [{ namespace: GUARDIAN_PROTOCOL_NAMESPACE, version: 2, type: 'end' }],
  ])('rejects malformed matching frames %#', (value) => {
    expect(() => parseGuardianFrame(value, limits)).toThrow(GuardianProtocolError)
  })
})
