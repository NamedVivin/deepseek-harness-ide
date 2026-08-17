import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DesktopBodyId } from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { parseDesktopBodyFrame } from '@deepseek-ai/dsh-client-connection-desktop/wire'
import {
  createDesktopJsonGuardianEndpoint,
  createDesktopJsonMainEndpoint,
  DESKTOP_PARENT_IPC_SERIALIZATION,
  DesktopParentIpcCodec,
} from '../src/parent-ipc.ts'
import { DESKTOP_SIDECAR_IPC_SERIALIZATION } from '../src/guardian.ts'
import { parseDesktopGuardianControlOutboundFrame } from '../src/guardian-control.ts'
import { parseDesktopRuntimeInboundFrame } from '../src/runtime-protocol.ts'

class FakeIpcTarget extends EventEmitter {
  connected = true
  readonly sent: unknown[] = []
  callbackError: Error | null = null

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(this.callbackError)
    return true
  }
}

function chunk(bytes: readonly number[] = [0, 127, 128, 255]): {
  readonly version: 1
  readonly type: 'body-chunk'
  readonly bodyId: ReturnType<typeof DesktopBodyId>
  readonly sequence: number
  readonly chunk: Uint8Array
} {
  return {
    version: 1,
    type: 'body-chunk',
    bodyId: DesktopBodyId('body-1'),
    sequence: 3,
    chunk: new Uint8Array(bytes),
  }
}

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('record required')
  return value as Record<string, unknown>
}

function decodedBytes(value: unknown): number[] {
  const frame = parseDesktopBodyFrame(value)
  if (frame?.type !== 'body-chunk') throw new Error('decoded body chunk required')
  return [...frame.chunk]
}

