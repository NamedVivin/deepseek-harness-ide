/** Linux process-group liveness used by ordinary detached-process teardown. */

import { readFileSync, readdirSync } from 'node:fs'

/** Injectable `/proc` operations for process-group liveness checks. */
export interface LinuxProcessGroupInternals {
  readFile(path: string): string
  readDir(path: string): string[]
}

/* v8 ignore start -- thin filesystem bindings; injected logic is unit-tested. */
const DEFAULT_INTERNALS: LinuxProcessGroupInternals = {
  readFile: path => readFileSync(path, 'utf8'),
  readDir: path => readdirSync(path),
}
/* v8 ignore stop */

interface ProcessGroupState {
  processGroupId: number
  state: string
}

function processGroupState(text: string): ProcessGroupState | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined
  const fields = text.slice(close + 2).trim().split(/\s+/)
  const state = fields[0]
  const processGroupId = Number(fields[2])
  if (state === undefined || state.length !== 1 || !Number.isSafeInteger(processGroupId)) return undefined
  return { processGroupId, state }
}

/**
 * Report whether a Linux process group has an executing member.
 * @param processGroupId - POSIX process-group id to inspect.
 * @param internals - injectable `/proc` reads.
 * @returns `false` for an all-zombie group and `undefined` when absent or unreadable.
 */
export function linuxProcessGroupHasLiveMembers(
  processGroupId: number,
  internals: LinuxProcessGroupInternals = DEFAULT_INTERNALS,
): boolean | undefined {
  let entries: string[]
  try {
    entries = internals.readDir('/proc')
  } catch (_unreadableProcDirectory) {
    return undefined
  }
  let matched = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let state: ProcessGroupState | undefined
    try {
      state = processGroupState(internals.readFile(`/proc/${entry}/stat`))
    } catch (_unreadableProcEntry) {
      continue
    }
    if (state?.processGroupId !== processGroupId) continue
    matched = true
    if (!/^[ZXx]$/.test(state.state)) return true
  }
  return matched ? false : undefined
}
