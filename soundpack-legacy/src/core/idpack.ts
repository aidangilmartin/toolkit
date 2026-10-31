/**
 * The in-game ID pack: every sound in the chosen banks is replaced by its spoken code ("pistol 4"),
 * so playing the game tells you exactly which file plays when. Codes are stable: the same stream
 * always gets the same code, whatever is exported, and the app can look a code up again.
 */

import { replaceStreamAudio } from './awc/replace'
import { getFormat, type AwcFile } from './awc/types'
import { writeAwc } from './awc/write'
import { resample, toInt16 } from './dsp'
import { hex8 } from './hash'
import { mapNode, streamSummary, streamUsage, type SoundMap } from './usage'

/** Bank-name abbreviations spelled out so the voice says something recognisable. */
const WORDS: Record<string, string> = {
  ptl: 'pistol',
  rfl: 'rifle',
  smg: 'S M G',
  mg: 'M G',
  mgn: 'machine gun',
  sht: 'shotgun',
  sg: 'shotgun',
  snp: 'sniper',
  hvy: 'heavy',
  wpn: 'weapon',
  sml: 'small',
  lrg: 'large',
  med: 'medium',
  expl: 'explosion',
  amb: 'ambience',
  veh: 'vehicle',
  fx: 'effects',
  npc: 'N P C',
  dlc: 'D L C'
}

const LETTERS = 'BCDEFGHJKLMNPQRSTUVWXYZ'

/** "ptl_pistol.awc" → "pistol", "smg_micro.awc" → "S M G micro". At most three words. */
export function bankWords(file: string): string {
  const tokens = file
    .toLowerCase()
    .replace(/\.awc$/, '')
    .split(/[_\-\s.]+/)
    .filter(Boolean)
    .map((t) => WORDS[t] ?? t.replace(/([a-z])(\d)/g, '$1 $2'))
  const out: string[] = []
  for (const t of tokens) if (!out.includes(t)) out.push(t)
  return out.slice(0, 3).join(' ') || 'bank'
}

export interface IdCode {
  /** "pack/bank.awc" */
  bank: string
  id: number
  /** 1-based position of the stream in its bank (the "#" column). */
  index: number
  words: string
  code: string
}

export interface IdCodes {
  byStream: Map<string, IdCode>
  byCode: Map<string, IdCode>
  bankWords: Map<string, string>
}

const streamKey = (bank: string, id: number): string => `${bank.toLowerCase()}:${id >>> 0}`

/** The spoken code of every stream in the map. Bank words collide rarely; later banks get a letter. */
export function idCodes(map: SoundMap): IdCodes {
  const byStream = new Map<string, IdCode>()
  const byCode = new Map<string, IdCode>()
  const words = new Map<string, string>()
  const taken = new Set<string>()
  for (const bank of Object.keys(map.banks).sort()) {
    const base = bankWords(bank.split('/')[1] ?? bank)
    let w = base
    for (let i = 0; taken.has(w); i++)
      w = `${base} ${LETTERS[i % LETTERS.length]}${i >= LETTERS.length ? Math.floor(i / LETTERS.length) : ''}`
    taken.add(w)
    words.set(bank, w)
    map.banks[bank].streams.forEach((s, i) => {
      const c: IdCode = { bank, id: s.id, index: i + 1, words: w, code: `${w} ${i + 1}` }
      byStream.set(streamKey(bank, s.id), c)
      byCode.set(normalizeCode(c.code), c)
    })
  }
  return { byStream, byCode, bankWords: words }
}

export function codeOf(codes: IdCodes, bank: string, id: number): IdCode | undefined {
  return codes.byStream.get(streamKey(bank, id))
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty'
]

/** Lower case, single spaces, spelled-out numbers up to twenty as digits, spaced-out letters joined back. */
export function normalizeCode(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (NUMBER_WORDS.includes(t) ? String(NUMBER_WORDS.indexOf(t)) : t))
    .join(' ')
    .replace(/\b([a-z]) (?=[a-z]\b)/g, '$1')
}

