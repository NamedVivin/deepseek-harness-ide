/** Security constants and pure URL checks for the Electron renderer. */

/** Only document the desktop BrowserWindow may load. */
export const DESKTOP_DOCUMENT_URL = 'dsh-app://shell/index.html'

/** Restrictive policy for the packaged shell and signed Client bundles. */
export const DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self' dsh-app:",
  "style-src 'self' 'unsafe-inline' dsh-app:",
  "img-src 'self' data: blob: dsh-app:",
  "font-src 'self' data: dsh-app:",
  "worker-src 'self' blob: dsh-app:",
  "connect-src 'none'",
].join('; ')

/**
 * Test whether an IPC sender is the one signed application document.
 * @param value - sender-frame URL supplied by Electron.
 * @returns true only for the exact shell document.
 */
export function isTrustedDesktopSender(value: string): boolean {
  return value === DESKTOP_DOCUMENT_URL
}

/**
 * Test whether a top-level navigation may proceed.
 * @param value - target URL.
 * @returns true only for the initial packaged document.
 */
export function isAllowedDesktopNavigation(value: string): boolean {
  return value === DESKTOP_DOCUMENT_URL
}

/**
 * Assert an IPC sender before reading its payload.
 * @param value - sender-frame URL supplied by Electron.
 * @throws when the sender is not the signed shell document.
 */
export function assertTrustedDesktopSender(value: string): void {
  if (!isTrustedDesktopSender(value)) {
    throw new Error(`desktop IPC rejected sender ${JSON.stringify(value)}`)
  }
}
