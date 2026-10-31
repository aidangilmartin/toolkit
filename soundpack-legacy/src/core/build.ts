import { replaceStreamAudio, silenceStream } from './awc/replace'
import { AwcFile, getFormat } from './awc/types'
import { writeAwc } from './awc/write'
import { shapeAudio } from './dsp'
import { hex8 } from './hash'
import { PACK_ARCHIVES, sanitizePackName } from './pack'
import { bankKey, Project } from './project'
import type { AudioData } from './wav'

export interface BuildInput {
  project: Project
  /** Template banks keyed by bankKey(pack, file). */
  templates: Map<string, AwcFile>
  /** Decoded source audio keyed by source id. */
  sources: Map<string, AudioData>
  /** Optional readable stream names for messages, keyed by bankKey then stream id. */
  names?: Map<string, Record<number, string>>
}

export interface BuiltBank {
  pack: string
  file: string
  bytes: Uint8Array
  replaced: number
  silenced: number
}

export interface BuildResult {
  packName: string
  /** Modified sound banks, ready to be packed into their archives. */
  banks: BuiltBank[]
  /** Archives that will be rebuilt, e.g. WEAPONS_PLAYER.rpf. */
  archives: string[]
  warnings: string[]
}

export class BuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildError'
  }
}

const LONG_SOUND_MS = 3000

/** Applies the project's assignments to the template banks. Only banks with changes are returned. */
export function buildBanks(input: BuildInput): BuildResult {
  const { project, templates, sources } = input
  const warnings: string[] = []
  const banks: BuiltBank[] = []

  const changed = project.banks.filter((b) => b.assignments.length > 0)
  const active = changed.filter((b) => PACK_ARCHIVES[b.pack])
  for (const b of changed.filter((x) => !PACK_ARCHIVES[x.pack])) {
    warnings.push(`${b.pack}/${b.file} is skipped: only WEAPONS_PLAYER.rpf and RESIDENT.rpf can be rebuilt.`)
  }
  if (active.length === 0) throw new BuildError('Nothing to export yet: replace at least one sound.')

  for (const bank of active) {
    const key = bankKey(bank.pack, bank.file)
    const template = templates.get(key)
    if (!template) throw new BuildError(`${bank.pack}/${bank.file} isn't in your library. Scan the game again.`)
    const names = input.names?.get(key) ?? {}
    const label = (id: number): string => `${bank.file} ${names[id] ?? hex8(id)}`

    const byId = new Map(template.streams.map((s) => [s.id, s]))
    let replaced = 0
    let silenced = 0
    for (const a of bank.assignments) {
      const stream = byId.get(a.streamId)
      if (!stream) {
        warnings.push(`${label(a.streamId)} is not in the game's bank and was skipped.`)
        continue
      }
      if (a.action === 'silence') {
        byId.set(a.streamId, silenceStream(stream))
        silenced++
        continue
      }
      const source = a.sourceId ? sources.get(a.sourceId) : undefined
      if (!source) throw new BuildError(`The audio file for ${label(a.streamId)} is missing.`)
      const fmt = getFormat(stream)
      if (!fmt) {
        warnings.push(`${label(a.streamId)} has no audio format and was skipped.`)
        continue
      }
      const shaped = shapeAudio(source, a.shape, fmt.sampleRate)
      if (shaped.pcm.length === 0) warnings.push(`${label(a.streamId)} came out empty — check trim and length settings.`)
      if (shaped.clipped > 0) warnings.push(`${label(a.streamId)} clips on ${shaped.clipped} samples — lower the gain.`)
      if (shaped.durationMs > LONG_SOUND_MS) {
        warnings.push(`${label(a.streamId)} is ${(shaped.durationMs / 1000).toFixed(1)} s long; gunshots are usually under 3 s.`)
      }
      const headroom = a.shape.headroom === 'template' ? undefined : a.shape.headroom
      byId.set(a.streamId, replaceStreamAudio(stream, shaped.pcm, shaped.sampleRate, { headroom }))
      replaced++
    }

    const out: AwcFile = { ...template, streams: template.streams.map((s) => byId.get(s.id)!) }
    banks.push({ pack: bank.pack, file: bank.file, bytes: writeAwc(out), replaced, silenced })
  }

  const archives = [...new Set(banks.map((b) => PACK_ARCHIVES[b.pack]))]
  return { packName: sanitizePackName(project.resourceName), banks, archives, warnings }
}
