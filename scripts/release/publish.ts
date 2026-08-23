/**
 * Publish one packed release family from the tarballs the pack step produced.
 *
 * Publication is decided per package against the registry, never from a list of
 * "what this release includes": a version the registry lacks is published, a
 * version whose published tarball has the same integrity is skipped, and a
 * version whose published tarball differs fails the run — that last case means
 * the content changed without a version bump
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * Skipping on identical integrity is what makes re-running the publish step over
 * the same artifact safe.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import {
  releaseFamily,
  releasePromotions,
  tarballName,
  type ReleaseFamily,
  type ReleaseMember,
} from './families.ts'
import { attempt, attemptEchoed, isEntry } from './process.ts'
import { packedIdentity, readPublishOrder } from './tarball.ts'

/**
 * Registry codes that answer a write which did not settle, rather than a
 * rejection of what was sent. `E409 Failed to save packument` is the one this
 * sequence actually hits: publishing several packages in a row can outrun the
 * registry's own processing. A rejected payload (`E403` over an existing
 * version, a malformed manifest) never clears on a retry and must surface.
 */
const TRANSIENT_PUBLISH_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'] as const

/** How many times one tarball's publish is attempted before the run fails. */
const PUBLISH_ATTEMPTS = 4

/**
 * Shortest gap between two publishes, and the first retry backoff.
 *
 * The registry needs a moment to commit a packument before the next write; back
 * to back publishes are what produce `E409`.
 */
const PUBLISH_SPACING_MS = 2_000

/** What the registry knows about one version. */
type RegistryState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly integrity: string }

/** One tarball identity recovered from the immutable pack artifact. */
export interface PublishCandidate {
  /** Filename recorded by the pack step. */
  readonly filename: string
  /** Package name declared inside the tarball. */
  readonly name: string
  /** Package version declared inside the tarball. */
  readonly version: string
}

/**
 * Require the pack artifact to contain every family member exactly once.
 * @param family - family selected by the publish invocation.
 * @param members - complete members discovered from the tagged checkout.
 * @param candidates - ordered tarball identities from the pack artifact.
 */
export function verifyPublishCandidates(
  family: ReleaseFamily,
  members: readonly ReleaseMember[],
  candidates: readonly PublishCandidate[],
): void {
  const byName = new Map(members.map(member => [member.name, member]))
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const member = byName.get(candidate.name)
    if (member === undefined) throw new Error(`${candidate.name} is not a member of release family ${family.id}`)
    if (seen.has(candidate.name)) throw new Error(`${candidate.name} appears twice in the packed publish order`)
    seen.add(candidate.name)
    if (candidate.version !== member.version) {
      throw new Error(`${candidate.name} packed version ${candidate.version}, expected ${member.version}`)
    }
    const expectedFilename = tarballName(member)
    if (candidate.filename !== expectedFilename) {
      throw new Error(`${candidate.name} is recorded as ${candidate.filename}, expected ${expectedFilename}`)
    }
  }
  const missing = members.filter(member => !seen.has(member.name))
  if (missing.length > 0) {
    throw new Error(`packed publish order is missing family member(s): ${missing.map(member => member.name).join(', ')}`)
  }
}

/**
 * Return the promotion that currently holds one member from publication.
 * @param family - family that owns the member's publication policy.
 * @param member - member being considered for publication.
 * @param promotions - external promotions verified by the credentialed workflow.
 * @returns missing promotion name, or `undefined` when publication may proceed.
 */
export function publicationHold(
  family: ReleaseFamily,
  member: ReleaseMember,
  promotions: ReadonlySet<string>,
): string | undefined {
  const required = family.publicationGate(member)
  return required !== undefined && !promotions.has(required) ? required : undefined
}

/**
 * Whether a failed publish is worth another attempt.
 * @param output - combined npm output.
 * @returns True when the registry reported a write it did not commit.
 */
function isTransientFailure(output: string): boolean {
  return TRANSIENT_PUBLISH_CODES.some(code => output.includes(`code ${code}`))
}

/**
 * The subresource integrity string npm records for a tarball.
 * @param tarball - absolute tarball path.
 * @returns A `sha512-<base64>` string.
 */
function integrityOf(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

/**
 * Ask the registry whether a version exists, and with what integrity.
 * @param name - package name.
 * @param version - package version.
 * @returns The registry state for that version.
 */
function registryState(name: string, version: string): RegistryState {
  const result = attempt('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json'])
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return { kind: 'absent' }
    throw new Error(`npm view ${name}@${version} failed:\n${output}`)
  }
  const parsed: unknown = JSON.parse(result.stdout)
  if (typeof parsed !== 'string' || parsed === '') {
    throw new Error(`registry reported no dist.integrity for ${name}@${version}`)
  }
  return { kind: 'present', integrity: parsed }
}

