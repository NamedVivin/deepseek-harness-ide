import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { bridge } from '../src/http-bridge.ts'

describe('HTTP bridge abort', () => {
  it('destroys a declared-oversize request instead of draining it', async () => {
    const destroyed: true[] = []
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, 1000)
    // The socket must not stay parked draining a body the client can trickle
    // at will after the rejection — same discipline as the chunked overrun.
    expect(status).toBe(413)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toHaveLength(1)
  })

  it('aborts a pending native picker request when the browser disconnects', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'picker-1', method: 'host.pickDirectory', payload: {},
    })
    const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/host.pickDirectory',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end() { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let carrierSignal: AbortSignal | undefined
    const pending = bridge(request, response, {
      fetch: async (input) => {
        const fetchRequest = input
        carrierSignal = fetchRequest.signal
        resolveStarted()
        if (!fetchRequest.signal.aborted) {
          await new Promise<void>((resolve) => {
            fetchRequest.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        return Response.json({ aborted: fetchRequest.signal.aborted })
      },
    }, Number.MAX_SAFE_INTEGER)
    await started
    response.emit('close')
    await pending
    expect(carrierSignal?.aborted).toBe(true)
  })

  it('rejects a chunked body as soon as its aggregate bytes cross the cap', async () => {
    const request = Readable.from([Buffer.from('1234'), Buffer.from('5678')]) as unknown as IncomingMessage
    const destroy = vi.fn()
    Object.assign(request, {
      url: '/rpc/echo',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      destroy,
    })
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      status: 0,
      writeHead(this: { status: number }, status: number) { this.status = status; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('an oversized stream must not reach dispatch') },
    }, 7)

    expect((response as unknown as { status: number }).status).toBe(413)
    expect(destroy).toHaveBeenCalled()
  })

  it('ends a bodyless upstream response without attempting a write', async () => {
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, { url: '/rpc/empty', method: 'GET', headers: {} })
    const write = vi.fn(() => true)
    const end = vi.fn()
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write,
      end,
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    })

    expect(write).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledOnce()
  })

  it('waits for drain under backpressure and removes both wake listeners', async () => {
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, { url: '/rpc/stream', method: 'GET', headers: {} })
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writes: 0,
      writeHead() { return this },
      write(this: { writes: number }) { this.writes += 1; return false },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    const pending = bridge(request, response, {
      fetch: () => Promise.resolve(new Response('streamed')),
    })
    await vi.waitFor(() => { expect(response.listenerCount('drain')).toBe(1) })
    response.emit('drain')
    await pending

    expect((response as unknown as { writes: number }).writes).toBe(1)
    expect(response.listenerCount('drain')).toBe(0)
    // The bridge's long-lived disconnect observer remains; only the bounded
    // backpressure waiter is withdrawn after either wake event.
    expect(response.listenerCount('close')).toBe(1)
  })
})
