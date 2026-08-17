import { describe, expect, it } from 'vitest'
import {
  DESKTOP_NATIVE_SMOKE_PROMOTION,
  releaseFamily,
  tarballName,
  type ReleaseMember,
} from './families.ts'
import { publicationHold, verifyPublishCandidates, type PublishCandidate } from './publish.ts'

function member(name: string): ReleaseMember {
  return { directory: `packages/example/${name}`, name, version: '1.2.3', manifest: {} }
}

function candidate(entry: ReleaseMember): PublishCandidate {
  return { filename: tarballName(entry), name: entry.name, version: entry.version }
}

describe('packed publish family identity', () => {
  const family = releaseFamily('dsh')
  const first = member('@deepseek-ai/dsh-first')
  const second = member('@deepseek-ai/dsh-second')

  it('accepts every exact member once', () => {
    expect(() => { verifyPublishCandidates(family, [first, second], [candidate(first), candidate(second)]) })
      .not.toThrow()
  })

  it('rejects missing, duplicate, foreign, renamed, and wrong-version tarballs', () => {
    expect(() => { verifyPublishCandidates(family, [first, second], [candidate(first)]) })
      .toThrow('missing family member')
    expect(() => { verifyPublishCandidates(family, [first, second], [candidate(first), candidate(first)]) })
      .toThrow('appears twice')
    expect(() => { verifyPublishCandidates(family, [first, second], [
      candidate(first),
      candidate(member('@deepseek-ai/dsh-foreign')),
    ]) }).toThrow('not a member')
    expect(() => { verifyPublishCandidates(family, [first, second], [
      candidate(first),
      { ...candidate(second), filename: 'renamed.tgz' },
    ]) }).toThrow('expected')
    expect(() => { verifyPublishCandidates(family, [first, second], [
      candidate(first),
      { ...candidate(second), version: '9.9.9' },
    ]) }).toThrow('packed version')
  })

  it('holds desktop without native evidence and leaves ordinary members publishable', () => {
    const desktop = member('@deepseek-ai/dsh-desktop')
    expect(publicationHold(family, desktop, new Set())).toBe(DESKTOP_NATIVE_SMOKE_PROMOTION)
    expect(publicationHold(family, desktop, new Set([DESKTOP_NATIVE_SMOKE_PROMOTION]))).toBeUndefined()
    expect(publicationHold(family, first, new Set())).toBeUndefined()
  })
})