/** The stream behind a code someone heard ("pistol 4", "Pistol four"). */
export function findByCode(codes: IdCodes, text: string): IdCode | undefined {
  const n = normalizeCode(text)
  if (!n) return undefined
  const exact = codes.byCode.get(n)
  if (exact) return exact
  // tolerate a missing or extra word in front of the number ("player pistol 4")
  const num = n.match(/(\d+)$/)?.[1]
  if (!num) return undefined
  const words = n.slice(0, -num.length).trim()
  const hits = [...codes.byCode.values()].filter(
    (c) => String(c.index) === num && (normalizeCode(c.words).endsWith(words) || words.endsWith(normalizeCode(c.words)))
  )
  return hits.length === 1 ? hits[0] : undefined
}

/** Whether a stream can carry a label: plain waves in readable, single-channel banks. */
export function idEligible(map: SoundMap, bank: string, id: number): boolean {
  const b = map.banks[bank]
  const s = b?.streams.find((x) => x.id === id)
  return !!b && !b.mc && !b.error && !!s && !s.kind
}

/**
 * For the right channel of a stereo pair whose left channel is in the same bank, the left one: both
 * play at once, so the pair speaks one code (the left's) instead of two at the same time.
 */
export function stereoLeft(map: SoundMap, bank: string, id: number): number | undefined {
  const s = map.banks[bank]?.streams.find((x) => x.id === id)
  const container = s?.leaves[0] && mapNode(map, s.leaves[0][0])?.simple?.container
  for (const [leaf] of s?.leaves ?? []) {
    for (const [parent, slot] of mapNode(map, leaf)?.parents ?? []) {
      const p = mapNode(map, parent)
      if (p?.type !== 'CollapsingStereoSound' || slot !== 1) continue
      const left = mapNode(map, p.children?.[0] ?? 0)?.simple
      if (left && left.container === container && left.file !== id && map.banks[bank].streams.some((x) => x.id === left.file))
        return left.file
    }
  }
  return undefined
}

/**
 * Layers of a multitrack sound play together; their labels would talk over each other, so later
 * layers start a little later. Returns the lead-in in seconds (0, 0.7 or 1.4).
 */
export function layerDelay(map: SoundMap, bank: string, id: number): number {
  const [pack, file] = bank.split('/')
  for (const use of streamUsage(map, pack, file, id, 8).uses) {
    for (const step of use.via) {
      const n = mapNode(map, step.node)
      if (n?.type === 'MultitrackSound' && (n.children?.length ?? 0) > 1) return Math.min(step.slot, 2) * 0.7
    }
  }
  return 0
}

export interface Clip {
  samples: Float32Array
  rate: number
}

/** Joins clips (all at `rate`) with short gaps, after `lead` seconds of silence, peaking at −1 dBFS. */
export function composeClip(parts: Float32Array[], rate: number, lead = 0, gap = 0.12): Float32Array {
  const gapN = Math.round(gap * rate)
  const leadN = Math.round(lead * rate)
  const len = leadN + parts.reduce((a, p) => a + p.length, 0) + gapN * Math.max(0, parts.length - 1)
  const out = new Float32Array(Math.max(1, len))
  let pos = leadN
  parts.forEach((p, i) => {
    out.set(p, pos)
    pos += p.length + (i < parts.length - 1 ? gapN : 0)
  })
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  if (peak > 0) {
    const g = 0.891 / peak
    for (let i = 0; i < out.length; i++) out[i] *= g
  }
  return out
}

/**
 * Beeps for a number, when no voice is available: each digit is that many short beeps (zero is one
 * long beep), digits separated by a pause; the pitch tells banks apart.
 */
