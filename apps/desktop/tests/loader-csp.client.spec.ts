import { describe, expect, it, vi } from 'vitest'

const csp = vi.hoisted(() => {
  const original = globalThis.Function
  const observed = { calls: 0 }
  globalThis.Function = new Proxy(original, {
    apply() {
      observed.calls += 1
      throw new EvalError('string evaluation is disabled')
    },
    construct() {
      observed.calls += 1
      throw new EvalError('string evaluation is disabled')
    },
  })
  return { observed, original }
})

import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

globalThis.Function = csp.original

describe('desktop Loader CSP compatibility', () => {
  it('imports Loader without constructing the !!js expression evaluator', () => {
    expect(csp.observed.calls).toBe(0)
    expect(typeof evaluate).toBe('function')
  })
})
