/** Exact, integrity-pinned resource table served by Electron's `dsh-app://` protocol. */

import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** Maximum number of signed resources accepted from one application manifest. */
const MAX_DESKTOP_ASSETS = 10_000
/** Maximum bytes read for one renderer resource. */
export const MAX_DESKTOP_ASSET_BYTES = 32 * 1024 * 1024

/** One exact URL-to-file entry in the signed desktop resource manifest. */
export interface DesktopAssetEntry {
  /** Exact `dsh-app://` URL accepted by the protocol handler. */
  url: string
  /** Relative resource-root path expressed as individually validated segments. */
  segments: string[]
  /** Lowercase SHA-256 of the packaged bytes. */
  sha256: string
  /** Response Content-Type. */
  mediaType: string
}

/** Signed resource manifest JSON. */
export interface DesktopAssetManifest {
  /** Manifest format version. */
  version: 1
  /** Closed renderer asset table. */
  assets: DesktopAssetEntry[]
}

/** Verified resource ready for Electron protocol delivery. */
export interface VerifiedDesktopAsset extends DesktopAssetEntry {
  /** Canonical absolute path retained only in Electron main. */
  absolutePath: string
  /** Verified byte length. */
  size: number
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop resources: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseEntry(value: unknown, index: number): DesktopAssetEntry {
  const record = asRecord(value, `asset ${String(index)}`)
  const url = record.url
  const segments = record.segments
  const sha256 = record.sha256
  const mediaType = record.mediaType
  if (typeof url !== 'string') throw new Error(`desktop resources: asset ${String(index)} url must be a string`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`desktop resources: asset ${String(index)} has an invalid URL`)
  }
  if (parsed.protocol !== 'dsh-app:' || parsed.username !== '' || parsed.password !== ''
    || parsed.port !== '' || parsed.hash !== '' || parsed.href !== url) {
    throw new Error(`desktop resources: asset ${String(index)} URL is not one canonical dsh-app URL`)
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(`desktop resources: asset ${String(index)} segments must be safe non-empty path segments`)
  }
  const safeSegments: string[] = []
  for (const segment of segments as unknown[]) {
    if (typeof segment !== 'string' || segment === '' || segment === '.' || segment === '..'
      || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      throw new Error(`desktop resources: asset ${String(index)} segments must be safe non-empty path segments`)
    }
    safeSegments.push(segment)
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error(`desktop resources: asset ${String(index)} sha256 must be lowercase hexadecimal`)
  }
  if (typeof mediaType !== 'string' || mediaType === '' || /[\r\n]/u.test(mediaType)) {
    throw new Error(`desktop resources: asset ${String(index)} mediaType must be a non-empty header value`)
  }
  return { url, segments: safeSegments, sha256, mediaType }
}

/**
 * Parse the signed manifest bytes without resolving any file.
 * @param input - untrusted JSON text or parsed value.
 * @returns the validated manifest.
 */
export function parseDesktopAssetManifest(input: unknown): DesktopAssetManifest {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown
    } catch (error) {
      throw new Error(`desktop resources: manifest is not valid JSON: ${String(error)}`)
    }
  }
  const record = asRecord(value, 'manifest')
  if (record.version !== 1) throw new Error('desktop resources: manifest version must be 1')
  if (!Array.isArray(record.assets)) throw new Error('desktop resources: manifest assets must be an array')
  if (record.assets.length > MAX_DESKTOP_ASSETS) {
    throw new Error(`desktop resources: manifest exceeds ${String(MAX_DESKTOP_ASSETS)} assets`)
  }
  const assets = record.assets.map(parseEntry)
  const urls = new Set<string>()
  for (const asset of assets) {
    if (urls.has(asset.url)) throw new Error(`desktop resources: duplicate URL ${asset.url}`)
    urls.add(asset.url)
  }
  return { version: 1, assets }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function rejectSymlinkPath(root: string, segments: readonly string[]): Promise<void> {
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`desktop resources: symbolic links are forbidden: ${current}`)
    }
  }
}

/**
 * Resolve and hash every manifest entry before any renderer window opens.
 * @param resourceRoot - signed application resource directory.
 * @param manifest - validated manifest.
 * @returns exact URL map with canonical main-process-only paths.
 */
export async function verifyDesktopAssets(
  resourceRoot: string,
  manifest: DesktopAssetManifest,
): Promise<ReadonlyMap<string, VerifiedDesktopAsset>> {
  const canonicalRoot = await realpath(resolve(resourceRoot))
  const verified = new Map<string, VerifiedDesktopAsset>()
  for (const asset of manifest.assets) {
    await rejectSymlinkPath(canonicalRoot, asset.segments)
    const candidate = join(canonicalRoot, ...asset.segments)
    const canonical = await realpath(candidate)
    if (!isWithin(canonicalRoot, canonical)) {
      throw new Error(`desktop resources: asset escapes resource root: ${asset.url}`)
    }
    const metadata = await stat(canonical)
    if (!metadata.isFile()) throw new Error(`desktop resources: asset is not a regular file: ${asset.url}`)
    if (metadata.size > MAX_DESKTOP_ASSET_BYTES) {
      throw new Error(`desktop resources: asset exceeds ${String(MAX_DESKTOP_ASSET_BYTES)} bytes: ${asset.url}`)
    }
    const bytes = await readFile(canonical)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== asset.sha256) throw new Error(`desktop resources: integrity mismatch: ${asset.url}`)
    verified.set(asset.url, { ...asset, absolutePath: canonical, size: bytes.byteLength })
  }
  return verified
}

/**
 * Resolve one protocol request by exact URL equality.
 * @param assets - verified application table.
 * @param requestUrl - untrusted request URL.
 * @returns the corresponding asset, or undefined when it was not advertised.
 */
export function resolveDesktopAsset(
  assets: ReadonlyMap<string, VerifiedDesktopAsset>,
  requestUrl: string,
): VerifiedDesktopAsset | undefined {
  return assets.get(requestUrl)
}

/**
 * Cross-check the live sidecar module graph against signed packaged assets.
 * @param assets - verified application resource table.
 * @param graph - sidecar-composed Client module graph.
 * @returns exact plugin URLs that the protocol may serve for this run.
 */
export function validateDesktopClientAssets(
  assets: ReadonlyMap<string, VerifiedDesktopAsset>,
  graph: WebBootGraph,
): ReadonlySet<string> {
  const active = new Set<string>()
  for (const row of graph.entries) {
    const expected = `dsh-app://plugins/${row.id}/client.js?rev=${row.rev}`
    if (row.url !== expected) {
      throw new Error(`desktop resources: Client graph row ${JSON.stringify(row.id)} has a non-canonical URL`)
    }
    if (active.has(row.url)) {
      throw new Error(`desktop resources: Client graph repeats URL ${row.url}`)
    }
    if (!assets.has(row.url)) {
      throw new Error(`desktop resources: Client graph URL is absent from the signed manifest: ${row.url}`)
    }
    active.add(row.url)
  }
  return active
}
