import { DEFAULT_SHAPE, ShapeSettings } from './dsp'
import { pairOf, StreamPair } from './pairs'

export const PROJECT_VERSION = 1

export interface SourceInfo {
  id: string
  fileName: string
  channels: number
  sampleRate: number
  durationMs: number
}

export interface Assignment {
  streamId: number
  action: 'replace' | 'silence'
  sourceId?: string
  shape: ShapeSettings
}

export interface ProjectBank {
  pack: string
  file: string
  assignments: Assignment[]
  /** L/R links the user made by hand (detected pairs are recomputed from names). */
  manualPairs: StreamPair[]
}

export interface Project {
  version: number
  resourceName: string
  author: string
  description: string
  resourceVersion: string
  banks: ProjectBank[]
  sources: SourceInfo[]
}

export function newProject(): Project {
  return {
    version: PROJECT_VERSION,
    resourceName: 'my_gunpack',
    author: '',
    description: 'Custom gun sounds',
    resourceVersion: '1.0.0',
    banks: [],
    sources: []
  }
}

export const bankKey = (pack: string, file: string): string => `${pack}/${file}`.toLowerCase()

export function findBank(project: Project, pack: string, file: string): ProjectBank | undefined {
  const key = bankKey(pack, file)
  return project.banks.find((b) => bankKey(b.pack, b.file) === key)
}

function updateBank(project: Project, pack: string, file: string, fn: (b: ProjectBank) => ProjectBank): Project {
  const existing = findBank(project, pack, file) ?? { pack, file, assignments: [], manualPairs: [] }
  const next = fn(existing)
  const others = project.banks.filter((b) => b !== existing && bankKey(b.pack, b.file) !== bankKey(pack, file))
  const keep = next.assignments.length > 0 || next.manualPairs.length > 0
  return { ...project, banks: keep ? [...others, next] : others }
}

function upsert(list: Assignment[], items: Assignment[]): Assignment[] {
  const ids = new Set(items.map((a) => a.streamId))
  return [...list.filter((a) => !ids.has(a.streamId)), ...items].sort((a, b) => a.streamId - b.streamId)
}

/**
 * Assigns a source to exactly the given streams. A stereo source on a stream that's one side of an
 * L/R pair takes that side's channel (left channel → left stream, right channel → right stream), so
 * selecting both sides fills the pair; the other side is never changed unless it's selected too.
 */
export function assignSource(
  project: Project,
  pack: string,
  file: string,
  streamIds: number[],
  source: SourceInfo,
  shape: ShapeSettings,
  pairs: StreamPair[]
): Project {
  const items = new Map<number, Assignment>()
  for (const id of streamIds) {
    const p = source.channels >= 2 ? pairOf(pairs, id) : undefined
    const channel = p ? p.side : source.channels >= 2 && shape.channel !== 'mix' ? shape.channel : 'mix'
    items.set(id, { streamId: id, action: 'replace', sourceId: source.id, shape: { ...shape, channel } })
  }
  return updateBank(project, pack, file, (b) => ({ ...b, assignments: upsert(b.assignments, [...items.values()]) }))
}

export function silenceStreams(project: Project, pack: string, file: string, streamIds: number[]): Project {
  const items = streamIds.map((id): Assignment => ({ streamId: id, action: 'silence', shape: { ...DEFAULT_SHAPE } }))
  return updateBank(project, pack, file, (b) => ({ ...b, assignments: upsert(b.assignments, items) }))
}

export function clearStreams(project: Project, pack: string, file: string, streamIds: number[]): Project {
  const ids = new Set(streamIds)
  return updateBank(project, pack, file, (b) => ({ ...b, assignments: b.assignments.filter((a) => !ids.has(a.streamId)) }))
}

/** Updates the shaping of existing replace assignments (channel stays as assigned). */
export function updateShape(project: Project, pack: string, file: string, streamIds: number[], patch: Partial<ShapeSettings>): Project {
  const ids = new Set(streamIds)
  const { channel: _ignored, ...rest } = patch
  return updateBank(project, pack, file, (b) => ({
    ...b,
    assignments: b.assignments.map((a) => (ids.has(a.streamId) && a.action === 'replace' ? { ...a, shape: { ...a.shape, ...rest } } : a))
  }))
}

