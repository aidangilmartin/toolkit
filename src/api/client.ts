import type {
  AppConfig,
  AppStatus,
  ApplyPlan,
  ApplyResult,
  CapturedSettings,
  FolderTarget,
  GraphicsSchema,
  Pack,
  Profile,
  ProfileFileKind,
  Progress,
  ServerInfo,
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

  /** Name, logo and players for a server address. Goes over the network. */
  lookupServer(address: string): Promise<ServerInfo>;
  /** A logo picked by hand, as a data: URL. */
  readLogoFile(path: string): Promise<string>;

  listPacks(): Promise<Pack[]>;
  /** Copy an uploaded sound file or mod in. Add the returned pack's id to the profile. */
  importProfileFile(path: string, kind: ProfileFileKind): Promise<Pack>;

  planApply(profileId: string | null): Promise<ApplyPlan>;
  applyProfile(profileId: string | null): Promise<ApplyResult>;
  saveDriftToProfile(): Promise<Profile>;
  dismissDrift(): Promise<void>;

  listSnapshots(): Promise<Snapshot[]>;
  restoreSnapshot(id: string): Promise<void>;
  deleteSnapshot(id: string): Promise<void>;

  launchFivem(): Promise<void>;
  connectServer(address: string): Promise<void>;
  openFolder(target: FolderTarget): Promise<void>;

  /** Native pickers. Return null when cancelled. */
  pickFolder(title: string): Promise<string | null>;
  /** Sound files are a single .rpf; mods can be several .rpf or .zip files. */
  pickProfileFiles(kind: ProfileFileKind): Promise<string[]>;
  pickImage(): Promise<string | null>;

  onProgress(listener: (progress: Progress) => void): Promise<() => void>;
}

/** Turn whatever a failed call throws into a message for a toast. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
