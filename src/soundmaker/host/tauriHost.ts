/** The sound maker's Host and Shell inside Loadout (see src-tauri/src/soundmaker.rs). */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { BridgeError } from "./bridge";
import type { FileStat, Host } from "./host";
import type { Shell } from "./service";

interface Info {
  root: string;
  bridgeAvailable: boolean;
  appVersion: string;
}

export const PROGRESS_EVENT = "soundmaker://progress";

export async function createTauriHost(): Promise<Host> {
  const info = await invoke<Info>("sm_info");
  // Progress lines from whichever bridge command is running; the UI shows one task at a time.
  const progressListeners = new Set<(message: string) => void>();
  await listen<string>(PROGRESS_EVENT, (e) => progressListeners.forEach((l) => l(e.payload)));

  return {
    root: info.root,
    appVersion: info.appVersion,
    exists: async (path) => (await invoke<FileStat | null>("sm_stat", { path })) !== null,
    stat: (path) => invoke<FileStat | null>("sm_stat", { path }),
    readdir: (path) => invoke<string[]>("sm_read_dir", { path }),
    readFile: async (path) => new Uint8Array(await invoke<ArrayBuffer>("sm_read_file", { path })),
    writeFile: async (path, data) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      await invoke("sm_write_file", bytes, { headers: { path: encodeURIComponent(path) } });
    },
    mkdir: (path) => invoke("sm_mkdir", { path }),
    rm: (path) => invoke("sm_remove", { path }),
    rename: (from, to) => invoke("sm_rename", { from, to }),
    copy: (from, to) => invoke("sm_copy", { from, to }),
    mkdtemp: (prefix) => invoke<string>("sm_make_temp_dir", { prefix }),
    bridgeAvailable: async () => (await invoke<Info>("sm_info")).bridgeAvailable,
    runBridge: async <T>(args: string[], onProgress?: (message: string) => void): Promise<T> => {
      if (onProgress) progressListeners.add(onProgress);
      try {
        return await invoke<T>("sm_run_bridge", { args });
      } catch (e) {
        const err = e as { code?: string; message?: string } | string;
        if (typeof err === "object" && err?.code)
          throw new BridgeError(err.code, err.message ?? "Unknown bridge error.");
        throw new BridgeError("error", String(err));
      } finally {
        if (onProgress) progressListeners.delete(onProgress);
      }
    },
  };
}

/** `gtaFolder` is the GTA V folder Loadout found (from its status). */
export function createTauriShell(gtaFolder: () => Promise<string | null>): Shell {
  return {
    pickFiles: async ({ title, filters, multiple }) => {
      const picked = await open({ title, filters, multiple: !!multiple, directory: false });
      if (!picked) return [];
      return Array.isArray(picked) ? picked : [picked];
    },
    pickFolder: async (title) => {
      const picked = await open({ title, directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    },
    pickSaveFile: ({ title, defaultPath, filters }) => save({ title, defaultPath, filters }),
    confirm: (message, detail, okLabel) =>
      ask(`${message}\n\n${detail}`, {
        title: "Loadout",
        kind: "warning",
        okLabel,
        cancelLabel: "Cancel",
      }),
    showInFolder: (path) => invoke("sm_show_in_folder", { path }),
    openExternal: (url) => invoke("sm_open_url", { url }),
    detectGtaFolder: gtaFolder,
  };
}