export function setChannel(project: Project, pack: string, file: string, streamId: number, channel: ShapeSettings['channel']): Project {
  return updateBank(project, pack, file, (b) => ({
    ...b,
    assignments: b.assignments.map((a) => (a.streamId === streamId ? { ...a, shape: { ...a.shape, channel } } : a))
  }))
}

export function linkPair(project: Project, pack: string, file: string, left: number, right: number): Project {
  return updateBank(project, pack, file, (b) => ({
    ...b,
    manualPairs: [...b.manualPairs.filter((p) => ![p.left, p.right].some((id) => id === left || id === right)), { left, right }]
  }))
}

export function unlinkPair(project: Project, pack: string, file: string, id: number): Project {
  return updateBank(project, pack, file, (b) => ({
    ...b,
    manualPairs: b.manualPairs.filter((p) => p.left !== id && p.right !== id)
  }))
}

export function addSource(project: Project, source: SourceInfo): Project {
  return { ...project, sources: [...project.sources.filter((s) => s.id !== source.id), source] }
}

/** Sources no assignment refers to. */
export function unusedSources(project: Project): SourceInfo[] {
  const used = new Set(project.banks.flatMap((b) => b.assignments.map((a) => a.sourceId)))
  return project.sources.filter((s) => !used.has(s.id))
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2)
}

export function parseProject(json: string): Project {
  const raw = JSON.parse(json) as Partial<Project>
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.banks)) throw new Error('Not a gun soundpack project.')
  if ((raw.version ?? 0) > PROJECT_VERSION) throw new Error('This project was made with a newer version of the app.')
  const base = newProject()
  return {
    ...base,
    ...raw,
    version: PROJECT_VERSION,
    sources: (raw.sources ?? []).map((s) => ({ ...s })),
    banks: raw.banks.map((b) => ({
      pack: b.pack,
      file: b.file,
      manualPairs: b.manualPairs ?? [],
      assignments: (b.assignments ?? []).map((a) => ({ ...a, shape: { ...DEFAULT_SHAPE, ...a.shape } }))
    }))
  }
}

/** A stream in a specific bank, as used by the weapon view (one weapon spans several banks). */
export interface StreamRef {
  pack: string
  file: string
  streamId: number
}

function byBank(targets: StreamRef[]): { pack: string; file: string; ids: number[] }[] {
  const groups = new Map<string, { pack: string; file: string; ids: number[] }>()
  for (const t of targets) {
    const key = bankKey(t.pack, t.file)
    const g = groups.get(key) ?? { pack: t.pack, file: t.file, ids: [] }
    if (!g.ids.includes(t.streamId)) g.ids.push(t.streamId)
    groups.set(key, g)
  }
  return [...groups.values()]
}

export function assignAcross(
  project: Project,
  targets: StreamRef[],
  source: SourceInfo,
  shape: ShapeSettings,
  pairsFor: (pack: string, file: string) => StreamPair[] = () => []
): Project {
  return byBank(targets).reduce((p, g) => assignSource(p, g.pack, g.file, g.ids, source, shape, pairsFor(g.pack, g.file)), project)
}

export function silenceAcross(project: Project, targets: StreamRef[]): Project {
  return byBank(targets).reduce((p, g) => silenceStreams(p, g.pack, g.file, g.ids), project)
}

export function clearAcross(project: Project, targets: StreamRef[]): Project {
  return byBank(targets).reduce((p, g) => clearStreams(p, g.pack, g.file, g.ids), project)
}

export function updateShapeAcross(project: Project, targets: StreamRef[], patch: Partial<ShapeSettings>): Project {
  return byBank(targets).reduce((p, g) => updateShape(p, g.pack, g.file, g.ids, patch), project)
}

export function findAssignment(project: Project, ref: StreamRef): Assignment | undefined {
  return findBank(project, ref.pack, ref.file)?.assignments.find((a) => a.streamId === ref.streamId)
}
