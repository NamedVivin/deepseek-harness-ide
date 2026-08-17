import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_EVIDENCE_WORKFLOW,
  DESKTOP_PROMOTION_JOBS,
  parseDesktopEvidenceJobs,
  parseDesktopEvidenceRun,
  verifyDesktopPromotionEvidence,
  type DesktopEvidenceJob,
  type DesktopEvidenceJobs,
  type DesktopEvidenceRun,
} from './verify-desktop-promotion.ts'

const sha = 'a'.repeat(40)

function run(overrides: Partial<DesktopEvidenceRun> = {}): DesktopEvidenceRun {
  return {
    name: 'Desktop Artifacts',
    path: DESKTOP_EVIDENCE_WORKFLOW,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    ...overrides,
  }
}

function job(name: string, overrides: Partial<DesktopEvidenceJob> = {}): DesktopEvidenceJob {
  return { name, status: 'completed', conclusion: 'success', head_sha: sha, ...overrides }
}

function jobs(entries = DESKTOP_PROMOTION_JOBS.map(name => job(name))): DesktopEvidenceJobs {
  return { total_count: entries.length, jobs: entries }
}

describe('desktop npm promotion evidence', () => {
  it('accepts the complete signed matrix for the release commit', () => {
    expect(() => { verifyDesktopPromotionEvidence(run(), jobs(), sha) }).not.toThrow()
  })

  it('rejects another workflow, event, commit, or incomplete API page', () => {
    expect(() => { verifyDesktopPromotionEvidence(run({ path: '.github/workflows/other.yml' }), jobs(), sha) })
      .toThrow('must come from')
    expect(() => { verifyDesktopPromotionEvidence(run({ event: 'pull_request' }), jobs(), sha) })
      .toThrow('manually dispatched')
    expect(() => { verifyDesktopPromotionEvidence(run({ head_sha: 'b'.repeat(40) }), jobs(), sha) })
      .toThrow('does not match')
    expect(() => { verifyDesktopPromotionEvidence(run(), { ...jobs(), total_count: 101 }, sha) })
      .toThrow('incomplete or paginated')
  })

  it('rejects missing, duplicate, unsigned, failed, and wrong-commit target jobs', () => {
    const complete = [...jobs().jobs]
    expect(() => { verifyDesktopPromotionEvidence(run(), jobs(complete.slice(1)), sha) })
      .toThrow(`${DESKTOP_PROMOTION_JOBS[0]} exactly once`)
    expect(() => { verifyDesktopPromotionEvidence(run(), jobs([...complete, complete[1] as DesktopEvidenceJob]), sha) })
      .toThrow(`${DESKTOP_PROMOTION_JOBS[1]} exactly once`)
    expect(() => { verifyDesktopPromotionEvidence(run(), jobs(complete.map(entry => (
      entry.name === 'macos-arm64 / signed' ? job('macos-arm64 / unsigned') : entry
    ))), sha) }).toThrow('macos-arm64 / signed exactly once')
    expect(() => { verifyDesktopPromotionEvidence(run(), jobs(complete.map(entry => (
      entry.name === 'windows-x64 / signed' ? { ...entry, conclusion: 'failure' } : entry
    ))), sha) }).toThrow('is not a successful job')
    expect(() => { verifyDesktopPromotionEvidence(run(), jobs(complete.map(entry => (
      entry.name === 'macos-x64 / signed' ? { ...entry, head_sha: 'b'.repeat(40) } : entry
    ))), sha) }).toThrow('is not a successful job')
  })

  it('rejects malformed GitHub response fields before applying policy', () => {
    expect(() => parseDesktopEvidenceRun({ name: 'Desktop Artifacts' })).toThrow('has no string path')
    expect(() => parseDesktopEvidenceJobs({ total_count: -1, jobs: [] })).toThrow('invalid total_count')
    expect(() => parseDesktopEvidenceJobs({ total_count: 1, jobs: [{ name: 'job', status: 'completed' }] }))
      .toThrow('invalid conclusion')
  })

  it('wires verified evidence before the npm promotion environment', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const verification = workflow.indexOf('Verify signed desktop promotion evidence')
    const promotion = workflow.indexOf('DSH_RELEASE_PROMOTIONS:')
    expect(workflow).toContain('desktop_verification_run_id:')
    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('scripts/release/verify-desktop-promotion.ts --run-id "$DESKTOP_VERIFICATION_RUN_ID"')
    expect(verification).toBeGreaterThan(0)
    expect(promotion).toBeGreaterThan(verification)
  })
})
