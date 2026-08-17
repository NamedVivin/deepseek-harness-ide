#!/usr/bin/env node
/** Native desktop package resource assembly entrypoint. */

import { resolve } from 'node:path'
import {
  DESKTOP_APP_ROOT,
  DesktopResourceAssembler,
  desktopElectronArchiveName,
  resolveDesktopAssemblyTarget,
} from '../src/assembly.ts'

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`desktop assembly: ${name} is required`)
  return value
}

const assembler = new DesktopResourceAssembler(DESKTOP_APP_ROOT)
const target = resolveDesktopAssemblyTarget(process.platform, process.arch)
await assembler.assemble({
  root: requiredEnvironment('DSH_DESKTOP_NODE_RUNTIME_ROOT'),
  archive: requiredEnvironment('DSH_DESKTOP_NODE_ARCHIVE'),
  shasums: requiredEnvironment('DSH_DESKTOP_NODE_SHASUMS'),
}, {
  archive: resolve(requiredEnvironment('DSH_DESKTOP_ELECTRON_ZIP_DIR'), desktopElectronArchiveName(target)),
  shasums: requiredEnvironment('DSH_DESKTOP_ELECTRON_SHASUMS'),
}, target)
