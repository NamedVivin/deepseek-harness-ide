import { describe, expect, it } from 'vitest'
import {
  assertTrustedDesktopSender,
  DESKTOP_CONTENT_SECURITY_POLICY,
  DESKTOP_DOCUMENT_URL,
  isAllowedDesktopNavigation,
  isTrustedDesktopSender,
} from '../src/security.ts'

describe('desktop renderer security', () => {
  it('accepts only the exact signed shell document as sender and navigation', () => {
    expect(isTrustedDesktopSender(DESKTOP_DOCUMENT_URL)).toBe(true)
    expect(isAllowedDesktopNavigation(DESKTOP_DOCUMENT_URL)).toBe(true)
    for (const value of [
      'https://example.com/',
      'file:///tmp/index.html',
      'dsh-app://plugins/index.html',
      'dsh-app://shell/index.html?changed=1',
      'dsh-app://shell/index.html#fragment',
    ]) {
      expect(isTrustedDesktopSender(value)).toBe(false)
      expect(isAllowedDesktopNavigation(value)).toBe(false)
      expect(() => { assertTrustedDesktopSender(value) }).toThrow('rejected sender')
    }
  })

  it('keeps network, objects, forms, frames, and base replacement disabled', () => {
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'")
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("form-action 'none'")
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("base-uri 'none'")
    expect(DESKTOP_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'")
    expect(DESKTOP_CONTENT_SECURITY_POLICY).not.toMatch(/https?:/u)
  })
})
