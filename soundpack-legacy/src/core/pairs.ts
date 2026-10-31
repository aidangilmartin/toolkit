import { awcStreamId } from './hash'

/** Two mono streams the game plays as the left and right side of one stereo sound. */
export interface StreamPair {
  left: number
  right: number
}

const SUFFIXES: [string, string][] = [
  ['_left', '_right'],
  ['_l', '_r'],
  ['_lt', '_rt']
]

/**
 * Finds L/R pairs from known stream names, plus CodeWalker's "<bank>_left"/"<bank>_right"
 * convention, which can be matched by hash even when names are unknown.
 */
export function detectPairs(ids: number[], names: Record<number, string>, bankFile?: string): StreamPair[] {
  const present = new Set(ids)
  const byName = new Map<string, number>()
  for (const id of ids) if (names[id]) byName.set(names[id].toLowerCase(), id)
  const pairs: StreamPair[] = []
  const used = new Set<number>()
  const add = (left: number, right: number): void => {
    if (left === right || used.has(left) || used.has(right)) return
    used.add(left)
    used.add(right)
    pairs.push({ left, right })
  }
  for (const [name, id] of byName) {
    for (const [l, r] of SUFFIXES) {
      if (!name.endsWith(l)) continue
      const other = name.slice(0, -l.length) + r
      const rightId = byName.get(other) ?? (present.has(awcStreamId(other)) ? awcStreamId(other) : undefined)
      if (rightId !== undefined) add(id, rightId)
    }
  }
  if (bankFile) {
    const base = bankFile.replace(/\.awc$/i, '').toLowerCase()
    const l = awcStreamId(`${base}_left`)
    const r = awcStreamId(`${base}_right`)
    if (present.has(l) && present.has(r)) add(l, r)
  }
  return pairs
}

export function pairOf(pairs: StreamPair[], id: number): { pair: StreamPair; side: 'left' | 'right' } | undefined {
  for (const pair of pairs) {
    if (pair.left === id) return { pair, side: 'left' }
    if (pair.right === id) return { pair, side: 'right' }
  }
  return undefined
}
