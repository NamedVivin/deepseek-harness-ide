/**
 * Effect-scoped policy contributions that admit agent-preset operations and
 * issue the runtime-only authority used by standing mounts.
 * @module @deepseek-ai/dsh-agent-presets/admission
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** Public preset operations an admission contribution can distinguish. */
export type PresetAdmissionOperation =
  | 'resolve'
  | 'mount'
  | 'recompose'
  | 'standingKeyFor'
  | 'composeFrom'

/** One operation presented to every live admission contribution. */
export interface PresetAdmissionRequest {
  /** Public service operation being attempted. */
  readonly operation: PresetAdmissionOperation
  /** Explicit or defaulted preset id the operation would use. */
  readonly presetId: string
}

/** A contribution's stable refusal description. */
export interface PresetAdmissionRefusal {
  /** Machine-readable refusal code owned by the contribution. */
  readonly code: string
  /** Human-readable reason, without the agent-presets prefix. */
  readonly reason: string
  /** Optional structured facts for transports and user interfaces. */
  readonly details?: Readonly<Record<string, JsonValue>>
}

/** One synchronous admission policy contribution. */
export interface PresetAdmissionContribution {
  /**
   * Admit or refuse one operation.
   * @param request - operation and preset id being considered.
   * @returns a stable refusal, or `undefined` to admit the operation.
   */
  admit(request: PresetAdmissionRequest): PresetAdmissionRefusal | undefined
}

/** Stable metadata attached to {@link PresetAdmissionError}. */
export interface PresetAdmissionErrorMetadata {
  /** Public service operation that was refused. */
  readonly operation: PresetAdmissionOperation
  /** Preset id the operation would have used. */
  readonly presetId: string
  /** Machine-readable code supplied by the refusing contribution. */
  readonly code: string
  /** Human-readable reason supplied by the contribution. */
  readonly reason: string
  /** Optional structured facts supplied by the contribution. */
  readonly details?: Readonly<Record<string, JsonValue>>
}

/** A live admission contribution refused a preset operation. */
export class PresetAdmissionError extends Error {
  /** Stable refusal fields for transports and user interfaces. */
  readonly metadata: PresetAdmissionErrorMetadata

  constructor(request: PresetAdmissionRequest, refusal: PresetAdmissionRefusal) {
    const metadata: PresetAdmissionErrorMetadata = Object.freeze({
      operation: request.operation,
      presetId: request.presetId,
      code: refusal.code,
      reason: refusal.reason,
      ...(refusal.details === undefined ? {} : { details: Object.freeze({ ...refusal.details }) }),
    })
    super(
      `agent-presets: admission "${refusal.code}" refused ${request.operation} `
      + `for preset "${request.presetId}": ${refusal.reason}`,
    )
    this.name = 'PresetAdmissionError'
    this.metadata = metadata
  }
}

/** Why a runtime-only preset admission proof was rejected. */
export type PresetAdmissionProofFailure =
  | 'unrecognized'
  | 'wrong-authority'
  | 'stale-policy'
  | 'wrong-preset'
  | 'wrong-operation'
  | 'not-issued'
  | 'not-generation'

/** A preset mount or inherited composition did not carry current authority. */
export class PresetAdmissionProofError extends Error {
  constructor(
    /** Preset id the caller tried to use. */
    readonly presetId: string,
    /** Stable reason the proof was rejected. */
    readonly reason: PresetAdmissionProofFailure,
  ) {
    super(`agent-presets: admission proof for preset "${presetId}" is invalid: ${reason}`)
    this.name = 'PresetAdmissionProofError'
  }
}

declare const presetAdmissionProofBrand: unique symbol

/**
 * Opaque authority for one admitted operation or standing generation.
 *
 * The structural brand only keeps ordinary TypeScript callers from creating a
 * value. Runtime acceptance additionally requires identity in this module's
 * private proof registry.
 */
export interface PresetAdmissionProof {
  readonly [presetAdmissionProofBrand]: true
}

type ProofState = 'issued' | 'generation' | 'spent'

interface ProofRecord {
  readonly owner: PresetAdmissionRuntime
  readonly policy: object
  readonly operation: PresetAdmissionOperation
  readonly presetId: string
  state: ProofState
}

const proofRecords = new WeakMap<PresetAdmissionProof, ProofRecord>()
const runtimePolicies = new WeakMap<PresetAdmissionRuntime, object>()

/** Current policy identity installed by every admission runtime constructor. */
function currentPolicy(runtime: PresetAdmissionRuntime): object {
  const policy = runtimePolicies.get(runtime)
  /* v8 ignore next -- every runtime records its initial policy in its constructor before it can issue a proof */
  if (policy === undefined) throw new Error('agent-presets: admission runtime has no policy generation')
  return policy
}

/** A proof record whose existence was already established by {@link proofFailure}. */
function recognizedProofRecord(
  proof: PresetAdmissionProof,
  presetId: string,
): ProofRecord {
  const record = proofRecords.get(proof)
  /* v8 ignore next -- callers throw proofFailure before asking for the recognized record */
  if (record === undefined) throw new PresetAdmissionProofError(presetId, 'unrecognized')
  return record
}

function proofFailure(
  proof: PresetAdmissionProof,
  owner: PresetAdmissionRuntime | undefined,
  presetId: string,
): PresetAdmissionProofError | undefined {
  const record = proofRecords.get(proof)
  if (record === undefined) return new PresetAdmissionProofError(presetId, 'unrecognized')
  if (owner !== undefined && record.owner !== owner) {
    return new PresetAdmissionProofError(presetId, 'wrong-authority')
  }
  if (record.policy !== currentPolicy(record.owner)) {
    return new PresetAdmissionProofError(presetId, 'stale-policy')
  }
  if (record.presetId !== presetId) return new PresetAdmissionProofError(presetId, 'wrong-preset')
  return undefined
}

