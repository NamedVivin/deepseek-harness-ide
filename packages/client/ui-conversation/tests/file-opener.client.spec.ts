import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ClientFileOpener } from '../src/client/file-opener.ts'

const sessionId = 'session-1' as SessionId

describe('ClientFileOpener', () => {
  it('offers complete locations in order and retracts a contribution with its fiber', async () => {
    const ctx = new Context()
    const opener = new ClientFileOpener(ctx)
    const first = vi.fn(async () => 'unhandled' as const)
    const second = vi.fn(async () => 'handled' as const)
    const afterClaim = vi.fn(async () => 'handled' as const)

    const fiber = ctx.plugin({
      inject: ['fileOpener'],
      apply(scope: Context) {
        scope.fileOpener.register(first)
        scope.fileOpener.register(second)
        scope.fileOpener.register(afterClaim)
      },
    })
    await fiber.await()

    const request = { sessionId, location: { path: 'src/a.ts', line: 17 } }
    await expect(opener.tryOpen(request)).resolves.toBe('handled')
    expect(first).toHaveBeenCalledWith(request)
    expect(second).toHaveBeenCalledWith(request)
    expect(afterClaim).not.toHaveBeenCalled()

    await fiber.dispose()
    await expect(opener.tryOpen(request)).resolves.toBe('unhandled')
  })

  it('propagates a handler failure without offering the location to later handlers', async () => {
    const ctx = new Context()
    const opener = new ClientFileOpener(ctx)
    const failure = new Error('editor unavailable')
    opener.register(async () => { throw failure })
    const later = vi.fn(async () => 'handled' as const)
    opener.register(later)

    await expect(opener.tryOpen({ sessionId, location: { path: 'notes.md' } })).rejects.toBe(failure)
    expect(later).not.toHaveBeenCalled()
  })
})
