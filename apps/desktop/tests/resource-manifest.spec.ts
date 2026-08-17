import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseDesktopAssetManifest,
  resolveDesktopAsset,
  validateDesktopClientAssets,
  verifyDesktopAssets,
} from '../src/resource-manifest.ts'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('desktop resource manifest', () => {
  it('verifies exact packaged bytes and resolves only an advertised URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-assets-'))
    roots.push(root)
    await mkdir(join(root, 'shell'))
    await writeFile(join(root, 'shell', 'index.html'), '<main>DSH</main>')
    const manifest = parseDesktopAssetManifest({
      version: 1,
      assets: [{
        url: 'dsh-app://shell/index.html',
        segments: ['shell', 'index.html'],
        sha256: hash('<main>DSH</main>'),
        mediaType: 'text/html; charset=utf-8',
      }],
    })
    const assets = await verifyDesktopAssets(root, manifest)

    expect(resolveDesktopAsset(assets, 'dsh-app://shell/index.html')).toMatchObject({
      size: 16,
      mediaType: 'text/html; charset=utf-8',
    })
    expect(resolveDesktopAsset(assets, 'dsh-app://shell/index.html?unexpected=1')).toBeUndefined()
    expect(resolveDesktopAsset(assets, 'file:///etc/passwd')).toBeUndefined()
  })

  it.each([
    [{ version: 2, assets: [] }, /version/u],
    [{ version: 1, assets: [{ url: 'file:///tmp/a', segments: ['a'], sha256: '0'.repeat(64), mediaType: 'text/plain' }] }, /canonical dsh-app/u],
    [{ version: 1, assets: [{ url: 'dsh-app://shell/a', segments: ['..', 'a'], sha256: '0'.repeat(64), mediaType: 'text/plain' }] }, /safe non-empty/u],
    [{ version: 1, assets: [{ url: 'dsh-app://shell/a', segments: ['a'], sha256: 'ABC', mediaType: 'text/plain' }] }, /sha256/u],
  ])('rejects malformed signed tables', (value, error) => {
    expect(() => parseDesktopAssetManifest(value)).toThrow(error)
  })

  it('rejects modified bytes and symbolic-link assets before a window opens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-assets-'))
    roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-desktop-outside-'))
    roots.push(outside)
    await writeFile(join(root, 'changed.js'), 'changed')
    await writeFile(join(outside, 'outside.js'), 'outside')
    await symlink(join(outside, 'outside.js'), join(root, 'linked.js'))

    const changed = parseDesktopAssetManifest({
      version: 1,
      assets: [{
        url: 'dsh-app://shell/changed.js',
        segments: ['changed.js'],
        sha256: hash('expected'),
        mediaType: 'text/javascript',
      }],
    })
    await expect(verifyDesktopAssets(root, changed)).rejects.toThrow('integrity mismatch')

    const linked = parseDesktopAssetManifest({
      version: 1,
      assets: [{
        url: 'dsh-app://shell/linked.js',
        segments: ['linked.js'],
        sha256: hash('outside'),
        mediaType: 'text/javascript',
      }],
    })
    await expect(verifyDesktopAssets(root, linked)).rejects.toThrow('symbolic links are forbidden')
  })

  it('admits only canonical live Client revisions present in the signed table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-assets-'))
    roots.push(root)
    await mkdir(join(root, 'plugins'), { recursive: true })
    await writeFile(join(root, 'plugins', 'client.js'), 'plugin')
    const url = 'dsh-app://plugins/@deepseek-ai/dsh-client-ui-ide/client.js?rev=abc123'
    const assets = await verifyDesktopAssets(root, parseDesktopAssetManifest({
      version: 1,
      assets: [{
        url,
        segments: ['plugins', 'client.js'],
        sha256: hash('plugin'),
        mediaType: 'text/javascript; charset=utf-8',
      }],
    }))
    expect(validateDesktopClientAssets(assets, {
      rev: 'graph',
      entries: [{ id: '@deepseek-ai/dsh-client-ui-ide', url, rev: 'abc123' }],
    })).toEqual(new Set([url]))
    expect(() => validateDesktopClientAssets(assets, {
      rev: 'graph',
      entries: [{ id: '@deepseek-ai/dsh-client-ui-ide', url, rev: 'other' }],
    })).toThrow('non-canonical URL')
    expect(() => validateDesktopClientAssets(assets, {
      rev: 'graph',
      entries: [{
        id: '@deepseek-ai/dsh-client-ui-tool',
        url: 'dsh-app://plugins/@deepseek-ai/dsh-client-ui-tool/client.js?rev=missing',
        rev: 'missing',
      }],
    })).toThrow('absent from the signed manifest')
  })
})
