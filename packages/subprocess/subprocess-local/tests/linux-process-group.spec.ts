import { describe, expect, it } from 'vitest'
import { linuxProcessGroupHasLiveMembers } from '../src/linux-process-group.ts'

function stat(pid: number, state: string, processGroupId: number): string {
  const fields = [state, '1', String(processGroupId), String(processGroupId), '0', '-1']
  while (fields.length < 20) fields.push('0')
  return `${pid} (worker) ${fields.join(' ')}`
}

describe('Linux detached process-group liveness', () => {
  it('distinguishes live, zombie-only, absent, and unreadable groups', () => {
    const files = new Map<string, string>([
      ['/proc/1/stat', stat(1, 'Z', 77)],
      ['/proc/2/stat', stat(2, 'X', 77)],
    ])
    const internals = {
      readDir: () => ['self', '3', '1', '2'],
      readFile: (path: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error('unreadable')
        return value
      },
    }
    expect(linuxProcessGroupHasLiveMembers(77, internals)).toBe(false)
    expect(linuxProcessGroupHasLiveMembers(99, internals)).toBeUndefined()
    files.set('/proc/2/stat', stat(2, 'S', 77))
    expect(linuxProcessGroupHasLiveMembers(77, internals)).toBe(true)
    expect(linuxProcessGroupHasLiveMembers(77, { ...internals, readDir: () => { throw new Error('blocked') } }))
      .toBeUndefined()
    expect(linuxProcessGroupHasLiveMembers(77, {
      readDir: () => ['4'],
      readFile: () => 'malformed stat',
    })).toBeUndefined()
    expect(linuxProcessGroupHasLiveMembers(77, {
      readDir: () => ['5'],
      readFile: () => '5 (worker) SS 1 nope',
    })).toBeUndefined()
  })
})
