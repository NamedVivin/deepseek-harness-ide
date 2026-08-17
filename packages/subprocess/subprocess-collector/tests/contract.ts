import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { collectReadable, OutputCollector } from '@deepseek-ai/dsh-subprocess-collector'

/**
 * Run the shared collected-output behavior required by subprocess providers.
 * @param spillDir - private test directory for provisional and finalized spills.
 */
export function runOutputCollectorContract(spillDir: () => string): void {
  describe('provider collector contract', () => {
    it('keeps an exact byte tail and independent whole-stream offsets', () => {
      const collector = new OutputCollector({ maxBytes: 10, label: 'stdout', spillDir: spillDir() })
      collector.push(Buffer.from('aaaa'))
      const first = collector.readFrom(0)
      expect(first).toEqual({ text: 'aaaa', nextOffset: 4, lossy: false })
      expect(collector.size).toBe(4)
      expect(collector.truncated).toBe(false)
      collector.push(Buffer.alloc(0))

      collector.push(Buffer.from('bbbbbb'))
      const second = collector.readFrom(first.nextOffset)
      expect(second).toEqual({ text: 'bbbbbb', nextOffset: 10, lossy: false })

      collector.push(Buffer.from('cc'))
      expect(collector.readFrom(second.nextOffset)).toEqual({ text: 'cc', nextOffset: 12, lossy: false })
      expect(collector.readFrom(0)).toEqual({ text: 'aabbbbbbcc', nextOffset: 12, lossy: true })
      expect(collector.truncated).toBe(true)
      expect(collector.readFrom(99)).toEqual({ text: '', nextOffset: 12, lossy: false })
      expect(collector.finalize()).toEqual({ text: 'aabbbbbbcc', truncated: true })
    })

    it('keeps a spill provisional until clean finalization', () => {
      const collector = new OutputCollector({
        maxBytes: 4,
        maxSpillBytes: 100,
        label: 'stdout',
        spillDir: spillDir(),
      })
      collector.push(Buffer.from('abcd'))
      collector.push(Buffer.from('efgh'))
      const provisional = collector.provisionalSpillPath
      expect(provisional).toBeDefined()
      expect(readFileSync(provisional!, 'utf8')).toBe('abcdefgh')
      expect(collector.readFrom(0)).toEqual({ text: 'efgh', nextOffset: 8, lossy: true })

      expect(collector.finalize()).toEqual({ text: 'efgh', truncated: true, spillPath: provisional })
      expect(collector.readFrom(0)).toEqual({
        text: 'efgh',
        nextOffset: 8,
        lossy: true,
        spillPath: provisional,
      })
      expect(collector.provisionalSpillPath).toBeUndefined()
      expect(collector.finalize()).toEqual({ text: 'efgh', truncated: true, spillPath: provisional })
      expect(() => { collector.push(Buffer.from('late')) }).toThrow('after finalization')
    })

    it('withholds and removes an incomplete spill while preserving the tail', () => {
      const collector = new OutputCollector({
        maxBytes: 4,
        maxSpillBytes: 100,
        label: 'stderr',
        spillDir: spillDir(),
      })
      collector.push(Buffer.from('abcdefgh'))
      const provisional = collector.provisionalSpillPath!

      expect(collector.fail()).toEqual({ text: 'efgh', truncated: true })
      expect(collector.readFrom(0)).toEqual({ text: 'efgh', nextOffset: 8, lossy: true })
      expect(() => readFileSync(provisional)).toThrow()
      expect(collector.fail()).toEqual({ text: 'efgh', truncated: true })
    })

    it('drops a spill as soon as the complete stream exceeds its cap', () => {
      const collector = new OutputCollector({
        maxBytes: 4,
        maxSpillBytes: 8,
        label: 'stdout',
        spillDir: spillDir(),
      })
      collector.push(Buffer.from('aaaa'))
      collector.push(Buffer.from('bbbb'))
      const provisional = collector.provisionalSpillPath!
      collector.push(Buffer.from('c'))

      expect(collector.provisionalSpillPath).toBeUndefined()
      expect(collector.finalize()).toEqual({ text: 'bbbc', truncated: true })
      expect(() => readFileSync(provisional)).toThrow()
    })

    it('copies transport chunks and validates limits, labels, and offsets', () => {
      const collector = new OutputCollector({ maxBytes: 4, label: 'stdout', spillDir: spillDir() })
      const chunk = Buffer.from('abcd')
      collector.push(chunk)
      chunk.fill(0)
      expect(collector.readFrom(0).text).toBe('abcd')
      expect(() => collector.readFrom(-1)).toThrow('non-negative safe integer')
      expect(() => collector.readFrom(0.5)).toThrow('non-negative safe integer')
      expect(() => new OutputCollector({ maxBytes: 0, label: 'stdout' })).toThrow('positive safe integer')
      expect(() => new OutputCollector({ maxBytes: 1, maxSpillBytes: 0, label: 'stdout' })).toThrow('positive safe integer')
      expect(() => new OutputCollector({ maxBytes: 1, label: '../escape' })).toThrow('label')
    })

    it('drains a readable through clean EOF before publishing its spill', async () => {
      const stream = new PassThrough()
      const collected = collectReadable(stream, {
        maxBytes: 4,
        maxSpillBytes: 100,
        label: 'stdout',
        spillDir: spillDir(),
      })
      stream.write('abcd')
      stream.end('efgh')

      await expect(collected.drain()).resolves.toBe(true)
      const read = collected.reader.readFrom(0)
      expect(read.text).toBe('efgh')
      expect(read.lossy).toBe(true)
      expect(read.spillPath).toBeDefined()
      expect(readFileSync(read.spillPath!, 'utf8')).toBe('abcdefgh')
    })

    it('bounds drain by invalidating the spill and stopping the stream', async () => {
      const stream = new PassThrough()
      const collected = collectReadable(stream, {
        maxBytes: 4,
        maxSpillBytes: 100,
        label: 'stdout',
        spillDir: spillDir(),
      })
      stream.write('abcdefgh')
      const provisional = collected.collector.provisionalSpillPath!
      const controller = new AbortController()
      const draining = collected.drain(controller.signal)
      controller.abort(new Error('drain deadline'))

      await expect(draining).resolves.toBe(false)
      expect(stream.destroyed).toBe(true)
      expect(collected.reader.readFrom(0)).toEqual({ text: 'efgh', nextOffset: 8, lossy: true })
      expect(() => readFileSync(provisional)).toThrow()
    })

    it('rejects drain when the readable closes before clean EOF', async () => {
      const stream = new PassThrough()
      const collected = collectReadable(stream, { maxBytes: 4, label: 'stderr', spillDir: spillDir() })
      stream.destroy()
      await expect(collected.drained).rejects.toThrow('before clean EOF')
    })
  })
}
