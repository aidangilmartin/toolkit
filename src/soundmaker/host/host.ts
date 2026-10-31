/**
 * What the sound maker needs from the machine it runs on: files, scratch folders and the
 * CodeWalker bridge. In the app it's backed by Loadout's Tauri commands (tauriHost.ts); tests
 * use plain Node (test/nodeHost.ts).
 *
 * Paths are absolute. They're built with `join`, which uses `/`; Windows accepts both.
 */
export interface FileStat {
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface Host {
  /** The sound maker's own data folder (library, vanilla pack, settings). */
  readonly root: string;
  readonly appVersion: string;

  exists(path: string): Promise<boolean>;
  /** null when the path doesn't exist. */
  stat(path: string): Promise<FileStat | null>;
  /** Entry names; empty when the folder doesn't exist. */
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  /** Creates parent folders as needed. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Recursive, and fine when the path doesn't exist. */
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Copies a file or a whole folder. */
  copy(from: string, to: string): Promise<void>;
  /** A new empty scratch folder; the caller removes it. */
  mkdtemp(prefix: string): Promise<string>;

  /** Is the CodeWalker bridge there? */
  bridgeAvailable(): Promise<boolean>;
  /**
   * Runs one bridge command and resolves with its JSON result. Rejects with a BridgeError
   * (see bridge.ts) carrying the bridge's error code.
   */
  runBridge<T>(args: string[], onProgress?: (message: string) => void): Promise<T>;
}

export function join(...parts: string[]): string {
  const out = parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join("/");
  return out || "/";
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i <= 0 ? trimmed.slice(0, i + 1) || "." : trimmed.slice(0, i);
}

export async function readText(host: Host, path: string): Promise<string> {
  return new TextDecoder().decode(await host.readFile(path));
}

export async function readJson<T>(host: Host, path: string): Promise<T> {
  return JSON.parse(await readText(host, path)) as T;
}

/** Case-insensitive check for a file directly inside `dir`. */
export async function hasFile(host: Host, dir: string, name: string): Promise<boolean> {
  const lower = name.toLowerCase();
  return (await host.readdir(dir)).some((f) => f.toLowerCase() === lower);
}

export async function isGtaFolder(host: Host, dir: string): Promise<boolean> {
  return (await hasFile(host, dir, "gta5.exe")) || (await hasFile(host, dir, "gta5_enhanced.exe"));
}
