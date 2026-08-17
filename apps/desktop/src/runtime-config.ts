/** Signed desktop runtime lifecycle and bounded-transport configuration. */

/** Bounded supervisor timings loaded from the packaged configuration. */
export interface DesktopRuntimeConfig {
  readonly version: 1
  readonly startupTimeoutMs: number
  readonly gracefulShutdownMs: number
  readonly forceShutdownMs: number
  readonly squirrelTimeoutMs: number
  readonly nativeProcessPollMs: number
  readonly mirrorTimeoutMs: number
  readonly maxDesktopBodyBytes: number
  readonly maxDesktopChunkBytes: number
  readonly maxDesktopInflightBytes: number
}

const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 5 * 60 * 1000

type TimeoutName =
  | 'startupTimeoutMs'
  | 'gracefulShutdownMs'
  | 'forceShutdownMs'
  | 'squirrelTimeoutMs'
  | 'nativeProcessPollMs'
  | 'mirrorTimeoutMs'

function parseTimeout(record: Record<string, unknown>, name: TimeoutName): number {
  const value = record[name]
  if (!Number.isSafeInteger(value) || (value as number) < MIN_TIMEOUT_MS || (value as number) > MAX_TIMEOUT_MS) {
    throw new Error(`desktop runtime: ${name} must be an integer from ${String(MIN_TIMEOUT_MS)} to ${String(MAX_TIMEOUT_MS)}`)
  }
  return value as number
}

function parseByteLimit(
  record: Record<string, unknown>,
  name: 'maxDesktopBodyBytes' | 'maxDesktopChunkBytes' | 'maxDesktopInflightBytes',
): number {
  const value = record[name]
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`desktop runtime: ${name} must be a positive safe integer`)
  }
  return value as number
}

/**
 * Parse the signed runtime lifecycle configuration.
 * @param value - parsed JSON from the application resources.
 * @returns validated timeout values.
 */
export function parseDesktopRuntimeConfig(value: unknown): DesktopRuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop runtime: configuration must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('desktop runtime: configuration version must be 1')
  const allowed = new Set([
    'version',
    'startupTimeoutMs',
    'gracefulShutdownMs',
    'forceShutdownMs',
    'squirrelTimeoutMs',
    'nativeProcessPollMs',
    'mirrorTimeoutMs',
    'maxDesktopBodyBytes',
    'maxDesktopChunkBytes',
    'maxDesktopInflightBytes',
  ])
  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new Error('desktop runtime: configuration has an unknown field')
  }
  const config: DesktopRuntimeConfig = {
    version: 1,
    startupTimeoutMs: parseTimeout(record, 'startupTimeoutMs'),
    gracefulShutdownMs: parseTimeout(record, 'gracefulShutdownMs'),
    forceShutdownMs: parseTimeout(record, 'forceShutdownMs'),
    squirrelTimeoutMs: parseTimeout(record, 'squirrelTimeoutMs'),
    nativeProcessPollMs: parseTimeout(record, 'nativeProcessPollMs'),
    mirrorTimeoutMs: parseTimeout(record, 'mirrorTimeoutMs'),
    maxDesktopBodyBytes: parseByteLimit(record, 'maxDesktopBodyBytes'),
    maxDesktopChunkBytes: parseByteLimit(record, 'maxDesktopChunkBytes'),
    maxDesktopInflightBytes: parseByteLimit(record, 'maxDesktopInflightBytes'),
  }
  if (config.maxDesktopChunkBytes > config.maxDesktopInflightBytes) {
    throw new Error('desktop runtime: maxDesktopChunkBytes cannot exceed maxDesktopInflightBytes')
  }
  if (config.maxDesktopInflightBytes > config.maxDesktopBodyBytes) {
    throw new Error('desktop runtime: maxDesktopInflightBytes cannot exceed maxDesktopBodyBytes')
  }
  return config
}
