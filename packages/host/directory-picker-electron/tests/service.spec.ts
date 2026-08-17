import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import ElectronDirectoryPicker from '../src/index.ts'

describe('ElectronDirectoryPicker', () => {
  it('uses the Host-initiated bridge and keeps one stable native capability', async () => {
    const request = vi.fn(async () => ({ path: '/projects/desktop' }))
    const ctx = new Context()
    ctx.provide('desktopHostBridge', { request } as never)
    const fiber = ctx.plugin(ElectronDirectoryPicker)
    await fiber.await()

    const capability = ctx.directoryPicker.capability()
    expect(capability.kind).toBe('native')
    expect(ctx.directoryPicker.capability()).toBe(capability)
    if (capability.kind !== 'native') throw new Error('expected native capability')
    const controller = new AbortController()
    await expect(capability.pick(controller.signal)).resolves.toBe('/projects/desktop')
    expect(request).toHaveBeenCalledWith('directory.pick', {}, controller.signal)

    await fiber.dispose()
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })

  it('discards a chooser result when cancellation wins the return race', async () => {
    const controller = new AbortController()
    const ctx = new Context()
    ctx.provide('desktopHostBridge', {
      request: vi.fn(async () => {
        controller.abort(new Error('registration call closed'))
        return { path: '/projects/late' }
      }),
    } as never)
    await ctx.plugin(ElectronDirectoryPicker)
    const capability = ctx.directoryPicker.capability()
    if (capability.kind !== 'native') throw new Error('expected native capability')

    await expect(capability.pick(controller.signal)).rejects.toThrow('registration call closed')
    await ctx.fiber.dispose()
  })
})
