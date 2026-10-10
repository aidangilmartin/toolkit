import type {
  GraphicsSchema,
  InstallRoot,
  Pack,
  Preset,
  Profile,
  ProfileFileKind,
  SettingDef,
} from "../api/types";
import { plural } from "./format";

export const PROFILE_COLORS = [
  "#34d399",
  "#60a5fa",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#f87171",
  "#2dd4bf",
  "#fb923c",
];

export const ROOT_LABEL: Record<InstallRoot, string> = {
  fivemApp: "FiveM.app",
  gtaInstall: "GTA V folder",
};

export function emptyProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "",
    name: "",
    color: PROFILE_COLORS[0],
    notes: "",
    graphics: {},
    applyToGta: false,
    fivemCfg: {},
    packs: [],
    serverAddress: null,
    serverName: null,
    serverIcon: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

type Values = { [key in string]?: string };

function defined(values: Values): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The preset whose values all appear (unchanged) in this profile, if any. */
export function matchingPreset(graphics: Values, schema: GraphicsSchema): Preset | null {
  const values = defined(graphics);
  for (const preset of schema.presets) {
    const entries = Object.entries(defined(preset.values));
    if (entries.length > 0 && entries.every(([key, value]) => values[key] === value)) {
      return preset;
    }
  }
  return null;
}

export function graphicsSummary(profile: Profile, schema: GraphicsSchema | null): string {
  const count = Object.keys(defined(profile.graphics)).length;
  if (count === 0) return "Graphics unchanged";
  const preset = schema ? matchingPreset(profile.graphics, schema) : null;
  if (preset) return `${preset.name} graphics`;
  return `Custom graphics · ${count} settings`;
}

export type SoundKind = Exclude<ProfileFileKind, "mod">;

export const SOUND_FILES: Record<SoundKind, { label: string; file: string }> = {
  weaponSounds: { label: "Weapon sounds", file: "WEAPONS_PLAYER.rpf" },
  residentSounds: { label: "Resident sounds", file: "RESIDENT.rpf" },
};

export interface ProfileFiles {
  weaponSounds: Pack | null;
  residentSounds: Pack | null;
  mods: Pack[];
  /** Packs imported into the old pack library (v0.1) that this profile still uses. */
  older: Pack[];
}

/** The profile's packs sorted into its upload slots. */
export function profileFiles(packIds: string[], packs: Pack[]): ProfileFiles {
  const files: ProfileFiles = { weaponSounds: null, residentSounds: null, mods: [], older: [] };
  for (const id of packIds) {
    const pack = packs.find((p) => p.id === id);
    if (!pack) continue;
    if (pack.profileFile === "mod") files.mods.push(pack);
    else if (pack.profileFile) files[pack.profileFile] = pack;
    else files.older.push(pack);
  }
  return files;
}

/** Put `packId` in a sound slot (replacing what was there), or empty it with null. */
export function setSoundFile(
  packIds: string[],
  packs: Pack[],
  kind: SoundKind,
  packId: string | null,
): string[] {
  const kept = packIds.filter((id) => packs.find((p) => p.id === id)?.profileFile !== kind);
  // Last wins when two packs ship the same file, so uploads go after older packs.
  return packId ? [...kept, packId] : kept;
}

/** One line for the profile card: what the profile installs. */
export function filesSummary(profile: Profile, packs: Pack[]): string {
  const files = profileFiles(profile.packs, packs);
  const parts: string[] = [];
  if (files.weaponSounds) parts.push("Weapon sounds");
  if (files.residentSounds) parts.push("Resident sounds");
  if (files.mods.length) parts.push(plural(files.mods.length, "mod"));
  if (files.older.length) parts.push(plural(files.older.length, "pack"));
  return parts.length ? parts.join(" · ") : "Vanilla sounds · no mods";
}

/** What to call the profile's server: its name, or the address. */
export function serverLabel(profile: Profile): string | null {
  return profile.serverName || profile.serverAddress;
}

/** A sensible starting value for a setting that's being switched on. */
export function defaultValue(def: SettingDef, current?: string): string {
  if (current !== undefined) return current;
  switch (def.control.kind) {
    case "select":
      return def.control.options[0]?.value ?? "0";
    case "toggle":
      return "false";
    case "slider":
      return def.control.max.toFixed(6);
    case "number":
      return String(def.control.min);
  }
}

/** Format a value the way the backend stores it (sliders keep six decimals). */
export function normalizeValue(def: SettingDef, value: string): string {
  if (def.control.kind === "slider") {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(6) : value;
  }
  return value;
}

export function displayValue(def: SettingDef | undefined, value: string | undefined): string {
  if (value === undefined) return "—";
  if (!def) return value;
  switch (def.control.kind) {
    case "select":
      return def.control.options.find((o) => o.value === value)?.label ?? value;
    case "toggle":
      return value === "true" ? "On" : "Off";
    case "slider":
      return `${Math.round(Number(value) * 100)}%`;
    case "number":
      return value;
  }
}

export function isProfileKey(key: string): boolean {
  return key.toLowerCase().startsWith("profile_");
}
