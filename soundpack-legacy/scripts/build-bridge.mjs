#!/usr/bin/env node
/**
 * Builds the CodeWalker bridge (bridge/) into resources/bridge/.
 *
 * 1. Fetches CodeWalker's source at a pinned commit into bridge/.codewalker (git-ignored).
 * 2. Publishes CodeWalker.Core into bridge/.codewalker/runtime — used only to compile the bridge
 *    and, in development, as a stand-in for a CodeWalker install. It is never packaged.
 * 3. Publishes the bridge as a self-contained single-file executable.
 *
 * Requires git and the .NET 8 SDK. Usage: node scripts/build-bridge.mjs [--rid win-x64]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CODEWALKER_REPO = 'https://github.com/dexyfex/CodeWalker'
const CODEWALKER_COMMIT = '485d56bec00262ed7fa472261cce7bbc6202b96e'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cwDir = join(root, 'bridge', '.codewalker')
const runtimeDir = join(cwDir, 'runtime')
const outDir = join(root, 'resources', 'bridge')

const ridArg = process.argv.indexOf('--rid')
const rid = ridArg > 0 ? process.argv[ridArg + 1] : hostRid()

function hostRid() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `win-${arch}`
  if (process.platform === 'darwin') return `osx-${arch}`
  return `linux-${arch}`
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

function git(args) {
  return execFileSync('git', ['-C', cwDir, ...args], { encoding: 'utf8' }).trim()
}

try {
  execFileSync('dotnet', ['--version'], { stdio: 'ignore' })
} catch {
  console.error('The .NET 8 SDK is required to build the bridge: https://dotnet.microsoft.com/download/dotnet/8.0')
  process.exit(1)
}

// 1. CodeWalker source at the pinned commit
if (!existsSync(join(cwDir, '.git'))) {
  mkdirSync(cwDir, { recursive: true })
  run('git', ['-C', cwDir, 'init', '-q'])
  run('git', ['-C', cwDir, 'remote', 'add', 'origin', CODEWALKER_REPO])
}
let head = ''
try {
  head = git(['rev-parse', 'HEAD'])
} catch {
  // empty repository
}
if (head !== CODEWALKER_COMMIT) {
  run('git', ['-C', cwDir, 'fetch', '-q', '--depth', '1', 'origin', CODEWALKER_COMMIT])
  run('git', ['-C', cwDir, 'checkout', '-q', '--force', 'FETCH_HEAD'])
  rmSync(runtimeDir, { recursive: true, force: true })
}

const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }

// 2. CodeWalker.Core (+ SharpDX) for compiling and local development
if (!existsSync(join(runtimeDir, 'CodeWalker.Core.dll'))) {
  run('dotnet', ['publish', join(cwDir, 'CodeWalker.Core', 'CodeWalker.Core.csproj'), '-c', 'Release', '-o', runtimeDir, '--nologo', '-v', 'quiet'], { env })
}

// 3. The bridge itself
rmSync(outDir, { recursive: true, force: true })
run(
  'dotnet',
  [
    'publish',
    join(root, 'bridge', 'GunpackBridge.csproj'),
    '-c',
    'Release',
    '-r',
    rid,
    '--self-contained',
    'true',
    '-p:PublishSingleFile=true',
    '-p:EnableCompressionInSingleFile=true',
    '-p:DebugType=none',
    '-o',
    outDir,
    '--nologo',
    '-v',
    'quiet'
  ],
  { env }
)
console.log(`Bridge built for ${rid} in ${outDir}`)
