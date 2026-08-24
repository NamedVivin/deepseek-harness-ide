/** Bounded host-side projection of a complete output file retained in E2B. */

import { Buffer } from 'node:buffer'
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-collector'

const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/u

/** Reserved non-base64 frame proving that one remote encoder reached clean EOF. */
export const E2B_OUTPUT_COMPLETE_FRAME = '!dsh-e2b-output-complete!'

/** Incrementally decode newline-delimited base64 frames emitted by one remote encoder. */
export class E2BBase64Decoder {
  private pending = ''
  private complete = false

  /**
   * Decode every complete newline-delimited frame in one arbitrarily split SDK callback.
   * @param text - ASCII base64 frames from E2B's decoded callback.
   * @returns the complete raw bytes made available by this callback.
   */
  push(text: string): Buffer {
    if (text.length === 0) return Buffer.alloc(0)
    this.pending += text
    const decoded: Buffer[] = []
    for (;;) {
      const boundary = this.pending.indexOf('\n')
      if (boundary < 0) break
      const frame = this.pending.slice(0, boundary)
      this.pending = this.pending.slice(boundary + 1)
      if (frame === E2B_OUTPUT_COMPLETE_FRAME) {
        if (this.complete) throw new Error('subprocess-e2b: duplicate output transport completion')
        this.complete = true
        continue
      }
      if (this.complete) throw new Error('subprocess-e2b: output transport continued after completion')
      if (!BASE64_TEXT.test(frame)) {
        throw new Error('subprocess-e2b: invalid base64 output transport')
      }
      const bytes = Buffer.from(frame, 'base64')
      if (bytes.toString('base64') !== frame) {
        throw new Error('subprocess-e2b: invalid base64 output transport')
      }
      decoded.push(bytes)
    }
    return Buffer.concat(decoded)
  }

  /**
   * Validate clean encoder completion, or discard an interrupted trailing frame after requested termination.
   * @param requireComplete - Whether natural completion requires the reserved EOF frame.
   */
  finish(requireComplete = true): void {
    if (!requireComplete) {
      this.pending = ''
      return
    }
    if (this.pending.length > 0) {
      throw new Error('subprocess-e2b: truncated base64 output transport')
    }
    if (!this.complete) throw new Error('subprocess-e2b: incomplete output transport')
  }
}

/** Offset reader used for one collect-mode E2B stream. */
export class E2BOutputReader implements SubprocessOutputReader {
  private readonly tail: OutputCollector
  private spillValid = true

  /**
   * Create a bounded reader over one remote spill path.
   * @param maxBytes - In-memory tail cap.
   * @param maxSpillBytes - Maximum complete remote file size the caller accepts.
   * @param spillPath - Remote full-output path.
   */
  constructor(
    maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly spillPath: string,
  ) {
    this.tail = new OutputCollector({ maxBytes, label: 'e2b-output' })
  }

  /** Total bytes observed from the SDK stream. */
  get size(): number {
    return this.tail.size
  }

  /** Stop advertising a remote spill whose writer did not reach clean EOF. */
  invalidateSpill(): void {
    this.spillValid = false
  }

  /**
   * Append one byte-faithful decoded transport event.
   * @param bytes - Raw command bytes recovered from the ASCII SDK transport.
   */
  push(bytes: Uint8Array): void {
    this.tail.push(bytes)
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = this.tail.readFrom(fromByte)
    return {
      ...retained,
      ...(retained.lossy && this.spillValid && this.maxSpillBytes !== undefined && this.tail.size <= this.maxSpillBytes
        ? { spillPath: this.spillPath }
        : {}),
    }
  }
}
