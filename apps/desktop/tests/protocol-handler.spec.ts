import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleDesktopProtocolRequest } from '../src/protocol-handler.ts'
import type { VerifiedDesktopAsset } from '../src/resource-manifest.ts'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(url: string, content = 'payload'): Promise<{
  assets: Map<string, VerifiedDesktopAsset>
  path: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
  roots.push(root)
  const path = join(root, 'asset')
  await writeFile(path, content)
  return {
    path,
    assets: new Map([[url, {
      url,
      segments: ['asset'],
      sha256: createHash('sha256').update(content).digest('hex'),
      mediaType: 'text/javascript; charset=utf-8',
      absolutePath: path,
      size: Buffer.byteLength(content),
    }]]),
  }
}

describe('desktop protocol handler', () => {
  it('serves signed shell bytes with security headers', async () => {
    const url = 'dsh-app://shell/index.html'
    const { assets } = await fixture(url, '<main>DSH</main>')
    const response = await handleDesktopProtocolRequest(assets, new Set(), url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<main>DSH</main>')
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('requires a signed and live graph entry for plugin bytes', async () => {
    const url = 'dsh-app://plugins/@deepseek-ai/dsh-client-ui-ide/client.js?rev=one'
    const { assets } = await fixture(url)
    await expect(handleDesktopProtocolRequest(assets, new Set(), url).then(value => value.status))
      .resolves.toBe(404)
    await expect(handleDesktopProtocolRequest(assets, new Set([url]), url).then(value => value.text()))
      .resolves.toBe('payload')
    await expect(handleDesktopProtocolRequest(assets, new Set([url]), `${url}&extra=1`).then(value => value.status))
      .resolves.toBe(404)
  })

  it('detects a post-verification resource replacement', async () => {
    const url = 'dsh-app://shell/app.js'
    const { assets, path } = await fixture(url)
    await writeFile(path, 'changed')
    await expect(handleDesktopProtocolRequest(assets, new Set(), url))
      .rejects.toThrow(/changed after verification|size changed/u)
  })
})
