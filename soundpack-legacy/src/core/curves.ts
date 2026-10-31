/**
 * The game's curves (dat16): distance attenuation, crossfade and envelope shapes. CodeWalker only
 * reads their parameters; the formulas here follow the curve type names and parameters. Types whose
 * exact shape isn't documented are flagged by `curveIsExact`.
 */

import type { Curve } from './weapons'

const num = (c: Curve, key: string, fallback = 0): number => (typeof c[key] === 'number' ? (c[key] as number) : fallback)
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Input clamped to the curve's range, and its 0..1 position in that range. */
function normalize(c: Curve, x: number): { x: number; t: number } {
  const lo = c.minInput
  const hi = c.maxInput > c.minInput ? c.maxInput : c.minInput + 1
  const cx = clamp(x, lo, hi)
  return { x: cx, t: (cx - lo) / (hi - lo) }
}

/** Linear interpolation through (x, y) points sorted by x, flat beyond the ends. */
function piecewise(points: [number, number][], x: number): number {
  if (points.length === 0) return 1
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x0, y0] = points[i - 1]
    if (x <= x1) return x1 > x0 ? lerp(y0, y1, (x - x0) / (x1 - x0)) : y1
  }
  return points[points.length - 1][1]
}

/** A table of values spread evenly over the input range. */
function table(values: number[], t: number): number {
  if (values.length === 0) return 1
  if (values.length === 1) return values[0]
  const p = t * (values.length - 1)
  const i = Math.min(values.length - 2, Math.floor(p))
  return lerp(values[i], values[i + 1], p - i)
}

const toDb = (v: number): number => 20 * Math.log10(Math.max(1e-5, v))
const fromDb = (db: number): number => Math.pow(10, db / 20)

/** The curve's value at x. */
export function evalCurve(c: Curve, input: number): number {
  const { x, t } = normalize(c, input)
  switch (c.type) {
    case 'ConstantCurve':
      return num(c, 'value', 1)
    case 'LinearCurve':
    case 'LinearDbCurve': {
      const lx = num(c, 'leftHandPairX')
      const rx = num(c, 'rightHandPairX', c.maxInput)
      const ly = num(c, 'leftHandPairY', 1)
      const ry = num(c, 'rightHandPairY')
      const u = rx > lx ? clamp((x - lx) / (rx - lx), 0, 1) : x >= rx ? 1 : 0
      // the Db variant interpolates in decibels
      return c.type === 'LinearDbCurve' ? fromDb(lerp(toDb(ly), toDb(ry), u)) : lerp(ly, ry, u)
    }
    case 'PiecewiseLinearCurve':
      return piecewise(
        ((c.points as number[][] | undefined) ?? []).map((p) => [p[0], p[1]] as [number, number]).sort((a, b) => a[0] - b[0]),
        x
      )
    case 'EqualPowerCurve': {
      const flip = num(c, 'flip') !== 0
      return flip ? Math.cos((t * Math.PI) / 2) : Math.sin((t * Math.PI) / 2)
    }
    case 'ValueTableCurve':
    case 'DistanceAttenuationValueTableCurve':
      return table((c.values as number[] | undefined) ?? [], t)
    case 'ExponentialCurve': {
      const e = num(c, 'exponent', 1)
      const y = Math.pow(t, e)
      return num(c, 'flip') !== 0 ? 1 - y : y
    }
    case 'DecayingExponentialCurve':
      return Math.exp(-x * num(c, 'horizontalScaling', 1))
    case 'DecayingSquaredExponentialCurve': {
      const s = x * num(c, 'horizontalScaling', 1)
      return Math.exp(-s * s)
    }
    case 'SineCurve': {
      const phase = lerp(num(c, 'startPhase'), num(c, 'endPhase', 1), t)
      return num(c, 'verticalScaling', 1) * Math.sin(2 * Math.PI * num(c, 'frequency', 1) * phase) + num(c, 'verticalOffset')
    }
    case 'OneOverXSquaredCurve': {
      const s = x * num(c, 'horizontalScaling', 1)
      return 1 / (1 + s * s)
    }
    case 'DefaultDistanceAttenuationCurve':
    default:
      return defaultDistanceAttenuation(x)
  }
}

/**
 * The engine's built-in distance roll-off isn't stored in the data; this inverse-distance law (unity
 * up to 1 m, −6 dB per doubling of distance) stands in for it.
 */
export function defaultDistanceAttenuation(metres: number): number {
  return 1 / Math.max(1, metres)
}

/** Curve types whose formula follows directly from the stored parameters. */
const EXACT = new Set(['ConstantCurve', 'LinearCurve', 'PiecewiseLinearCurve', 'ValueTableCurve', 'EqualPowerCurve'])

export function curveIsExact(c: Curve | undefined): boolean {
  return !!c && EXACT.has(c.type)
}
