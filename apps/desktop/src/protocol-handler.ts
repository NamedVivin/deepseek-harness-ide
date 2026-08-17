/** Read-only `dsh-app://` response construction independent of Electron registration. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  MAX_DESKTOP_ASSET_BYTES,
  resolveDesktopAsset,
  type VerifiedDesktopAsset,
} from './resource-manifest.ts'
import { DESKTOP_CONTENT_SECURITY_POLICY } from './security.ts'

/**
 * Read one already-verified asset and recheck its immutable digest at use.
 * @param asset - main-process-only verified resource record.
 * @returns packaged bytes.
 */
async function readDesktopAsset(asset: VerifiedDesktopAsset): Promise<Uint8Array> {
  const bytes = await readFile(asset.absolutePath)
  if (bytes.byteLength !== asset.size || bytes.byteLength > MAX_DESKTOP_ASSET_BYTES) {
    throw new Error(`desktop resources: asset size changed after verification: ${asset.url}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256) {
    throw new Error(`desktop resources: asset changed after verification: ${asset.url}`)
  }
  return bytes
}

/**
 * Serve one exact signed shell asset or currently active Client bundle.
 * @param assets - verified signed resource table.
 * @param activeClientUrls - live sidecar graph URLs admitted for this run.
 * @param requestUrl - untrusted protocol request URL.
 * @returns immutable response, or 404 without path details.
 */
export async function handleDesktopProtocolRequest(
  assets: ReadonlyMap<string, VerifiedDesktopAsset>,
  activeClientUrls: ReadonlySet<string>,
  requestUrl: string,
): Promise<Response> {
  const asset = resolveDesktopAsset(assets, requestUrl)
  if (asset === undefined) return new Response('not found', { status: 404 })
  const parsed = new URL(requestUrl)
  if (parsed.host === 'plugins' && !activeClientUrls.has(requestUrl)) {
    return new Response('not found', { status: 404 })
  }
  if (parsed.host !== 'plugins' && parsed.host !== 'shell') {
    return new Response('not found', { status: 404 })
  }
  const bytes = await readDesktopAsset(asset)
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-type': asset.mediaType,
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
  })
  if (requestUrl === 'dsh-app://shell/index.html') {
    headers.set('content-security-policy', DESKTOP_CONTENT_SECURITY_POLICY)
  }
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  return new Response(body, { status: 200, headers })
}
