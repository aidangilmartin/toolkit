import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GameInfo } from '../shared/ipc'

export const BRIDGE_NAME = process.platform === 'win32' ? 'gunpack-bridge.exe' : 'gunpack-bridge'

/** Where the bridge executable lives: bundled resources when packaged, resources/bridge in development. */
export function bridgePath(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return opts.isPackaged ? join(opts.resourcesPath, 'bridge', BRIDGE_NAME) : join(opts.appPath, 'resources', 'bridge', BRIDGE_NAME)
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

export interface ListResult {
  game: GameInfo
  banks: { pack: string; file: string; size: number; archive: string }[]
}

export interface ExtractedBank {
  pack: string
  file: string
  path: string
  streams: number
  wasEncrypted: boolean
  names: Record<string, string>
}

export interface ScanResult {
  game: GameInfo
  indexPath: string
  /** sound-map.json: what every stream in WEAPONS_PLAYER / RESIDENT is for (see core/usage.ts). */
  mapPath: string
  extracted: ExtractedBank[]
  errors: { pack: string; file: string; error: string }[]
  weapons: number
  warnings: string[]
}

export interface ExtractResult {
  game: GameInfo
  extracted: ExtractedBank[]
  errors: { pack: string; file: string; error: string }[]
}

/**
 * Runs one bridge command. stdout carries a single JSON result; stderr carries JSON progress
 * lines. GSM_BRIDGE_EXTRA_ARGS (JSON array) is appended for automated tests.
 */
export function runBridge<T>(exe: string, args: string[], onProgress?: (message: string) => void): Promise<T> {
  if (!existsSync(exe)) {
    return Promise.reject(
      new BridgeError(
        'no-bridge',
        'The CodeWalker bridge is not built. Run "npm run build:bridge" (needs the .NET 8 SDK) and restart the app.'
      )
    )
  }
  const extra = process.env.GSM_BRIDGE_EXTRA_ARGS ? (JSON.parse(process.env.GSM_BRIDGE_EXTRA_ARGS) as string[]) : []
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args, ...extra], { windowsHide: true })
    let stdout = ''
    let stderrRest = ''
    const stderrText: string[] = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => {
      const lines = (stderrRest + d).split(/\r?\n/)
      stderrRest = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as { progress?: string }
          if (msg.progress && !msg.progress.startsWith('debug')) onProgress?.(msg.progress)
        } catch {
          stderrText.push(line)
        }
      }
    })
    child.on('error', (e) => reject(new BridgeError('spawn', `Could not start the CodeWalker bridge: ${e.message}`)))
    child.on('close', (code) => {
      const line = stdout.trim().split(/\r?\n/).pop() ?? ''
      let parsed: { ok: boolean; result?: T; code?: string; error?: string }
      try {
        parsed = JSON.parse(line)
      } catch {
        const detail = stderrText.slice(-5).join('\n') || stdout.trim() || `exit code ${code}`
        reject(new BridgeError('crash', `The CodeWalker bridge failed: ${detail}`))
        return
      }
      if (parsed.ok) resolve(parsed.result as T)
      else reject(new BridgeError(parsed.code ?? 'error', parsed.error ?? 'Unknown bridge error.'))
    })
  })
}

export interface BuildRpfResult {
  game: GameInfo
  archives: { pack: string; file: string; path: string; files: number; size: number; replaced: string[] }[]
  errors: { pack: string; file: string; error: string }[]
}
