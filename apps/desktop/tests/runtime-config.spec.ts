import { describe, expect, it } from 'vitest'
import { parseDesktopRuntimeConfig } from '../src/runtime-config.ts'

describe('desktop runtime config', () => {
  const limits = {
    maxDesktopBodyBytes: 160 * 1024 * 1024,
    maxDesktopChunkBytes: 1024 * 1024,
    maxDesktopInflightBytes: 16 * 1024 * 1024,
  }
  const valid = {
    version: 1,
    startupTimeoutMs: 30_000,
    gracefulShutdownMs: 10_000,
    forceShutdownMs: 5_000,
    squirrelTimeoutMs: 30_000,
    nativeProcessPollMs: 100,
    mirrorTimeoutMs: 5_000,
    ...limits,
  }

  it('accepts bounded signed timeout values', () => {
    expect(parseDesktopRuntimeConfig(valid)).toMatchObject({
      startupTimeoutMs: 30_000,
      forceShutdownMs: 5_000,
      nativeProcessPollMs: 100,
      mirrorTimeoutMs: 5_000,
      ...limits,
    })
  })

  it.each([
    [{ ...valid, version: 2 }, /version/u],
    [{ ...valid, startupTimeoutMs: 99 }, /startupTimeoutMs/u],
    [{ ...valid, typo: true }, /unknown/u],
    [{ ...valid, nativeProcessPollMs: 99 }, /nativeProcessPollMs/u],
    [{ ...valid, maxDesktopBodyBytes: 0 }, /maxDesktopBodyBytes/u],
    [{ ...valid, maxDesktopChunkBytes: 20 * 1024 * 1024 }, /cannot exceed maxDesktopInflightBytes/u],
    [{ ...valid, maxDesktopInflightBytes: 200 * 1024 * 1024 }, /cannot exceed maxDesktopBodyBytes/u],
  ])('rejects malformed lifecycle configuration', (value, error) => {
    expect(() => parseDesktopRuntimeConfig(value)).toThrow(error)
  })
})
