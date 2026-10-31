/** A Host on plain Node, for tests. The app itself runs on tauriHost.ts. */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BRIDGE_NAME, BridgeError } from "../host/bridge";
import type { Host } from "../host/host";

export const repoRoot = resolve(__dirname, "../../..");
/** Where `pnpm build:bridge` puts the bridge. */
export const bridgeExe = join(
  repoRoot,
  "src-tauri",
  "bridge",
  process.platform === "win32" ? `${BRIDGE_NAME}.exe` : BRIDGE_NAME,
);

/**
 * Runs one bridge command. stdout carries a single JSON result; stderr carries JSON progress
 * lines. Mirrors loadout-core's soundmaker::run_bridge.
 */
export function runBridge<T>(
  exe: string,
  args: string[],
  onProgress?: (message: string) => void,
): Promise<T> {
  if (!existsSync(exe)) {
    return Promise.reject(
      new BridgeError(
        "no-bridge",
        'The CodeWalker bridge is not built. Run "pnpm build:bridge" (needs the .NET 8 SDK).',
      ),
    );
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderrRest = "";
    const stderrText: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => {
      const lines = (stderrRest + d).split(/\r?\n/);
      stderrRest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { progress?: string };
          if (msg.progress && !msg.progress.startsWith("debug")) onProgress?.(msg.progress);
        } catch {
          stderrText.push(line);
        }
      }
    });
    child.on("error", (e) =>
      reject(new BridgeError("spawn", `Could not start the CodeWalker bridge: ${e.message}`)),
    );
    child.on("close", (code) => {
      const line = stdout.trim().split(/\r?\n/).pop() ?? "";
      let parsed: { ok: boolean; result?: T; code?: string; error?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        const detail = stderrText.slice(-5).join("\n") || stdout.trim() || `exit code ${code}`;
        reject(new BridgeError("crash", `The CodeWalker bridge failed: ${detail}`));
        return;
      }
      if (parsed.ok) resolvePromise(parsed.result as T);
      else reject(new BridgeError(parsed.code ?? "error", parsed.error ?? "Unknown bridge error."));
    });
  });
}

export function nodeHost(root: string, opts: { bridge?: string; extraArgs?: string[] } = {}): Host {
  const exe = opts.bridge ?? bridgeExe;
  return {
    root,
    appVersion: "0.0.0-test",
    exists: async (p) => existsSync(p),
    stat: async (p) => {
      try {
        const s = await stat(p);
        return { isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    },
    readdir: async (p) => {
      try {
        return await readdir(p);
      } catch {
        return [];
      }
    },
    readFile: async (p) => new Uint8Array(await readFile(p)),
    writeFile: async (p, data) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },
    mkdir: async (p) => {
      await mkdir(p, { recursive: true });
    },
    rm: (p) => rm(p, { recursive: true, force: true }),
    rename: (a, b) => rename(a, b),
    copy: async (a, b) => cpSync(a, b, { recursive: true }),
    mkdtemp: async (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    bridgeAvailable: async () => existsSync(exe),
    runBridge: (args, onProgress) =>
      runBridge(exe, [...args, ...(opts.extraArgs ?? [])], onProgress),
  };
}
