import type { AwcFile, AwcStream, StreamSummary } from '@core/awc/types'
import { summarizeStream } from '@core/awc/types'
import { parseAwc } from '@core/awc/read'
import { BankCategory, CATALOG, lookupBank } from '@core/catalog'
import { hex8 } from '@core/hash'
import { detectPairs, StreamPair } from '@core/pairs'
import { Assignment, bankKey, Project, ProjectBank, SourceInfo, type StreamRef } from '@core/project'
import type { BankSummary } from '@core/usage'
import type { AudioData } from '@core/wav'
import type { LibraryTemplate, TemplateData } from '@shared/ipc'

export interface LoadedTemplate {
  pack: string
  file: string
  awc: AwcFile
  names: Record<number, string>
  summaries: StreamSummary[]
  byId: Map<number, AwcStream>
  detectedPairs: StreamPair[]
}

export interface SourceEntry {
  info: SourceInfo
  bytes: Uint8Array
  audio: AudioData
}

/** `knownPairs`: L/R pairs the game data defines (sound map); name-based detection fills in the rest. */
export function loadTemplate(pack: string, file: string, data: TemplateData, knownPairs: StreamPair[] = []): LoadedTemplate {
  const awc = parseAwc(data.bytes)
  const ids = awc.streams.map((s) => s.id)
  const present = new Set(ids)
  const known = knownPairs.filter((p) => present.has(p.left) && present.has(p.right))
  const taken = new Set(known.flatMap((p) => [p.left, p.right]))
  return {
    pack,
    file,
    awc,
    names: data.names,
    summaries: awc.streams.map(summarizeStream),
    byId: new Map(awc.streams.map((s) => [s.id, s])),
    detectedPairs: [...known, ...detectPairs(ids, data.names, file).filter((p) => !taken.has(p.left) && !taken.has(p.right))]
  }
}

export const labelKey = (pack: string, file: string, id: number): string => `${bankKey(pack, file)}:${hex8(id)}`

export function streamName(t: LoadedTemplate, id: number, labels: Record<string, string>): string {
  return labels[labelKey(t.pack, t.file, id)] ?? t.names[id] ?? `0x${hex8(id)}`
}

export function pairsFor(t: LoadedTemplate, bank: ProjectBank | undefined): StreamPair[] {
  const manual = bank?.manualPairs ?? []
  const taken = new Set(manual.flatMap((p) => [p.left, p.right]))
  return [...manual, ...t.detectedPairs.filter((p) => !taken.has(p.left) && !taken.has(p.right))]
}

export function assignmentMap(bank: ProjectBank | undefined): Map<number, Assignment> {
  return new Map((bank?.assignments ?? []).map((a) => [a.streamId, a]))
}

export interface BankItem {
  key: string
  pack: string
  file: string
  label: string
  category: BankCategory
  certainty: 'name' | 'guess'
  note?: string
  template?: LibraryTemplate
  changed: number
  /** Sidebar group when the sound map is known: the archive the bank lives in. */
  group?: string
  /** What the bank holds, from the sound map. */
  summary?: BankSummary
}

/**
 * Every bank of WEAPONS_PLAYER.rpf and RESIDENT.rpf when the sound map is known (labelled with what
 * the game uses them for), otherwise the catalog of usual gun banks; plus any other imported banks.
 */
export function bankItems(library: LibraryTemplate[], project: Project, summaries?: Map<string, BankSummary> | null): BankItem[] {
  const changed = (pack: string, file: string): number =>
    project.banks.find((b) => bankKey(b.pack, b.file) === bankKey(pack, file))?.assignments.length ?? 0
  const lib = new Map(library.map((t) => [bankKey(t.pack, t.file), t]))
  const items: BankItem[] = summaries
    ? [...summaries.entries()].map(([key, summary]) => {
        const [pack, file] = key.split('/')
        return {
          key,
          pack,
          file,
          label: file.replace(/\.awc$/, ''),
          category: 'other' as const,
          certainty: 'name' as const,
          group: summary.archive,
          summary,
          template: lib.get(key),
          changed: changed(pack, file)
        }
      })
    : CATALOG.map((b) => ({
        key: bankKey(b.pack, b.file),
        ...b,
        template: lib.get(bankKey(b.pack, b.file)),
        changed: changed(b.pack, b.file)
      }))
  const known = new Set(items.map((i) => i.key))
  for (const t of library) {
    const key = bankKey(t.pack, t.file)
    if (known.has(key)) continue
    const info = lookupBank(t.file)
    items.push({
      key,
      pack: t.pack,
      file: t.file,
      label: info?.label ?? t.file.replace(/\.awc$/, ''),
      category: 'other',
      certainty: 'guess',
      group: summaries ? 'Imported' : undefined,
      note: `Custom wave pack "${t.pack}". Make sure the folder name matches the game's wave pack.`,
      template: t,
      changed: changed(t.pack, t.file)
    })
  }
  // project banks whose template isn't in the library (e.g. opened on another PC)
  for (const b of project.banks) {
    const key = bankKey(b.pack, b.file)
    if (items.some((i) => i.key === key)) continue
    items.push({ key, pack: b.pack, file: b.file, label: b.file, category: 'other', certainty: 'guess', changed: b.assignments.length })
  }
  return items
}

export const fmtDuration = (sec: number): string => (sec < 10 ? `${sec.toFixed(2)} s` : `${sec.toFixed(1)} s`)
export const fmtRate = (hz: number): string => `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
export const fmtBytes = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

/** Strips Electron's "Error invoking remote method 'x': Error: " wrapper from IPC errors. */
export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': /, '').replace(/^(\w*Error): /, '')
}

export const refKey = (r: StreamRef): string => `${bankKey(r.pack, r.file)}:${r.streamId}`
