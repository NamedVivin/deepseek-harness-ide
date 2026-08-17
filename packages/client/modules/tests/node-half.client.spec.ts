/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientModuleRegistry } from '../src/index.ts'
import { parseBootManifest } from '../src/client/manifest.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Construct the carrier-neutral node-half service. */
function construct(packageNames: string[]): ClientModuleRegistry {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  ctx.provide('clientModuleDelivery', {
    bundleUrl: (id: string, revision: string) => `test://plugins/${id}?rev=${revision}`,
    install: () => () => {},
    resolveBundleUrl: () => undefined,
  })
  return new ClientModuleRegistry(ctx)
}

describe('client bundle activation', () => {
  it('publishes the Host-readable manifest parser separately from the browser bundle', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown>; files: string[] }
    expect(packageJson.exports['./manifest']).toEqual({
      types: './lib/types/client/manifest.d.ts',
      default: './lib/types/client/manifest.js',
    })
    expect(packageJson.files).toContain('lib/types/client/manifest.js')
    expect(parseBootManifest({ rev: 'empty', entries: [] })).toEqual({
      rev: 'empty',
      modules: [],
      plugins: [],
    })
  })

  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

})
