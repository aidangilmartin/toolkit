/** Jenkins one-at-a-time hash as used by RAGE ("joaat"); input is lower-cased first. */
export function joaat(input: string): number {
  const s = input.toLowerCase()
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) >>> 0
    h = (h + (h << 10)) >>> 0
    h = (h ^ (h >>> 6)) >>> 0
  }
  h = (h + (h << 3)) >>> 0
  h = (h ^ (h >>> 11)) >>> 0
  h = (h + (h << 15)) >>> 0
  return h
}

/** AWC stream ids keep only the low 29 bits of the name hash. */
export function awcStreamId(name: string): number {
  return joaat(name) & 0x1fffffff
}

export function hex8(n: number): string {
  return (n >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/**
 * Parses a CodeWalker-style hash reference: "hash_1B06D571", "0x1B06D571", or a plain
 * name that gets hashed.
 */
export function parseHashRef(text: string): number {
  const t = text.trim()
  const m = /^(?:hash_|0x)([0-9a-f]{1,8})$/i.exec(t)
  if (m) return parseInt(m[1], 16) >>> 0
  return joaat(t)
}
