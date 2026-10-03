import type {
  GraphicsSchema,
  InstallRoot,
  Pack,
  PackCategory,
  Preset,
  Profile,
  SettingDef,
} from "../api/types";

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

export const CATEGORY_LABEL: Record<PackCategory, string> = {
  soundPack: "Sound pack",
  citizen: "Citizen pack",
  mods: "Mods",
  reshade: "ReShade / visuals",
  other: "Other",
};

export const CATEGORY_ORDER: PackCategory[] = ["soundPack", "citizen", "reshade", "mods", "other"];

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

export function packNames(profile: Profile, packs: Pack[]): string[] {
  return profile.packs
    .map((id) => packs.find((p) => p.id === id)?.name)
    .filter((name): name is string => Boolean(name));
}

export interface Conflict {
  path: string;
  root: InstallRoot;
  packs: string[];
}

/** Files shipped by more than one of the given packs (the later pack wins). */
export function packConflicts(selected: Pack[]): Conflict[] {
  const seen = new Map<string, Conflict>();
  for (const pack of selected) {
    for (const file of pack.files) {
      const key = `${pack.root}:${file.path.toLowerCase()}`;
      const existing = seen.get(key);
      if (existing) existing.packs.push(pack.name);
      else seen.set(key, { path: file.path, root: pack.root, packs: [pack.name] });
    }
  }
  return [...seen.values()].filter((c) => c.packs.length > 1);
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
