import { toast } from "sonner";
import { create } from "zustand";

import { api, errorMessage } from "../api";
import type {
  AppConfig,
  AppStatus,
  GraphicsSchema,
  Pack,
  Profile,
  Server,
  Snapshot,
} from "../api/types";

export type View =
  | { name: "home" }
  | { name: "profile"; id: string }
  | { name: "packs" }
  | { name: "backups" }
  | { name: "settings" };

/** What to do once a profile has been applied. */
export type AfterApply =
  { kind: "launch" } | { kind: "connect"; address: string; serverId: string | null } | null;

export interface ApplyRequest {
  /** `null` restores vanilla. */
  profileId: string | null;
  then: AfterApply;
  key: number;
}

type Part = "status" | "config" | "profiles" | "servers" | "packs" | "snapshots";

interface AppStore {
  loaded: boolean;
  loadError: string | null;
  config: AppConfig | null;
  status: AppStatus | null;
  schema: GraphicsSchema | null;
  profiles: Profile[];
  servers: Server[];
  packs: Pack[];
  snapshots: Snapshot[];
  running: string[];

  view: View;
  /** Set by the profile editor while it has unsaved changes. */
  dirty: boolean;
  pendingView: View | null;
  apply: ApplyRequest | null;

  init(): Promise<void>;
  refresh(...parts: Part[]): Promise<void>;
  pollRunning(): Promise<void>;
  navigate(view: View, options?: { force?: boolean }): void;
  setDirty(dirty: boolean): void;
  cancelNavigation(): void;
  requestApply(profileId: string | null, then?: AfterApply): void;
  closeApply(): void;
  saveConfig(config: AppConfig): Promise<void>;
}

const loaders: Record<Part, () => Promise<Partial<AppStore>>> = {
  status: async () => {
    const status = await api.getStatus();
    return { status, running: status.runningProcesses };
  },
  config: async () => ({ config: await api.getConfig() }),
  profiles: async () => ({ profiles: await api.listProfiles() }),
  servers: async () => ({ servers: await api.listServers() }),
  packs: async () => ({ packs: await api.listPacks() }),
  snapshots: async () => ({ snapshots: await api.listSnapshots() }),
};

const ALL: Part[] = ["status", "config", "profiles", "servers", "packs", "snapshots"];

export const useApp = create<AppStore>((set, get) => ({
  loaded: false,
  loadError: null,
  config: null,
  status: null,
  schema: null,
  profiles: [],
  servers: [],
  packs: [],
  snapshots: [],
  running: [],
  view: { name: "home" },
  dirty: false,
  pendingView: null,
  apply: null,

  async init() {
    try {
      const [schema, ...parts] = await Promise.all([
        api.getSchema(),
        ...ALL.map((part) => loaders[part]()),
      ]);
      set(Object.assign({ schema, loaded: true, loadError: null }, ...parts));
    } catch (error) {
      set({ loadError: errorMessage(error) });
    }
  },

  async refresh(...parts) {
    const wanted = parts.length ? parts : ALL;
    try {
      const results = await Promise.all(wanted.map((part) => loaders[part]()));
      set(Object.assign({}, ...results));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  },

  async pollRunning() {
    try {
      const running = await api.runningProcesses();
      const previous = get().running;
      if (running.join("|") !== previous.join("|")) set({ running });
    } catch {
      // Polling is best-effort.
    }
  },

  navigate(view, options) {
    if (get().dirty && !options?.force) {
      set({ pendingView: view });
      return;
    }
    set({ view, dirty: false, pendingView: null });
  },

  setDirty(dirty) {
    if (get().dirty !== dirty) set({ dirty });
  },

  cancelNavigation() {
    set({ pendingView: null });
  },

  requestApply(profileId, then = null) {
    set({ apply: { profileId, then, key: Date.now() } });
  },

  closeApply() {
    set({ apply: null });
  },

  async saveConfig(config) {
    try {
      set({ config: await api.saveConfig(config) });
      await get().refresh("status");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  },
}));
