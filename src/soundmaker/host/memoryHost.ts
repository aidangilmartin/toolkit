/**
 * An in-memory Host for running the UI in a plain browser (pnpm dev, screenshots), like
 * src/mock/mockApi.ts for the rest of Loadout. Nothing touches the disk and the bridge only
 * answers the CodeWalker folder check.
 */
import { BridgeError } from "./bridge";
import { dirname, type Host } from "./host";
import type { Shell } from "./service";

export function memoryHost(): Host {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/soundmaker"]);
  const addDirs = (path: string) => {
    for (let d = dirname(path); d !== "/" && d !== "."; d = dirname(d)) dirs.add(d);
  };
  const children = (dir: string) => {
    const prefix = `${dir.replace(/\/+$/, "")}/`;
    const names = new Set<string>();
    for (const p of [...files.keys(), ...dirs]) {
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]);
    }
    return [...names].sort();
  };
  let temp = 0;
  return {
    root: "/soundmaker",
    appVersion: "preview",
    exists: async (p) => files.has(p) || dirs.has(p),
    stat: async (p) =>
      files.has(p)
        ? { isDir: false, size: files.get(p)!.length, mtimeMs: 0 }
        : dirs.has(p)
          ? { isDir: true, size: 0, mtimeMs: 0 }
          : null,
    readdir: async (p) => children(p),
    readFile: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`${p} wasn't found`);
      return f;
    },
    writeFile: async (p, data) => {
      addDirs(p);
      files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : data);
    },
    mkdir: async (p) => {
      dirs.add(p);
      addDirs(p);
    },
    rm: async (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      for (const k of [...dirs]) if (k === p || k.startsWith(`${p}/`)) dirs.delete(k);
    },
    rename: async (a, b) => {
      for (const [k, v] of [...files]) {
        if (k === a || k.startsWith(`${a}/`)) {
          files.delete(k);
          const to = b + k.slice(a.length);
          addDirs(to);
          files.set(to, v);
        }
      }
    },
    copy: async () => {
      throw new Error("Not available in the preview.");
    },
    mkdtemp: async (prefix) => {
      const d = `/soundmaker/work/${prefix}${++temp}`;
      dirs.add(d);
      return d;
    },
    bridgeAvailable: async () => true,
    runBridge: async <T>(args: string[]): Promise<T> => {
      if (args[0] === "probe-codewalker") return { codeWalkerVersion: "1.0.0.0" } as T;
      throw new BridgeError("preview", "Reading game files needs the Loadout desktop app.");
    },
  };
}

export function previewShell(): Shell {
  return {
    pickFiles: async () => [],
    pickFolder: async () => "C:\\Tools\\CodeWalker",
    pickSaveFile: async () => null,
    confirm: async (message) => window.confirm(message),
    showInFolder: async () => {},
    openExternal: async (url) => void window.open(url, "_blank"),
    detectGtaFolder: async () => "C:\\Program Files\\Rockstar Games\\Grand Theft Auto V",
  };
}
