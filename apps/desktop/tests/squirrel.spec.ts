import { describe, expect, it, vi } from 'vitest'
import { parseSquirrelLifecycle, runSquirrelLifecycle } from '../src/squirrel.ts'

describe('Squirrel lifecycle parsing', () => {
  it.each([
    ['--squirrel-install', 'install'],
    ['--squirrel-updated', 'updated'],
    ['--squirrel-uninstall', 'uninstall'],
    ['--squirrel-obsolete', 'obsolete'],
  ] as const)('recognizes %s before desktop startup', (argument, expected) => {
    expect(parseSquirrelLifecycle(['DeepSeek Harness.exe', argument, '1.2.3'])).toBe(expected)
  })

  it('leaves ordinary launches alone and rejects ambiguous lifecycle work', () => {
    expect(parseSquirrelLifecycle(['DeepSeek Harness.exe'])).toBeUndefined()
    expect(() => parseSquirrelLifecycle([
      'DeepSeek Harness.exe',
      '--squirrel-install',
      '--squirrel-uninstall',
    ])).toThrow('multiple Squirrel lifecycle events')
  })

  it.each([
    ['install', '--createShortcut'],
    ['updated', '--createShortcut'],
    ['uninstall', '--removeShortcut'],
  ] as const)('runs only the %s updater action', async (event, action) => {
    const run = vi.fn(() => Promise.resolve())
    await runSquirrelLifecycle(event, 'C:\\Users\\me\\AppData\\Local\\Dsh\\app-1.0.0\\dsh.exe', 5_000, run)
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/Update\.exe$/u),
      [action, expect.stringMatching(/dsh\.exe$/u)],
      5_000,
    )
  })

  it('does no process work for obsolete versions', async () => {
    const run = vi.fn(() => Promise.resolve())
    await runSquirrelLifecycle('obsolete', 'dsh.exe', 5_000, run)
    expect(run).not.toHaveBeenCalled()
  })
})
