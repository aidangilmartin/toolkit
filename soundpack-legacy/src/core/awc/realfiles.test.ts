/**
 * Optional check against real sound banks. Point AWC_SAMPLES_DIR at a folder of .awc files
 * (e.g. exported from your own GTA V install or an existing pack) to run it. Game files are
 * never committed to this repository.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAwc } from './read'
import { decodeStreamPcm, replaceStreamAudio } from './replace'
import { AwcFile, getFormat } from './types'
import { writeAwc } from './write'

const dir = process.env.AWC_SAMPLES_DIR

/** Cheap structural comparison; deep-equal on megabytes of typed arrays is too slow. */
function fingerprint(file: AwcFile): string[] {
  return file.streams.map((s) =>
    [
      s.id,
      ...s.chunks.map((c) => {
        switch (c.kind) {
          case 'format':
            return JSON.stringify(c.format)
          case 'markers':
            return JSON.stringify(c.markers)
          case 'peak':
            return Array.from(c.values).join(',')
          default:
            return `${c.tag}:${createHash('sha1').update(c.bytes).digest('hex')}`
        }
      })
    ].join('|')
  )
}
const files = dir ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.awc')) : []

describe.skipIf(!dir)('real .awc files', () => {
  for (const name of files) {
    it(`round-trips ${name}`, () => {
      const bytes = new Uint8Array(readFileSync(join(dir!, name)))
      const parsed = parseAwc(bytes)
      const written = writeAwc(parsed)
      const reparsed = parseAwc(written)
      expect(fingerprint(reparsed)).toEqual(fingerprint(parsed))
      const hasMarkers = parsed.streams.some((s) => s.chunks.some((c) => c.kind === 'markers'))
      if (!hasMarkers) expect(Buffer.compare(Buffer.from(written), Buffer.from(bytes))).toBe(0)
    })

    it(`replaces a stream in ${name}`, () => {
      const parsed = parseAwc(new Uint8Array(readFileSync(join(dir!, name))))
      const target = parsed.streams.find((s) => getFormat(s))!
      const pcm = new Int16Array(30000).map((_, i) => Math.round(Math.sin(i / 10) * 10000))
      const streams = parsed.streams.map((s) => (s === target ? replaceStreamAudio(s, pcm, 44100) : s))
      const out = parseAwc(writeAwc({ ...parsed, streams }))
      const got = out.streams.find((s) => s.id === target.id)!
      expect(getFormat(got)!.samples).toBe(30000)
      expect(Array.from(decodeStreamPcm(got).pcm.slice(0, 50))).toEqual(Array.from(pcm.slice(0, 50)))
      expect(out.streams.length).toBe(parsed.streams.length)
    })
  }
})
