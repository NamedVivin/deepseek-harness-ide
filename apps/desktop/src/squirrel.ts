/** Windows Squirrel lifecycle parsing performed before locks or Host startup. */

import { basename, dirname, resolve } from 'node:path'

/** Squirrel lifecycle event names accepted by the application entrypoint. */
export type SquirrelLifecycleEvent = 'install' | 'updated' | 'uninstall' | 'obsolete'

const SQUIRREL_ARGUMENTS: Readonly<Record<string, SquirrelLifecycleEvent>> = Object.freeze({
  '--squirrel-install': 'install',
  '--squirrel-updated': 'updated',
  '--squirrel-uninstall': 'uninstall',
  '--squirrel-obsolete': 'obsolete',
})

/**
 * Read one Squirrel lifecycle invocation.
 * @param argv - process arguments including executable and application entry.
 * @returns the lifecycle event, or undefined for an ordinary launch.
 * @throws when multiple lifecycle flags are present.
 */
export function parseSquirrelLifecycle(argv: readonly string[]): SquirrelLifecycleEvent | undefined {
  const matches = argv.flatMap((argument) => {
    const event = SQUIRREL_ARGUMENTS[argument]
    return event === undefined ? [] : [event]
  })
  if (matches.length > 1) throw new Error('desktop: multiple Squirrel lifecycle events')
  return matches[0]
}

/** Minimal Squirrel updater command runner used by Electron main and tests. */
export type SquirrelCommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<void>

/**
 * Execute only the requested Squirrel lifecycle work.
 * @param event - parsed lifecycle event.
 * @param electronExecutable - installed application executable.
 * @param timeoutMs - bounded Update.exe settlement.
 * @param run - child-process command adapter.
 */
export async function runSquirrelLifecycle(
  event: SquirrelLifecycleEvent,
  electronExecutable: string,
  timeoutMs: number,
  run: SquirrelCommandRunner,
): Promise<void> {
  if (event === 'obsolete') return
  const updater = resolve(dirname(electronExecutable), '..', 'Update.exe')
  const application = basename(electronExecutable)
  await run(
    updater,
    [event === 'uninstall' ? '--removeShortcut' : '--createShortcut', application],
    timeoutMs,
  )
}
