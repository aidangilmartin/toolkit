import { describe, expect, it } from 'vitest'
import { curveIsExact, defaultDistanceAttenuation, evalCurve } from './curves'
import type { Curve } from './weapons'

const c = (type: string, params: Record<string, unknown> = {}): Curve => ({ type, minInput: 0, maxInput: 1, ...params }) as Curve

describe('evalCurve', () => {
  it('evaluates linear curves between their two points, flat outside', () => {
    const lin = c('LinearCurve', { maxInput: 100, leftHandPairX: 10, leftHandPairY: 1, rightHandPairX: 90, rightHandPairY: 0 })
    expect(evalCurve(lin, 0)).toBe(1)
    expect(evalCurve(lin, 50)).toBeCloseTo(0.5)
    expect(evalCurve(lin, 95)).toBe(0)
    // the dB variant interpolates in decibels: halfway between 1 and 0.01 is 0.1
    const db = c('LinearDbCurve', { maxInput: 100, leftHandPairX: 0, leftHandPairY: 1, rightHandPairX: 100, rightHandPairY: 0.01 })
    expect(evalCurve(db, 50)).toBeCloseTo(0.1)
  })

  it('evaluates piecewise and table curves', () => {
    const pw = c('PiecewiseLinearCurve', {
      maxInput: 10,
      points: [
        [0, 1],
        [5, 0.5],
        [10, 0]
      ]
    })
    expect(evalCurve(pw, 2.5)).toBeCloseTo(0.75)
    expect(evalCurve(pw, 7.5)).toBeCloseTo(0.25)
    const table = c('ValueTableCurve', { maxInput: 4, values: [0, 1, 0, 1, 0] })
    expect(evalCurve(table, 1)).toBe(1)
    expect(evalCurve(table, 1.5)).toBeCloseTo(0.5)
  })

  it('evaluates equal-power, exponential, constant and the decaying shapes', () => {
    expect(evalCurve(c('EqualPowerCurve'), 0.5)).toBeCloseTo(Math.SQRT1_2)
    expect(evalCurve(c('EqualPowerCurve', { flip: 1 }), 0)).toBeCloseTo(1)
    expect(evalCurve(c('ExponentialCurve', { exponent: 2 }), 0.5)).toBeCloseTo(0.25)
    expect(evalCurve(c('ConstantCurve', { value: 0.3 }), 0.9)).toBe(0.3)
    expect(evalCurve(c('DecayingExponentialCurve', { maxInput: 10, horizontalScaling: 1 }), 1)).toBeCloseTo(Math.exp(-1))
    expect(evalCurve(c('OneOverXSquaredCurve', { maxInput: 10, horizontalScaling: 1 }), 1)).toBeCloseTo(0.5)
  })

  it('uses an inverse-distance law for the engine default, and knows which shapes are exact', () => {
    expect(defaultDistanceAttenuation(0.5)).toBe(1)
    expect(defaultDistanceAttenuation(20)).toBeCloseTo(0.05)
    expect(evalCurve(c('DefaultDistanceAttenuationCurve', { maxInput: 1000 }), 10)).toBeCloseTo(0.1)
    expect(curveIsExact(c('LinearCurve'))).toBe(true)
    expect(curveIsExact(c('DefaultDistanceAttenuationCurve'))).toBe(false)
    expect(curveIsExact(undefined)).toBe(false)
  })
})
