import { Context } from '@deepseek-ai/cordis'
import { RpcId, type ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopConnectionRpc,
  DesktopApiClient,
} from '../src/client/desktop-api-client.ts'
import {
  apply,
  DesktopClientConnectionTransport,
} from '../src/client/index.ts'
import type {
  DesktopRendererBridge,
  DesktopRendererInvocation,
  DesktopRendererInvocationResult,
} from '../src/protocol.ts'

class ExposedDesktopApiClient extends DesktopApiClient {
  fetchAt(path: string, init?: RequestInit): Promise<Response> {
    return this.doFetch(new URL(path, 'http://desktop.test'), init)
  }

  mux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<unknown> {
    return this.openMux({}, signal, onOpen)
  }

  hostStream(signal: AbortSignal, onOpen?: () => void): AsyncIterable<unknown> {
    return this.openHost({}, signal, onOpen)
  }
}

function serverRequest(stream: 'events.mux' | 'events.host'): ServerRequest {
  return stream === 'events.mux'
    ? {
      type: 'server-request',
      rpcId: RpcId('mux'),
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 0 },
    }
    : {
      type: 'server-request',
      rpcId: RpcId('host'),
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    }
}

function bridgeWith(
  invoke: (invocation: DesktopRendererInvocation, signal?: AbortSignal) => Promise<DesktopRendererInvocationResult>,
): DesktopRendererBridge {
  return {
    invoke,
    async system() {
      return { rev: 'graph', entries: [] }
    },
    subscribe(stream) {
      return {
        async *[Symbol.asyncIterator]() {
          yield serverRequest(stream)
        },
      }
    },
  }
}

function echoBridge(): DesktopRendererBridge {
  return bridgeWith(async invocation => invocation.kind === 'respond'
    ? { kind: 'respond', receipt: { accepted: true } }
    : {
      kind: 'rpc',
      message: {
        type: 'server-response',
        rpcId: invocation.message.rpcId,
        result: { ok: true, value: invocation.message.payload },
      },
    })
}

async function collectOne(source: AsyncIterable<unknown>): Promise<unknown> {
  const iterator = source[Symbol.asyncIterator]()
  return (await iterator.next()).value
}

function setGlobalBridge(bridge?: DesktopRendererBridge): void {
  if (bridge === undefined) {
    Reflect.deleteProperty(globalThis, '__DSH_DESKTOP__')
    return
  }
  Object.defineProperty(globalThis, '__DSH_DESKTOP__', {
    configurable: true,
    value: bridge,
  })
}

describe('desktop API client', () => {
  it('maps valid unary and response requests onto the preload bridge', async () => {
    const invoked: DesktopRendererInvocation[] = []
    const client = new ExposedDesktopApiClient(bridgeWith(async (invocation) => {
      invoked.push(invocation)
      return invocation.kind === 'respond'
        ? { kind: 'respond', receipt: { accepted: true } }
        : {
          kind: 'rpc',
          message: {
            type: 'server-response',
            rpcId: invocation.message.rpcId,
            result: { ok: true, value: {} },
          },
        }
    }))
    const signal = new AbortController().signal
    const request = {
      type: 'client-request',
      rpcId: RpcId('request'),
      method: 'session.list',
      payload: {},
    }
    const rpc = await client.fetchAt('/api/session.list', {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
    })
    expect(await rpc.json()).toMatchObject({ rpcId: 'request' })

    const response = {
      type: 'client-response',
      rpcId: RpcId('response'),
      result: { ok: true, value: {} },
    }
    const receipt = await client.fetchAt('/api/respond', {
      method: 'POST',
      body: JSON.stringify(response),
    })
    expect(await receipt.json()).toEqual({ accepted: true })
    expect(invoked).toEqual([
      { kind: 'rpc', channel: '/api', message: request },
      { kind: 'respond', message: response },
    ])
  })

  it('rejects malformed fetch requests and mismatched bridge results', async () => {
    const rpcMismatch = new ExposedDesktopApiClient(bridgeWith(async () => ({
      kind: 'respond',
      receipt: { accepted: true },
    })))
    expect((await rpcMismatch.fetchAt('/api/session.list')).status).toBe(404)
    expect((await rpcMismatch.fetchAt('/api/session.list', { method: 'POST' })).status).toBe(404)
    expect((await rpcMismatch.fetchAt('/api/session.list', { method: 'POST', body: '{' })).status).toBe(400)
    expect((await rpcMismatch.fetchAt('/other', { method: 'POST', body: '{}' })).status).toBe(404)
    await expect(rpcMismatch.fetchAt('/api/session.list', {
      method: 'POST',
      body: JSON.stringify({
        type: 'client-request',
        rpcId: RpcId('rpc'),
        method: 'session.list',
        payload: {},
      }),
    })).rejects.toThrow('mismatched RPC result')

    const responseMismatch = new ExposedDesktopApiClient(bridgeWith(async invocation => ({
      kind: 'rpc',
      message: {
        type: 'server-response',
        rpcId: invocation.message.rpcId,
        result: { ok: true, value: {} },
      },
    })))
    await expect(responseMismatch.fetchAt('/api/respond', {
      method: 'POST',
      body: JSON.stringify({
        type: 'client-response',
        rpcId: RpcId('response'),
        result: { ok: true, value: {} },
      }),
    })).rejects.toThrow('mismatched respond result')
  })

  it('validates both downlink families and signals stream establishment', async () => {
    const client = new ExposedDesktopApiClient(echoBridge())
    const opened = vi.fn()
    await expect(collectOne(client.mux(new AbortController().signal, opened))).resolves.toMatchObject({
      rpcId: 'mux',
      payload: { type: 'session/subscribed' },
    })
    await expect(collectOne(client.hostStream(new AbortController().signal))).resolves.toMatchObject({
      rpcId: 'host',
      payload: { type: 'host/remote-event' },
    })
    expect(opened).toHaveBeenCalledOnce()
  })
})

