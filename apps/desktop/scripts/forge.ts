/** Application-owned Electron Forge entrypoint that bypasses CLI workspace checks. */

import { resolve } from 'node:path'
import { api } from '@electron-forge/core'

const appRoot = resolve(import.meta.dirname, '..')

async function run(command: string | undefined): Promise<void> {
  switch (command) {
    case 'package':
      await api.package({ dir: appRoot, interactive: false })
      return
    case 'make':
      await api.make({ dir: appRoot, interactive: false })
      return
    case 'start':
      await api.start({ dir: appRoot, interactive: true })
      return
    default:
      throw new Error(`desktop Forge: expected package, make, or start; received ${JSON.stringify(command)}`)
  }
}

await run(process.argv[2])
