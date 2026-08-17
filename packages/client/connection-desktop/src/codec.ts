/** Browser-safe validators for decoded desktop Connection bodies. */

import { serverRequestSchema, type ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

/**
 * Validate a renderer downlink event before preload delivery.
 * @param value - decoded but untrusted event body.
 * @returns validated server-request envelope.
 */
export function parseDesktopServerRequest(value: unknown): ServerRequest {
  return serverRequestSchema.parse(value)
}
