import type {
  AppConfig,
  AppStatus,
  ApplyPlan,
  ApplyResult,
  CapturedSettings,
  FolderTarget,
  GraphicsSchema,
  ImportProposal,
  Pack,
  PackCategory,
  PackLayout,
  Profile,
  Progress,
  Server,
  Snapshot,
} from "./types";

/** Everything the UI can ask the backend to do. Implemented by Tauri and by an in-memory mock. */
export interface Api {
  readonly isMock: boolean;

  getStatus(): Promise<AppStatus>;
  runningProcesses(): Promise<string[]>;
  closeGame(): Promise<number>;
  dismissNotice(): Promise<void>;

  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  completeSetup(): Promise<AppConfig>;
  getSchema(): Promise<GraphicsSchema>;
  captureCurrent(): Promise<CapturedSettings>;

  listProfiles(): Promise<Profile[]>;
  saveProfile(profile: Profile): Promise<Profile>;
  duplicateProfile(id: string): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;

  listServers(): Promise<Server[]>;
  saveServer(server: Server): Promise<Server>;
  deleteServer(id: string): Promise<void>;

  listPacks(): Promise<Pack[]>;
  inspectPack(path: string, layout?: PackLayout | null): Promise<ImportProposal>;
  importPack(proposal: ImportProposal): Promise<Pack>;
  updatePack(id: string, name: string, category: PackCategory, notes: string): Promise<Pack>;
  deletePack(id: string): Promise<void>;

  planApply(profileId: string | null): Promise<ApplyPlan>;
  applyProfile(profileId: string | null): Promise<ApplyResult>;
  saveDriftToProfile(): Promise<Profile>;
  dismissDrift(): Promise<void>;

  listSnapshots(): Promise<Snapshot[]>;
  restoreSnapshot(id: string): Promise<void>;
  deleteSnapshot(id: string): Promise<void>;

  launchFivem(): Promise<void>;
  connectServer(address: string, serverId?: string | null): Promise<void>;
  openFolder(target: FolderTarget): Promise<void>;

  /** Native pickers. Return null when cancelled. */
  pickFolder(title: string): Promise<string | null>;
  pickPackFile(): Promise<string | null>;

  onProgress(listener: (progress: Progress) => void): Promise<() => void>;
}

/** Turn whatever a failed call throws into a message for a toast. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
