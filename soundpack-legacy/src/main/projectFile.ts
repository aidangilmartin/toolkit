import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { ProjectFileSource } from '../shared/ipc'

/**
 * .gunpack project files are zips holding project.json plus the original audio the user
 * imported (never game files), so a project can be reopened and re-shaped later.
 */
interface Manifest {
  format: 'gunpack'
  version: 1
  sources: { id: string; fileName: string; entry: string }[]
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)

export function packProject(json: string, sources: ProjectFileSource[]): Uint8Array {
  const manifest: Manifest = {
    format: 'gunpack',
    version: 1,
    sources: sources.map((s) => ({ id: s.id, fileName: s.fileName, entry: `audio/${safeName(s.id)}__${safeName(s.fileName)}` }))
  }
  const files: Zippable = {
    'gunpack.json': strToU8(JSON.stringify(manifest, null, 2)),
    'project.json': strToU8(json)
  }
  manifest.sources.forEach((m, i) => {
    // audio is usually already compressed; store it as-is
    files[m.entry] = [sources[i].bytes, { level: 0 }]
  })
  return zipSync(files, { level: 6 })
}

export function unpackProject(bytes: Uint8Array): { json: string; sources: ProjectFileSource[] } {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new Error('Not a .gunpack project file.')
  }
  const manifestBytes = entries['gunpack.json']
  const projectBytes = entries['project.json']
  if (!manifestBytes || !projectBytes) throw new Error('Not a .gunpack project file.')
  const manifest = JSON.parse(strFromU8(manifestBytes)) as Manifest
  if (manifest.format !== 'gunpack') throw new Error('Not a .gunpack project file.')
  const sources = manifest.sources.map((m) => {
    const data = entries[m.entry]
    if (!data) throw new Error(`Project is missing audio file ${m.fileName}.`)
    return { id: m.id, fileName: m.fileName, bytes: data }
  })
  return { json: strFromU8(projectBytes), sources }
}
