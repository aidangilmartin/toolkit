import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type { Api } from "./client";
import type { Progress } from "./types";

export const tauriApi: Api = {
  isMock: false,

  getStatus: () => invoke("get_status"),
  runningProcesses: () => invoke("running_processes"),
  closeGame: () => invoke("close_game"),
  dismissNotice: () => invoke("dismiss_notice"),

  getConfig: () => invoke("get_config"),
  saveConfig: (config) => invoke("save_config", { config }),
  completeSetup: () => invoke("complete_setup"),
  getSchema: () => invoke("get_schema"),
  captureCurrent: () => invoke("capture_current"),

  listProfiles: () => invoke("list_profiles"),
  saveProfile: (profile) => invoke("save_profile", { profile }),
  duplicateProfile: (id) => invoke("duplicate_profile", { id }),
  deleteProfile: (id) => invoke("delete_profile", { id }),

  lookupServer: (address) => invoke("lookup_server", { address }),
  searchServers: (query) => invoke("search_servers", { query }),
  readLogoFile: (path) => invoke("read_logo_file", { path }),

  listPacks: () => invoke("list_packs"),
  importProfileFile: (path, kind) => invoke("import_profile_file", { path, kind }),

  planApply: (profileId) => invoke("plan_apply", { profileId }),
  applyProfile: (profileId) => invoke("apply_profile", { profileId }),
  saveDriftToProfile: () => invoke("save_drift_to_profile"),
  dismissDrift: () => invoke("dismiss_drift"),

  listSnapshots: () => invoke("list_snapshots"),
  restoreSnapshot: (id) => invoke("restore_snapshot", { id }),
  deleteSnapshot: (id) => invoke("delete_snapshot", { id }),

  launchFivem: () => invoke("launch_fivem"),
  connectServer: (address) => invoke("connect_server", { address }),
  openFolder: (target) => invoke("open_folder", { target }),

  pickFolder: async (title) => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
  pickProfileFiles: async (kind) => {
    const mod = kind === "mod";
    const picked = await open({
      multiple: mod,
      title: {
        weaponSounds: "Choose your WEAPONS_PLAYER.rpf",
        residentSounds: "Choose your RESIDENT.rpf",
        mod: "Choose mods for the mods folder",
      }[kind],
      filters: [
        mod
          ? { name: "Mods (.rpf or .zip)", extensions: ["rpf", "zip"] }
          : { name: "Sound file (.rpf)", extensions: ["rpf"] },
      ],
    });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  pickImage: async () => {
    const picked = await open({
      multiple: false,
      title: "Choose a logo",
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    return typeof picked === "string" ? picked : null;
  },

  onProgress: async (listener) => {
    const unlisten = await listen<Progress>("loadout://progress", (event) =>
      listener(event.payload),
    );
    return unlisten;
  },
};