/**
 * Publish one tarball, retrying a registry write that did not settle.
 *
 * Every retry re-reads the registry first, because `E409` can answer a write
 * that landed anyway: republishing a version that now exists fails permanently,
 * so the same integrity appearing under the failed attempt counts as success.
 * @param tarball - absolute tarball path.
 * @param name - package name the tarball declares.
 * @param version - package version the tarball declares.
 */
async function publishTarball(tarball: string, name: string, version: string): Promise<void> {
  // A prerelease version never takes the latest dist-tag.
  const tagArgs = version.includes('-') ? ['--tag', 'next'] : []
  for (let tries = 1; tries <= PUBLISH_ATTEMPTS; tries += 1) {
    // No --access: the sequences do not share one access level, so a
    // command-line flag could not serve both and would override the manifest
    // that does. Each packed manifest decides, and
    // check-workspace-constraints holds every manifest to its sequence's level.
    const result = attemptEchoed('npm', ['publish', tarball, ...tagArgs])
    const output = `${result.stdout}${result.stderr}`
    if (result.status === 0) return

    const settled = registryState(name, version)
    if (settled.kind === 'present' && settled.integrity === integrityOf(tarball)) {
      console.log(`release publish: ${name}@${version} landed despite a reported failure, continuing`)
      return
    }
    if (tries === PUBLISH_ATTEMPTS || !isTransientFailure(output)) {
      throw new Error(`npm publish ${name}@${version} failed:\n${output}`)
    }
    const backoff = PUBLISH_SPACING_MS * 2 ** (tries - 1)
    console.log(
      `release publish: ${name}@${version} hit a transient registry failure`
      + ` (attempt ${String(tries)} of ${String(PUBLISH_ATTEMPTS)}), retrying in ${String(backoff)}ms`,
    )
    await sleep(backoff)
  }
}

/** Publish the family named by `--family` from the directory named by `--from`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined) {
    throw new Error('usage: publish.ts --family <dsh|vendor> --from <packed directory>')
  }

  const family = releaseFamily(values.family)
  const root = process.cwd()
  const directory = resolve(root, values.from)
  const members = family.members(root)
  family.verifyVersions(members)
  const promotions = releasePromotions(family, members, process.env.DSH_RELEASE_PROMOTIONS)
  const packed = readPublishOrder(directory).map((filename) => {
    const tarball = join(directory, filename)
    return { filename, ...packedIdentity(tarball), tarball }
  })
  verifyPublishCandidates(family, members, packed)

  // Give every packed entry a stable progress index for a release that can take
  // minutes per family, including an entry held behind an external promotion.
  const total = String(packed.length)
  let published = 0
  let skipped = 0
  let held = 0
  const membersByName = new Map(members.map(member => [member.name, member]))
  for (const [index, { name, version, tarball }] of packed.entries()) {
    const progress = `[${String(index + 1)}/${total}]`
    const member = membersByName.get(name)
    if (member === undefined) throw new Error(`${name} disappeared from release family ${family.id}`)
    const hold = publicationHold(family, member, promotions)
    if (hold !== undefined) {
      console.log(`release publish: ${progress} ${name}@${version} held for promotion ${hold}`)
      held += 1
      continue
    }
    const state = registryState(name, version)
    if (state.kind === 'present') {
      const local = integrityOf(tarball)
      if (state.integrity !== local) {
        throw new Error(
          `${name}@${version} is already published with different content`
          + `\n  registry: ${state.integrity}\n  packed:   ${local}`
          + '\nBump the version, or investigate why the build is not reproducible.',
        )
      }
      console.log(`release publish: ${progress} ${name}@${version} already published, skipping`)
      skipped += 1
      continue
    }
    // Space out the writes: the gap belongs between publishes, so a run that
    // only skips does not wait at all.
    if (published > 0) await sleep(PUBLISH_SPACING_MS)
    await publishTarball(tarball, name, version)
    console.log(`release publish: ${progress} ${name}@${version} published`)
    published += 1
  }

  console.log(
    `release publish: family ${family.id}, ${total} member(s),`
    + ` ${String(published)} published, ${String(skipped)} already present,`
    + ` ${String(held)} held for promotion`,
  )
}

if (isEntry(import.meta.url)) await main()
