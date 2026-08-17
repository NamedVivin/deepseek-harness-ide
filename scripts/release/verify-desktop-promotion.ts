/** Verify that a signed native desktop run promotes the npm package for this commit. */

import { parseArgs } from 'node:util'
import { capture, isEntry } from './process.ts'

/** GitHub Actions workflow that owns the signed native desktop evidence. */
export const DESKTOP_EVIDENCE_WORKFLOW = '.github/workflows/desktop-artifacts.yml'

/** Jobs whose success proves the closed first-release target matrix. */
export const DESKTOP_PROMOTION_JOBS = Object.freeze([
  'Desktop release scripts',
  'macos-arm64 / signed',
  'macos-x64 / signed',
  'windows-x64 / signed',
  'Three-target desktop candidate',
] as const)

/** Fields consumed from the GitHub workflow-run response. */
export interface DesktopEvidenceRun {
  /** Workflow display name. */
  readonly name: string
  /** Repository-relative workflow path. */
  readonly path: string
  /** Event that started the run. */
  readonly event: string
  /** Current run status. */
  readonly status: string
  /** Completed run result. */
  readonly conclusion: string | null
  /** Commit whose workflow and source were executed. */
  readonly head_sha: string
}

/** Fields consumed from one GitHub workflow-job response. */
export interface DesktopEvidenceJob {
  /** Expanded job name, including the matrix target and signature policy. */
  readonly name: string
  /** Current job status. */
  readonly status: string
  /** Completed job result. */
  readonly conclusion: string | null
  /** Commit checked by this job. */
  readonly head_sha: string
}

/** Fields consumed from the GitHub workflow-jobs response. */
export interface DesktopEvidenceJobs {
  /** Total jobs reported before pagination. */
  readonly total_count: number
  /** Jobs returned on this page. */
  readonly jobs: readonly DesktopEvidenceJob[]
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop promotion: GitHub ${label} response is not an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function requiredString(
  source: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string {
  const value = source[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop promotion: GitHub ${label} response has no string ${field}`)
  }
  return value
}

function nullableString(
  source: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string | null {
  const value = source[field]
  if (value !== null && typeof value !== 'string') {
    throw new Error(`desktop promotion: GitHub ${label} response has invalid ${field}`)
  }
  return value
}

/**
 * Parse the subset of a GitHub workflow-run response used by the promotion gate.
 * @param value - untrusted JSON returned by the GitHub API.
 * @returns validated workflow-run fields.
 */
export function parseDesktopEvidenceRun(value: unknown): DesktopEvidenceRun {
  const source = record(value, 'workflow-run')
  return {
    name: requiredString(source, 'name', 'workflow-run'),
    path: requiredString(source, 'path', 'workflow-run'),
    event: requiredString(source, 'event', 'workflow-run'),
    status: requiredString(source, 'status', 'workflow-run'),
    conclusion: nullableString(source, 'conclusion', 'workflow-run'),
    head_sha: requiredString(source, 'head_sha', 'workflow-run'),
  }
}

/**
 * Parse the subset of a GitHub workflow-jobs response used by the promotion gate.
 * @param value - untrusted JSON returned by the GitHub API.
 * @returns validated job count and job fields.
 */
export function parseDesktopEvidenceJobs(value: unknown): DesktopEvidenceJobs {
  const source = record(value, 'workflow-jobs')
  const totalCount = source.total_count
  if (!Number.isSafeInteger(totalCount) || (totalCount as number) < 0) {
    throw new Error('desktop promotion: GitHub workflow-jobs response has invalid total_count')
  }
  if (!Array.isArray(source.jobs)) {
    throw new Error('desktop promotion: GitHub workflow-jobs response has no jobs array')
  }
  const jobs = source.jobs.map((value, index) => {
    const job = record(value, `workflow-job ${String(index)}`)
    return {
      name: requiredString(job, 'name', 'workflow-job'),
      status: requiredString(job, 'status', 'workflow-job'),
      conclusion: nullableString(job, 'conclusion', 'workflow-job'),
      head_sha: requiredString(job, 'head_sha', 'workflow-job'),
    }
  })
  return { total_count: totalCount as number, jobs }
}

/**
 * Require successful signed evidence for every native target at one exact commit.
 * @param run - validated workflow-run fields.
 * @param jobs - validated jobs response from the run's latest attempt.
 * @param expectedSha - commit being published by the release workflow.
 */
export function verifyDesktopPromotionEvidence(
  run: DesktopEvidenceRun,
  jobs: DesktopEvidenceJobs,
  expectedSha: string,
): void {
  if (run.name !== 'Desktop Artifacts' || run.path !== DESKTOP_EVIDENCE_WORKFLOW) {
    throw new Error(`desktop promotion: evidence must come from ${DESKTOP_EVIDENCE_WORKFLOW}`)
  }
  if (run.event !== 'workflow_dispatch') {
    throw new Error('desktop promotion: evidence must be a manually dispatched signed run')
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('desktop promotion: evidence workflow did not complete successfully')
  }
  if (run.head_sha !== expectedSha) {
    throw new Error(`desktop promotion: evidence commit ${run.head_sha} does not match release commit ${expectedSha}`)
  }
  if (jobs.total_count !== jobs.jobs.length) {
    throw new Error('desktop promotion: workflow job response is incomplete or paginated')
  }
  for (const requiredName of DESKTOP_PROMOTION_JOBS) {
    const matches = jobs.jobs.filter(job => job.name === requiredName)
    if (matches.length !== 1) {
      throw new Error(`desktop promotion: expected ${requiredName} exactly once, found ${String(matches.length)}`)
    }
    const job = matches[0]
    if (job?.status !== 'completed' || job.conclusion !== 'success' || job.head_sha !== expectedSha) {
      throw new Error(`desktop promotion: ${requiredName} is not a successful job for ${expectedSha}`)
    }
  }
}

function apiJson(repository: string, endpoint: string): unknown {
  const response = capture('gh', [
    'api',
    '--header',
    'Accept: application/vnd.github+json',
    '--header',
    'X-GitHub-Api-Version: 2022-11-28',
    `repos/${repository}/${endpoint}`,
  ])
  return JSON.parse(response) as unknown
}

/** Verify the `--run-id` promotion evidence selected by the release operator. */
function main(): void {
  const { values } = parseArgs({
    options: { 'run-id': { type: 'string' } },
    allowPositionals: false,
  })
  const runId = values['run-id']
  if (runId === undefined || !/^[1-9]\d*$/u.test(runId)) {
    throw new Error('usage: verify-desktop-promotion.ts --run-id <positive GitHub Actions run id>')
  }
  const repository = process.env.GITHUB_REPOSITORY
  if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('desktop promotion: GITHUB_REPOSITORY must identify the release repository')
  }
  const expectedSha = process.env.GITHUB_SHA
  if (expectedSha === undefined || !/^[0-9a-f]{40}$/u.test(expectedSha)) {
    throw new Error('desktop promotion: GITHUB_SHA must be the release commit')
  }
  if (process.env.GH_TOKEN === undefined || process.env.GH_TOKEN === '') {
    throw new Error('desktop promotion: GH_TOKEN is required to read workflow evidence')
  }

  const run = parseDesktopEvidenceRun(apiJson(repository, `actions/runs/${runId}`))
  const jobs = parseDesktopEvidenceJobs(apiJson(repository, `actions/runs/${runId}/jobs?filter=latest&per_page=100`))
  verifyDesktopPromotionEvidence(run, jobs, expectedSha)
  console.log(`desktop promotion: signed three-target run ${runId} verified for ${expectedSha}`)
}

if (isEntry(import.meta.url)) main()
