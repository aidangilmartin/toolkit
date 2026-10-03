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

  listServers: () => invoke("list_servers"),
  saveServer: (server) => invoke("save_server", { server }),
  deleteServer: (id) => invoke("delete_server", { id }),

  listPacks: () => invoke("list_packs"),
  inspectPack: (path, layout) => invoke("inspect_pack", { path, layout: layout ?? null }),
  importPack: (proposal) => invoke("import_pack", { proposal }),
  updatePack: (id, name, category, notes) => invoke("update_pack", { id, name, category, notes }),
  deletePack: (id) => invoke("delete_pack", { id }),

  planApply: (profileId) => invoke("plan_apply", { profileId }),
  applyProfile: (profileId) => invoke("apply_profile", { profileId }),
  saveDriftToProfile: () => invoke("save_drift_to_profile"),
  dismissDrift: () => invoke("dismiss_drift"),

  listSnapshots: () => invoke("list_snapshots"),
  restoreSnapshot: (id) => invoke("restore_snapshot", { id }),
  deleteSnapshot: (id) => invoke("delete_snapshot", { id }),

  launchFivem: () => invoke("launch_fivem"),
  connectServer: (address, serverId) =>
    invoke("connect_server", { address, serverId: serverId ?? null }),
  openFolder: (target) => invoke("open_folder", { target }),

  pickFolder: async (title) => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
  pickPackFile: async () => {
    const picked = await open({
      multiple: false,
      title: "Choose a pack",
      filters: [{ name: "Pack (.zip or .rpf)", extensions: ["zip", "rpf"] }],
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