export function toneClip(n: number, rate: number, pitch = 880): Float32Array {
  const out: number[] = []
  const tone = (sec: number): void => {
    const len = Math.round(sec * rate)
    for (let i = 0; i < len; i++) {
      const env = Math.min(1, i / (0.005 * rate), (len - i) / (0.005 * rate))
      out.push(0.8 * env * Math.sin((2 * Math.PI * pitch * i) / rate))
    }
  }
  const silence = (sec: number): void => {
    for (let i = Math.round(sec * rate); i > 0; i--) out.push(0)
  }
  for (const d of String(Math.max(0, Math.floor(n)))) {
    if (d === '0') tone(0.3)
    else
      for (let k = 0; k < Number(d); k++) {
        tone(0.06)
        silence(0.06)
      }
    silence(0.25)
  }
  return Float32Array.from(out)
}

/** A stable tone pitch per bank for the beep fallback. */
export function bankPitch(words: string): number {
  let h = 0
  for (const ch of words) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return 500 + (h % 9) * 100
}

export interface IdBankResult {
  bytes: Uint8Array
  replaced: number
  /** Sample rate the labels were stored at (lower when the bank had to stay small). */
  rate: number
  /** True when even the lowest rate made the bank bigger than the original. */
  overBudget: boolean
}

const ID_RATES = [16000, 11025, 8000]

/**
 * Rebuilds a bank with every eligible stream replaced by its label (ADPCM). Labels are stored at the
 * highest rate that keeps the bank no larger than the original, so it still fits the game's memory
 * slot for it. `label(id, rate)` returns the stream's label at that rate, or null to leave it as is.
 */
export function buildIdBank(awc: AwcFile, originalSize: number, label: (id: number, rate: number) => Float32Array | null): IdBankResult {
  let last: IdBankResult | null = null
  for (const rate of ID_RATES) {
    let replaced = 0
    const streams = awc.streams.map((s) => {
      const fmt = getFormat(s)
      const x = fmt ? label(s.id, rate) : null
      if (!x) return s
      replaced++
      return replaceStreamAudio(s, toInt16(x).pcm, rate, { codec: 'adpcm', headroom: 0 })
    })
    const bytes = writeAwc({ ...awc, streams })
    last = { bytes, replaced, rate, overBudget: bytes.length > originalSize }
    if (!last.overBudget) return last
  }
  return last!
}

/** Resamples once per rate and caches it: speech parts are shared by many labels. */
export function clipCache(parts: Map<string, Clip>): (key: string, rate: number) => Float32Array | null {
  const cache = new Map<string, Float32Array>()
  return (key, rate) => {
    const k = `${key}@${rate}`
    const hit = cache.get(k)
    if (hit) return hit
    const p = parts.get(key)
    if (!p) return null
    const r = resample(p.samples, p.rate, rate)
    cache.set(k, r)
    return r
  }
}

/** ID-LEGEND.txt: every code in the exported banks and what the game data says it is. */
export function idLegend(map: SoundMap, codes: IdCodes, banks: string[], voice: string | null): string {
  const lines = [
    'Sound ID pack: legend',
    '',
    voice
      ? `Every sound in these banks says its code (voice: ${voice}). Look a code up here or in the app ("What did I hear?").`
      : 'No voice was available, so every sound beeps its number instead: each digit is that many beeps (a long beep is 0).',
    "Stereo pairs say the left channel's code; later layers of a sound start a moment later so they don't talk over each other.",
    ''
  ]
  for (const bank of banks) {
    const b = map.banks[bank]
    if (!b) continue
    const [pack, file] = bank.split('/')
    lines.push(`${b.archive} / ${file}  ("${codes.bankWords.get(bank) ?? ''}")`)
    for (const s of b.streams) {
      const c = codeOf(codes, bank, s.id)
      if (!c) continue
      const u = streamUsage(map, pack, file, s.id, 16)
      const left = stereoLeft(map, bank, s.id)
      const said = left !== undefined ? ` (says "${codeOf(codes, bank, left)?.code}", right channel of it)` : ''
      const skipped = idEligible(map, bank, s.id) ? '' : ' [not replaced]'
      lines.push(`  ${c.code.padEnd(24)} 0x${hex8(s.id)}${said}${skipped}`)
      const summary = streamSummary(u)
      if (summary) lines.push(`      ${summary}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
