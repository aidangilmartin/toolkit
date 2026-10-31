import { describe, expect, it } from 'vitest'
import { DEFAULT_SHAPE } from './dsp'
import {
  assignAcross,
  assignSource,
  clearAcross,
  findAssignment,
  silenceAcross,
  updateShapeAcross,
  clearStreams,
  findBank,
  linkPair,
  newProject,
  parseProject,
  serializeProject,
  setChannel,
  silenceStreams,
  unusedSources,
  updateShape
} from './project'

const mono = { id: 'a', fileName: 'a.wav', channels: 1, sampleRate: 48000, durationMs: 500 }
const stereo = { id: 'b', fileName: 'b.wav', channels: 2, sampleRate: 48000, durationMs: 500 }
const P = 'weapons_player'
const F = 'ptl_pistol.awc'

describe('project', () => {
  it('assigns, silences and clears streams', () => {
    let p = assignSource(newProject(), P, F, [3, 1], mono, DEFAULT_SHAPE, [])
    expect(findBank(p, P, F)!.assignments.map((a) => [a.streamId, a.sourceId])).toEqual([
      [1, 'a'],
      [3, 'a']
    ])
    p = silenceStreams(p, P, F, [3])
    expect(findBank(p, P, F)!.assignments.find((a) => a.streamId === 3)!.action).toBe('silence')
    p = clearStreams(p, P, F, [1, 3])
    expect(findBank(p, P, F)).toBeUndefined()
  })

  it('splits a stereo source over an L/R pair when both sides are selected', () => {
    const pairs = [{ left: 10, right: 11 }]
    const p = assignSource(newProject(), P, F, [10, 11, 20], stereo, DEFAULT_SHAPE, pairs)
    const a = findBank(p, P, F)!.assignments
    expect(a.map((x) => [x.streamId, x.shape.channel])).toEqual([
      [10, 'left'],
      [11, 'right'],
      [20, 'mix']
    ])
  })

  it('changes exactly the selected streams, never the other side of a pair', () => {
    const pairs = [{ left: 10, right: 11 }]
    const p = assignSource(newProject(), P, F, [11, 20], stereo, DEFAULT_SHAPE, pairs)
    const a = findBank(p, P, F)!.assignments
    // one side selected: it takes its own channel of the stereo file; the left stream stays original
    expect(a.map((x) => [x.streamId, x.shape.channel])).toEqual([
      [11, 'right'],
      [20, 'mix']
    ])
    const one = assignSource(newProject(), P, F, [10], stereo, DEFAULT_SHAPE, pairs)
    expect(findBank(one, P, F)!.assignments.map((x) => x.streamId)).toEqual([10])
  })

  it('keeps assigned channels when shaping is updated', () => {
    let p = assignSource(newProject(), P, F, [10, 11], stereo, DEFAULT_SHAPE, [{ left: 10, right: 11 }])
    p = updateShape(p, P, F, [10, 11], { gainDb: -3, channel: 'mix' })
    const a = findBank(p, P, F)!.assignments
    expect(a.every((x) => x.shape.gainDb === -3)).toBe(true)
    expect(a.map((x) => x.shape.channel)).toEqual(['left', 'right'])
    p = setChannel(p, P, F, 10, 'mix')
    expect(findBank(p, P, F)!.assignments[0].shape.channel).toBe('mix')
  })

  it('links pairs by hand and round-trips through JSON', () => {
    let p = linkPair(newProject(), P, F, 1, 2)
    p = linkPair(p, P, F, 2, 3)
    expect(findBank(p, P, F)!.manualPairs).toEqual([{ left: 2, right: 3 }])
    p = { ...p, sources: [mono, stereo] }
    p = assignSource(p, P, F, [5], mono, { ...DEFAULT_SHAPE, gainDb: 2 }, [])
    const back = parseProject(serializeProject(p))
    expect(back).toEqual(p)
    expect(unusedSources(back).map((s) => s.id)).toEqual(['b'])
  })

  it('fills in defaults and rejects garbage', () => {
    const json = JSON.stringify({ version: 1, banks: [{ pack: P, file: F, assignments: [{ streamId: 1, action: 'silence', shape: {} }] }] })
    const p = parseProject(json)
    expect(p.banks[0].assignments[0].shape).toEqual(DEFAULT_SHAPE)
    expect(p.resourceName).toBe('my_gunpack')
    expect(() => parseProject('{}')).toThrow()
    expect(() => parseProject(JSON.stringify({ version: 99, banks: [] }))).toThrow(/newer/)
  })
})

describe('cross-bank helpers', () => {
  it('assigns, shapes, silences and clears streams in several banks at once', () => {
    const targets = [
      { pack: 'weapons_player', file: 'ptl_pistol.awc', streamId: 1 },
      { pack: 'weapons_player', file: 'ptl_pistol.awc', streamId: 2 },
      { pack: 'resident', file: 'weapons.awc', streamId: 1 }
    ]
    let p = assignAcross(newProject(), targets, mono, DEFAULT_SHAPE)
    expect(p.banks.map((b) => [b.pack, b.assignments.length])).toEqual([
      ['weapons_player', 2],
      ['resident', 1]
    ])
    p = updateShapeAcross(p, targets, { gainDb: -6 })
    expect(findAssignment(p, targets[2])!.shape.gainDb).toBe(-6)
    p = silenceAcross(p, [targets[0]])
    expect(findAssignment(p, targets[0])!.action).toBe('silence')
    p = clearAcross(p, targets)
    expect(p.banks).toEqual([])
  })
})
