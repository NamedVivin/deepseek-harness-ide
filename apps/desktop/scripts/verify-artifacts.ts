#!/usr/bin/env node
/** Verify Forge outputs and emit canonical paths for native signature and lifecycle checks. */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  discoverDesktopReleaseArtifacts,
  resolveDesktopReleaseTarget,
  verifyDesktopReleasePayload,
  verifySquirrelArtifacts,
} from '../src/release-artifacts.ts'

function option(name: string): string {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || value === undefined || value.startsWith('--')) {
    throw new Error(`desktop release: ${name} is required`)
  }
  return value
}

const target = resolveDesktopReleaseTarget(option('--target'))
if (process.platform !== target.platform || process.arch !== target.arch) {
  throw new Error(
    `desktop release: ${target.id} verification requires ${target.platform}-${target.arch}, got ${process.platform}-${process.arch}`,
  )
}
const artifacts = await discoverDesktopReleaseArtifacts(option('--out'), target)
const payload = await verifyDesktopReleasePayload(artifacts.application, target)
if (target.platform === 'win32') await verifySquirrelArtifacts(artifacts)

const report = `${JSON.stringify({ artifacts, payload }, null, 2)}\n`
const reportIndex = process.argv.indexOf('--report')
if (reportIndex < 0) process.stdout.write(report)
else {
  const reportPath = process.argv[reportIndex + 1]
  if (reportPath === undefined || reportPath.startsWith('--')) {
    throw new Error('desktop release: --report requires a path')
  }
  await writeFile(resolve(reportPath), report)
}