describe('desktop generic RPC', () => {
  it('mints and verifies correlation ids', async () => {
    const rpc = createDesktopConnectionRpc(echoBridge())
    await expect(rpc.call('/api', 'commands/list', { value: 1 })).resolves.toEqual({
      ok: true,
      value: { value: 1 },
    })

    const wrongKind = createDesktopConnectionRpc(bridgeWith(async () => ({
      kind: 'respond',
      receipt: { accepted: true },
    })))
    await expect(wrongKind.call('/api', 'commands/list', {})).rejects.toThrow('mismatched generic RPC result')

    const wrongId = createDesktopConnectionRpc(bridgeWith(async () => ({
      kind: 'rpc',
      message: {
        type: 'server-response',
        rpcId: RpcId('wrong'),
        result: { ok: true, value: {} },
      },
    })))
    await expect(wrongId.call('/api', 'commands/list', {})).rejects.toThrow('rpcId mismatch')
  })

  it.each([
    ['api', 'commands/list'],
    ['/api', ''],
    ['/api', '.'],
    ['/api', '..'],
    ['/api', 'commands/with space'],
  ])('rejects invalid target %s/%s', async (channel, endpoint) => {
    const rpc = createDesktopConnectionRpc(echoBridge())
    await expect(rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
  })
})

describe('desktop Client provider', () => {
  it('accepts an explicit bridge and the preload global', async () => {
    const explicitContext = new Context()
    const explicit = new DesktopClientConnectionTransport(explicitContext, echoBridge())
    expect(explicit.isLoopback).toBe(true)
    expect(explicit.api).toBeInstanceOf(DesktopApiClient)
    expect(explicit.rpc).toBeDefined()
    await explicitContext.fiber.dispose()

    setGlobalBridge(echoBridge())
    const globalContext = new Context()
    try {
      const transport = new DesktopClientConnectionTransport(globalContext)
      expect(transport.api).toBeInstanceOf(DesktopApiClient)
    } finally {
      setGlobalBridge()
      await globalContext.fiber.dispose()
    }
  })

  it('fails without preload and applies the global provider', async () => {
    setGlobalBridge()
    const missingContext = new Context()
    expect(() => new DesktopClientConnectionTransport(missingContext)).toThrow('preload bridge is unavailable')
    await missingContext.fiber.dispose()

    setGlobalBridge(echoBridge())
    const appliedContext = new Context()
    try {
      apply(appliedContext)
      expect(appliedContext.get('connectionTransport')).toBeInstanceOf(DesktopClientConnectionTransport)
    } finally {
      setGlobalBridge()
      await appliedContext.fiber.dispose()
    }
  })
})