/**
 * Claim one operation proof as the authority for a new standing generation.
 * @param proof - runtime-issued operation authority.
 * @param presetId - preset the low-level mount will install.
 */
export function claimPresetAdmissionProof(proof: PresetAdmissionProof, presetId: string): void {
  const failure = proofFailure(proof, undefined, presetId)
  if (failure !== undefined) throw failure
  const record = recognizedProofRecord(proof, presetId)
  if (record.operation === 'resolve' || record.operation === 'composeFrom') {
    throw new PresetAdmissionProofError(presetId, 'wrong-operation')
  }
  if (record.state !== 'issued') throw new PresetAdmissionProofError(presetId, 'not-issued')
  record.state = 'generation'
}

/**
 * Assert that one claimed standing-generation proof still belongs to the current policy.
 * @param proof - claimed generation authority.
 * @param presetId - preset the generation installed.
 */
export function assertPresetAdmissionProofCurrent(
  proof: PresetAdmissionProof,
  presetId: string,
): void {
  const failure = proofFailure(proof, undefined, presetId)
  if (failure !== undefined) throw failure
  if (recognizedProofRecord(proof, presetId).state !== 'generation') {
    throw new PresetAdmissionProofError(presetId, 'not-generation')
  }
}

interface ContributionRecord {
  readonly contribution: PresetAdmissionContribution
}

/** Internal owner of live admission policy and its runtime-only proofs. */
export class PresetAdmissionRuntime {
  private readonly contributions = new Set<ContributionRecord>()

  constructor() {
    runtimePolicies.set(this, Object.freeze({}))
  }

  /**
   * Add one contribution until the returned disposer runs.
   * @param contribution - synchronous policy contribution.
   * @returns a disposer that removes exactly this registration.
   */
  register(contribution: PresetAdmissionContribution): () => void {
    const record = { contribution }
    this.contributions.add(record)
    this.rotatePolicy()
    return () => {
      if (!this.contributions.delete(record)) return
      this.rotatePolicy()
    }
  }

  /**
   * Run every live contribution and issue authority for one admitted operation.
   * @param operation - public service operation being attempted.
   * @param presetId - explicit or defaulted preset id.
   * @returns a current, single-use operation proof.
   */
  authorize(operation: PresetAdmissionOperation, presetId: string): PresetAdmissionProof {
    const request = Object.freeze({ operation, presetId })
    for (const { contribution } of this.contributions) {
      const refusal = contribution.admit(request)
      if (refusal !== undefined) throw new PresetAdmissionError(request, refusal)
    }
    const proof = Object.freeze({}) as PresetAdmissionProof
    proofRecords.set(proof, {
      owner: this,
      policy: currentPolicy(this),
      operation,
      presetId,
      state: 'issued',
    })
    return proof
  }

  /**
   * Assert that an operation proof is current and matches its public entry point.
   * @param proof - runtime-issued operation authority.
   * @param operation - public entry point that owns the proof.
   * @param presetId - preset id admitted at that entry point.
   */
  assertIssued(
    proof: PresetAdmissionProof,
    operation: PresetAdmissionOperation,
    presetId: string,
  ): void {
    const failure = proofFailure(proof, this, presetId)
    if (failure !== undefined) throw failure
    const record = recognizedProofRecord(proof, presetId)
    if (record.operation !== operation) {
      throw new PresetAdmissionProofError(presetId, 'wrong-operation')
    }
    if (record.state !== 'issued') throw new PresetAdmissionProofError(presetId, 'not-issued')
  }

  /**
   * Consume an admitted operation that reused an existing standing generation.
   * @param proof - runtime-issued operation authority.
   * @param operation - public entry point that owns the proof.
   * @param presetId - preset id admitted at that entry point.
   */
  consume(
    proof: PresetAdmissionProof,
    operation: PresetAdmissionOperation,
    presetId: string,
  ): void {
    this.assertIssued(proof, operation, presetId)
    recognizedProofRecord(proof, presetId).state = 'spent'
  }

  /**
   * Retire a proof while preserving the error that ended its operation.
   * @param proof - operation authority that will not reach a mount or reuse.
   */
  retire(proof: PresetAdmissionProof): void {
    const record = proofRecords.get(proof)
    if (record?.owner === this && record.state === 'issued') record.state = 'spent'
  }

  /**
   * Whether a standing-generation proof belongs to this runtime's current policy.
   * @param proof - claimed generation authority.
   * @param presetId - preset the generation installed.
   * @returns whether this runtime and its current contribution set issued it.
   */
  isCurrentGeneration(proof: PresetAdmissionProof, presetId: string): boolean {
    const record = proofRecords.get(proof)
    return record !== undefined
      && proofFailure(proof, this, presetId) === undefined
      && record.state === 'generation'
  }

  /**
   * Assert that an inherited standing generation belongs to this runtime and policy.
   * @param proof - claimed generation authority.
   * @param presetId - preset the generation installed.
   */
  assertCurrentGeneration(proof: PresetAdmissionProof, presetId: string): void {
    const failure = proofFailure(proof, this, presetId)
    if (failure !== undefined) throw failure
    if (recognizedProofRecord(proof, presetId).state !== 'generation') {
      throw new PresetAdmissionProofError(presetId, 'not-generation')
    }
  }

  private rotatePolicy(): void {
    runtimePolicies.set(this, Object.freeze({}))
  }
}