describe('Electron-to-guardian JSON IPC codec', () => {
  it('validates its bound and leaves every non-binary protocol value unchanged', () => {
    expect(DESKTOP_PARENT_IPC_SERIALIZATION).toBe('json')
    expect(DESKTOP_SIDECAR_IPC_SERIALIZATION).toBe('advanced')
    expect(() => new DesktopParentIpcCodec(Number.NaN)).toThrow('positive safe integer')
    expect(() => new DesktopParentIpcCodec(0)).toThrow('positive safe integer')
    const codec = new DesktopParentIpcCodec(8)
    const lifecycle = { version: 1, type: 'desktop-runtime-dispose', reason: 'app-quit' }
    const ownership = {
      namespace: 'dsh.guardian.mirror',
      version: 1,
      type: 'sidecar-started',
      sidecarPid: 42,
    }
    const bodyStart = { version: 1, type: 'body-start', bodyId: 'body-1', byteLength: 4 }
    expect(codec.encode(lifecycle)).toBe(lifecycle)
    expect(codec.decode(lifecycle)).toBe(lifecycle)
    expect(parseDesktopRuntimeInboundFrame(jsonRoundTrip(codec.encode(lifecycle)))).toEqual(lifecycle)
    expect(parseDesktopGuardianControlOutboundFrame(jsonRoundTrip(codec.encode(ownership)))).toEqual(ownership)
    expect(codec.encode(bodyStart)).toBe(bodyStart)
    expect(codec.decode(null)).toBeNull()
    expect(codec.decode([])).toEqual([])
  })

  it('round-trips arbitrary bytes through an ordinary JSON serialization', () => {
    const codec = new DesktopParentIpcCodec(8)
    const source = chunk()
    const encoded = record(codec.encode(source))
    expect(encoded).toMatchObject({
      namespace: 'dsh.desktop.parent-binary',
      version: 1,
      type: 'body-chunk',
      bodyId: source.bodyId,
      sequence: source.sequence,
      byteLength: source.chunk.byteLength,
    })
    expect(encoded).not.toHaveProperty('chunk')
    expect(decodedBytes(codec.decode(jsonRoundTrip(encoded)))).toEqual([...source.chunk])
    expect(() => codec.encode(chunk([]))).toThrow('invalid byte length')
    expect(() => codec.encode(chunk(new Array(9).fill(1) as number[]))).toThrow('invalid byte length')
  })

  it('rejects malformed, oversized, and non-canonical binary envelopes', () => {
    const codec = new DesktopParentIpcCodec(8)
    const valid = record(codec.encode(chunk([255])))
    const withoutData = { ...valid }
    delete withoutData.data
    for (const value of [
      { ...valid, extra: true },
      withoutData,
      { ...valid, version: 2 },
      { ...valid, type: 'other' },
    ]) {
      expect(() => codec.decode(value)).toThrow('malformed binary envelope')
    }
    for (const value of [
      { ...valid, bodyId: '' },
      { ...valid, bodyId: 1 },
      { ...valid, sequence: -1 },
      { ...valid, sequence: '0' },
      { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => codec.decode(value)).toThrow('invalid correlation fields')
    }
    for (const value of [
      { ...valid, byteLength: 0 },
      { ...valid, byteLength: 9 },
      { ...valid, byteLength: '1' },
      { ...valid, byteLength: Number.NaN },
      { ...valid, byteLength: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => codec.decode(value)).toThrow('configured byte limit')
    }
    for (const value of [
      { ...valid, data: 1 },
      { ...valid, data: '/w=' },
      { ...valid, data: '*w==' },
    ]) {
      expect(() => codec.decode(value)).toThrow('invalid base64 data')
    }
    expect(() => codec.decode({ ...valid, data: 'AAAA' })).toThrow('non-canonical base64 data')
    expect(() => codec.decode({ ...valid, data: '/x==' })).toThrow('non-canonical base64 data')
  })

  it('adapts Electron main messages in both directions and removes listeners', () => {
    const missing = new FakeIpcTarget()
    Object.defineProperty(missing, 'send', { configurable: true, value: undefined })
    expect(() => createDesktopJsonMainEndpoint(missing as never, 8)).toThrow('disconnected')
    const disconnected = new FakeIpcTarget()
    disconnected.connected = false
    expect(() => createDesktopJsonMainEndpoint(disconnected as never, 8)).toThrow('disconnected')

    const target = new FakeIpcTarget()
    const endpoint = createDesktopJsonMainEndpoint(target, 8)
    endpoint.send(chunk([1, 2, 3]))
    const physical = target.sent.at(-1)
    const received = vi.fn()
    const removeMessage = endpoint.onMessage(received)
    target.emit('message', jsonRoundTrip(physical))
    expect(decodedBytes(received.mock.calls[0]?.[0])).toEqual([1, 2, 3])
    removeMessage()
    target.emit('message', jsonRoundTrip(physical))
    expect(received).toHaveBeenCalledTimes(1)

    const lost = vi.fn()
    const removeDisconnect = endpoint.onDisconnect(lost)
    target.emit('disconnect')
    expect(lost).toHaveBeenCalledOnce()
    removeDisconnect()
    target.emit('disconnect')
    expect(lost).toHaveBeenCalledOnce()

    target.connected = false
    expect(() => { endpoint.send(chunk([1])) }).toThrow('disconnected')
    target.connected = true
    Object.defineProperty(target, 'send', { configurable: true, value: undefined })
    expect(() => { endpoint.send(chunk([1])) }).toThrow('disconnected')
  })

  it('adapts the guardian relay while preserving JSON control values', async () => {
    const target = new FakeIpcTarget()
    const endpoint = createDesktopJsonGuardianEndpoint(target, 8)
    await endpoint.send(chunk([9, 8]))
    const physical = target.sent.at(-1)
    const received = vi.fn()
    const removeMessage = endpoint.onMessage(received)
    target.emit('message', jsonRoundTrip(physical))
    expect(decodedBytes(received.mock.calls[0]?.[0])).toEqual([9, 8])
    removeMessage()

    const control = { version: 1, type: 'desktop-runtime-dispose', reason: 'startup-abort' }
    await endpoint.send(control)
    expect(target.sent.at(-1)).toBe(control)

    const lost = vi.fn()
    const removeDisconnect = endpoint.onDisconnect(lost)
    target.emit('disconnect')
    expect(lost).toHaveBeenCalledOnce()
    removeDisconnect()

    target.callbackError = new Error('send failed')
    await expect(endpoint.send(control)).rejects.toThrow('send failed')
  })
})
