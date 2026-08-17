import { describe, expect, it } from 'vitest'
import {
  assertPresetAdmissionProofCurrent,
  claimPresetAdmissionProof,
  PresetAdmissionProofError,
  PresetAdmissionRuntime,
  type PresetAdmissionProof,
} from '../src/admission.ts'

const fakeProof = (): PresetAdmissionProof => Object.freeze({}) as PresetAdmissionProof

describe('preset admission proof authority', () => {
  it('rejects proofs from another runtime or preset', () => {
    const owner = new PresetAdmissionRuntime()
    const other = new PresetAdmissionRuntime()
    const proof = owner.authorize('mount', 'standard')

    expect(() => { other.assertIssued(proof, 'mount', 'standard') })
      .toThrow(expect.objectContaining({ reason: 'wrong-authority' }))
    expect(() => { owner.assertIssued(proof, 'mount', 'minimal') })
      .toThrow(expect.objectContaining({ reason: 'wrong-preset' }))
    expect(() => { claimPresetAdmissionProof(proof, 'minimal') })
      .toThrow(expect.objectContaining({ reason: 'wrong-preset' }))
  })

  it('permits only mount-like operation proofs to create a generation', () => {
    const runtime = new PresetAdmissionRuntime()

    expect(() => { claimPresetAdmissionProof(runtime.authorize('resolve', 'standard'), 'standard') })
      .toThrow(expect.objectContaining({ reason: 'wrong-operation' }))
    expect(() => { claimPresetAdmissionProof(runtime.authorize('composeFrom', 'standard'), 'standard') })
      .toThrow(expect.objectContaining({ reason: 'wrong-operation' }))

    const proof = runtime.authorize('mount', 'standard')
    expect(() => { assertPresetAdmissionProofCurrent(proof, 'standard') })
      .toThrow(expect.objectContaining({ reason: 'not-generation' }))
    claimPresetAdmissionProof(proof, 'standard')
    expect(() => { assertPresetAdmissionProofCurrent(proof, 'standard') }).not.toThrow()
    expect(runtime.isCurrentGeneration(proof, 'standard')).toBe(true)
    expect(runtime.isCurrentGeneration(fakeProof(), 'standard')).toBe(false)
  })

  it('rejects stale, spent, and operation-mismatched authority', () => {
    const runtime = new PresetAdmissionRuntime()
    const wrongOperation = runtime.authorize('mount', 'standard')
    expect(() => { runtime.assertIssued(wrongOperation, 'recompose', 'standard') })
      .toThrow(expect.objectContaining({ reason: 'wrong-operation' }))

    const spent = runtime.authorize('resolve', 'standard')
    runtime.consume(spent, 'resolve', 'standard')
    expect(() => { runtime.assertIssued(spent, 'resolve', 'standard') })
      .toThrow(expect.objectContaining({ reason: 'not-issued' }))
    expect(() => { runtime.assertCurrentGeneration(spent, 'standard') })
      .toThrow(expect.objectContaining({ reason: 'not-generation' }))
    runtime.retire(spent)

    const stale = runtime.authorize('mount', 'standard')
    const dispose = runtime.register({ admit: () => undefined })
    expect(() => { runtime.assertIssued(stale, 'mount', 'standard') })
      .toThrow(expect.objectContaining({ reason: 'stale-policy' }))
    expect(() => { assertPresetAdmissionProofCurrent(stale, 'standard') })
      .toThrow(PresetAdmissionProofError)
    expect(runtime.isCurrentGeneration(stale, 'standard')).toBe(false)
    dispose()
    dispose()
  })

  it('retires only this runtime\'s still-issued proofs', () => {
    const owner = new PresetAdmissionRuntime()
    const other = new PresetAdmissionRuntime()
    const proof = owner.authorize('mount', 'standard')

    other.retire(proof)
    owner.assertIssued(proof, 'mount', 'standard')
    owner.retire(fakeProof())
    owner.retire(proof)
    expect(() => { owner.assertIssued(proof, 'mount', 'standard') })
      .toThrow(expect.objectContaining({ reason: 'not-issued' }))
  })
})
