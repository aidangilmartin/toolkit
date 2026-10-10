/**
 * In-memory stand-in for the Rust backend, used when the UI runs in a normal
 * browser (`pnpm dev`) and for screenshots. It behaves like the real thing
 * closely enough to click through every screen, but never touches the disk.
 */
import type { Api } from "../api/client";
import type {
  AppConfig,
  AppStatus,
  ApplyPlan,
  CapturedSettings,
  DeployedFile,
  FileOpPlan,
  GraphicsSchema,
  KeyChange,
  Pack,
  Profile,
  ProfileFileKind,
  Progress,
  ServerInfo,
  ServerListing,
  ServerSearch,
  SettingsFilePlan,
  Snapshot,
} from "../api/types";
import schemaJson from "./schema.json";

const schema = schemaJson as unknown as GraphicsSchema;
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
let nextId = 100;
const id = () => `mock${nextId++}`;

type Values = Record<string, string>;
const clean = (values: { [key in string]?: string }): Values =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Values;
const preset = (name: string): Values =>
  clean(schema.presets.find((p) => p.id === name)?.values ?? {});

/** A server logo like the ones FiveM servers ship (96×96), drawn as SVG for the mock. */
function logo(from: string, to: string, text: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="96" height="96" rx="22" fill="url(#g)"/>` +
    `<circle cx="48" cy="48" r="34" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="3"/>` +
    `<text x="48" y="60" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="800" ` +
    `text-anchor="middle" fill="#fff">${text}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Servers the mock "finds" when looked up. */
const knownServers: Record<string, Omit<ServerInfo, "address">> = {
  "cfx.re/join/q4x9za": {
    name: "Arena PvP EU",
    icon: logo("#ef4444", "#7c2d12", "AP"),
    players: 87,
    maxPlayers: 128,
  },
  "cfx.re/join/lsl8rp": {
    name: "Los Santos Life RP",
    icon: logo("#3b82f6", "#1e1b4b", "LS"),
    players: 212,
    maxPlayers: 256,
  },
};

/** A stand-in for the FiveM server list (the real one has tens of thousands). */
const PALETTE = [
  ["#ef4444", "#7c2d12"],
  ["#3b82f6", "#1e1b4b"],
  ["#22c55e", "#064e3b"],
  ["#a855f7", "#312e81"],
  ["#f59e0b", "#7c2d12"],
  ["#ec4899", "#4a044e"],
  ["#14b8a6", "#134e4a"],
];
const LISTED: [string, string, string, number, number, string[]][] = [
  [
    "q4x9za",
    "Arena PvP EU",
    "Free-for-all and team deathmatch, no wait times",
    87,
    128,
    ["pvp", "arena", "deathmatch"],
  ],
  [
    "lsl8rp",
    "Los Santos Life RP",
    "Serious roleplay · whitelisted jobs · custom economy",
    212,
    256,
    ["roleplay", "serious", "economy"],
  ],
  [
    "vrp3ka",
    "Vinewood Roleplay",
    "Hollywood dreams in Los Santos. New players welcome",
    164,
    200,
    ["roleplay", "casual", "new players"],
  ],
  [
    "nfx92a",
    "NightFall RP | Whitelisted",
    "Gang and police roleplay with custom cars",
    301,
    300,
    ["roleplay", "gangs", "police"],
  ],
  [
    "pvpk1n",
    "KOTH Hill Battles",
    "King of the hill, three teams, one hill",
    140,
    160,
    ["pvp", "koth", "teams"],
  ],
  [
    "drf7tt",
    "Tokyo Drift Club",
    "Drift tracks, tuning and car meets",
    46,
    64,
    ["drift", "cars", "racing"],
  ],
  [
    "rcx5ln",
    "Redline Racing League",
    "Ranked street races every hour",
    58,
    96,
    ["racing", "cars", "ranked"],
  ],
  [
    "ems4us",
    "Sandy Shores Roleplay",
    "Small-town roleplay in Blaine County",
    38,
    64,
    ["roleplay", "rural"],
  ],
  [
    "zmb0ne",
    "Undead Zone",
    "Zombie survival, loot and bases",
    72,
    128,
    ["survival", "zombies", "pvp"],
  ],
  [
    "frz8gg",
    "FreeRoam Plus",
    "Freeroam with trainers and custom maps",
    25,
    48,
    ["freeroam", "casual"],
  ],
  [
    "cop1rp",
    "Blue Line RP",
    "Police and EMS focused roleplay",
    120,
    128,
    ["roleplay", "police", "ems"],
  ],
  [
    "gng6ls",
    "Grove Street Families RP",
    "Gang roleplay with a turf system",
    96,
    128,
    ["roleplay", "gangs"],
  ],
  ["pdm7cr", "Car Meet Central", "Showcase your build, weekly contests", 31, 64, ["cars", "meets"]],
  ["box2pv", "Box PvP 1v1", "1v1 arenas and gun game", 54, 64, ["pvp", "1v1", "gungame"]],
  [
    "hst5rp",
    "Heist City RP",
    "Heists, crews and a big economy",
    188,
    256,
    ["roleplay", "heists", "economy"],
  ],
  ["eu4srp", "Europa Roleplay [EU]", "European roleplay community", 143, 200, ["roleplay", "eu"]],
  ["de9rpx", "Deutsch RP", "Deutscher Roleplay-Server", 110, 128, ["roleplay", "german"]],
  ["fr3rpz", "France Roleplay", "Serveur roleplay francophone", 97, 128, ["roleplay", "french"]],
  [
    "sur8vv",
    "Wasteland Survival",
    "Hardcore survival with base building",
    19,
    64,
    ["survival", "hardcore"],
  ],
  [
    "trk4gg",
    "Trucking Simulator LS",
    "Haul cargo across San Andreas",
    12,
    32,
    ["jobs", "trucking"],
  ],
];
const listed: ServerListing[] = LISTED.map(
  ([id, name, description, players, maxPlayers, tags], i) => {
    const [from, to] = PALETTE[i % PALETTE.length];
    const letters = name
      .replace(/[^A-Za-z ]/g, "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    return {
      id,
      name,
      description,
      players,
      maxPlayers,
      iconUrl: i % 6 === 5 ? null : logo(from, to, letters),
      tags,
      locale: tags.includes("german") ? "de-DE" : tags.includes("french") ? "fr-FR" : "en-US",
    };
  },
);
let listLoaded = false;

/** Same ranking as the Rust side (server_list::search). */
function searchListed(input: string): ServerSearch {
  const query = input
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/|fivem:\/\/connect\/)/, "")
    .replace(/^cfx\.re\/join\//, "")
    .replace(/\/+$/, "");
  const words = query.split(/\s+/).filter(Boolean);
  const ranked = listed
    .map((server) => {
      const name = server.name.toLowerCase();
      const hay = [server.name, server.description, server.tags.join(" "), server.locale, server.id]
        .join(" ")
        .toLowerCase();
      let rank: number;
      if (!words.length) rank = 0;
      else if (server.id === query) rank = 4;
      else if (!words.every((w) => hay.includes(w))) return null;
      else if (name.startsWith(query)) rank = 3;
      else if (name.includes(query)) rank = 2;
      else rank = 1;
      return { rank, server };
    })
    .filter((r): r is { rank: number; server: ServerListing } => r !== null)
    .sort((a, b) => b.rank - a.rank || b.server.players - a.server.players);
  return {
    results: ranked.slice(0, 50).map((r) => r.server),
    matches: ranked.length,
    total: 31_482,
  };
}

const SOUND_DEST: Record<Exclude<ProfileFileKind, "mod">, string> = {
  weaponSounds: "x64/audio/sfx/WEAPONS_PLAYER.rpf",
  residentSounds: "x64/audio/sfx/RESIDENT.rpf",
};

function profileFile(
  packId: string,
  kind: ProfileFileKind,
  sourceName: string,
  size: number,
  daysAgo = 3,
): Pack {
  const stem = sourceName.replace(/\.(rpf|zip)$/i, "");
  const path = kind === "mod" ? `mods/${stem}.rpf` : SOUND_DEST[kind];
  return {
    id: packId,
    name: stem,
    category: kind === "mod" ? "mods" : "soundPack",
    root: kind === "mod" ? "fivemApp" : "gtaInstall",
    files: [{ path, size, hash: `h-${packId}` }],
    docs: [],
    totalSize: size,
    sourceName,
    importedAt: ago(60 * 24 * daysAgo),
    notes: "",
    profileFile: kind,
  };
}

const packs: Pack[] = [
  profileFile("f-arena-weapons", "weaponSounds", "Crisp PvP Weapons v3.rpf", 146_800_000),
  profileFile("f-arena-resident", "residentSounds", "Crisp PvP Resident.rpf", 41_200_000),
  profileFile("f-arena-skies", "mod", "clear_skies.rpf", 6_100_000, 4),
  profileFile("f-rp-blood", "mod", "better_blood.rpf", 18_400_000, 6),
  profileFile("f-rp-lights", "mod", "night_lights.rpf", 412_000_000, 12),
];

const profiles: Profile[] = [
  {
    id: "arena",
    name: "Arena – Max FPS",
    color: "#34d399",
    notes: "Low everything, crisp gun sounds.",
    graphics: { ...preset("max-fps"), "video/Windowed": "0", "video/VSync": "0" },
    applyToGta: false,
    fivemCfg: { profile_fpsFieldOfView: "10", profile_gfxBrightness: "6" },
    packs: ["f-arena-weapons", "f-arena-resident", "f-arena-skies"],
    serverAddress: "cfx.re/join/q4x9za",
    serverName: knownServers["cfx.re/join/q4x9za"].name,
    serverIcon: knownServers["cfx.re/join/q4x9za"].icon,
    createdAt: ago(60 * 24 * 5),
    updatedAt: ago(60 * 3),
  },
  {
    id: "rp",
    name: "City RP – Ultra",
    color: "#60a5fa",
    notes: "",
    graphics: { ...preset("ultra"), "video/Windowed": "2" },
    applyToGta: true,
    fivemCfg: { profile_fpsFieldOfView: "5" },
    packs: ["f-rp-blood", "f-rp-lights"],
    serverAddress: "cfx.re/join/lsl8rp",
    serverName: knownServers["cfx.re/join/lsl8rp"].name,
    serverIcon: knownServers["cfx.re/join/lsl8rp"].icon,
    createdAt: ago(60 * 24 * 5),
    updatedAt: ago(60 * 24),
  },
  {
    id: "stream",
    name: "Streaming",
    color: "#f472b6",
    notes: "",
    graphics: { ...preset("balanced"), "video/Windowed": "2" },
    applyToGta: false,
    fivemCfg: {},
    packs: [],
    serverAddress: null,
    serverName: null,
    serverIcon: null,
    createdAt: ago(60 * 24 * 2),
    updatedAt: ago(60 * 24 * 2),
  },
];

/** Same rules as the Rust side (launch::normalize_server_address), roughly. */
function normalizeAddress(input: string): string {
  const address = input
    .trim()
    .replace(/^(fivem:\/\/connect\/|https?:\/\/)/i, "")
    .replace(/\/+$/, "");
  if (/^\w{5,8}$/.test(address)) return `cfx.re/join/${address}`;
  if (/^cfx\.re\/join\/\w{5,8}$/i.test(address)) return address;
  if (/^([\w-]+\.)+[\w-]+(:\d{1,5})?$/.test(address) || /^localhost(:\d{1,5})?$/.test(address)) {
    return address;
  }
  throw "Use an IP:port (like 1.2.3.4:30120), a hostname, or a cfx.re/join code.";
}

const params = new URLSearchParams(globalThis.location?.search ?? "");

let config: AppConfig = {
  paths: { fivemAppDir: null, citizenfxDir: null, gtaInstallDir: null, gtaDocumentsDir: null },
  afterLaunch: "minimize",
  confirmFileChanges: true,
  setupComplete: params.get("setup") !== "1",
};

const fileValues: Values = {
  ...preset("high"),
  "video/Windowed": "2",
  "video/VSync": "1",
  "video/PauseOnFocusLoss": "1",
  "video/ScreenWidth": "2560",
  "video/ScreenHeight": "1440",
  "video/RefreshRate": "165",
  "video/AspectRatio": "0",
  "graphics/DX_Version": "2",
  "graphics/SamplingMode": "0",
  "graphics/PedLodBias": "0.200000",
  "graphics/VehicleLodBias": "0.000000",
  "graphics/Shadow_Distance": "1.000000",
  "graphics/Shader_SSA": "true",
};
const gtaValues: Values = { ...fileValues };
const cfgValues: Values = {
  profile_fpsFieldOfView: "5",
  profile_gfxBrightness: "4",
  profile_sfxVolume: "8",
  profile_musicVolume: "3",
  profile_displayRadar: "1",
  ui_streamerMode: "false",
  cl_drawFPS: "true",
};

let running: string[] = params.get("running") === "1" ? ["FiveM_b3258_GTAProcess.exe"] : [];
let activeProfileId: string | null = "arena";
let appliedAt: string | null = ago(95);
let deployed: DeployedFile[] = deployedFor(profiles[0]);
let notice: string | null = null;
const drift = params.get("drift") === "1";
const snapshots: Snapshot[] = [
  {
    id: "snap-3",
    createdAt: ago(95),
    label: 'Before applying "Arena – Max FPS"',
    files: [
      {
        target: "fivemGraphics",
        originalPath: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX\\gta5_settings.xml",
        file: "fivem-gta5_settings.xml",
      },
      {
        target: "fivemCfg",
        originalPath: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX\\fivem.cfg",
        file: "fivem.cfg",
      },
    ],
    pinned: false,
  },
  {
    id: "snap-2",
    createdAt: ago(60 * 24),
    label: 'Before applying "City RP – Ultra"',
    files: [
      {
        target: "fivemGraphics",
        originalPath: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX\\gta5_settings.xml",
        file: "fivem-gta5_settings.xml",
      },
    ],
    pinned: false,
  },
  {
    id: "snap-1",
    createdAt: ago(60 * 24 * 5),
    label: "Before Loadout (first run)",
    files: [
      {
        target: "fivemGraphics",
        originalPath: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX\\gta5_settings.xml",
        file: "fivem-gta5_settings.xml",
      },
      {
        target: "gtaGraphics",
        originalPath: "C:\\Users\\Player\\Documents\\Rockstar Games\\GTA V\\settings.xml",
        file: "gta-settings.xml",
      },
      {
        target: "fivemCfg",
        originalPath: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX\\fivem.cfg",
        file: "fivem.cfg",
      },
    ],
    pinned: true,
  },
];

// Arena is applied, so the files hold its values.
Object.assign(fileValues, clean(profiles[0].graphics));
Object.assign(cfgValues, clean(profiles[0].fivemCfg));

function deployedFor(profile: Profile | undefined): DeployedFile[] {
  if (!profile) return [];
  return profile.packs.flatMap((packId) => {
    const pack = packs.find((p) => p.id === packId);
    if (!pack) return [];
    return pack.files.map((file) => ({
      root: pack.root,
      rootDir: pack.root === "gtaInstall" ? "D:\\Games\\GTAV" : "C:\\FiveM\\FiveM.app",
      path: file.path,
      packId: pack.id,
      packPath: file.path,
      hash: file.hash,
      size: file.size,
      mtimeMs: 0,
      original: pack.root === "gtaInstall" ? { file: "orig", hash: "x", size: file.size } : null,
      createdDirs: [],
    }));
  });
}

const listeners = new Set<(p: Progress) => void>();
const emit = (p: Progress) => listeners.forEach((l) => l(p));

function diff(current: Values, overlay: Values): KeyChange[] {
  return Object.entries(overlay)
    .filter(([key, value]) => current[key] !== value)
    .map(([key, to]) => ({ key, from: current[key] ?? null, to }));
}

function plan(profileId: string | null): ApplyPlan {
  const profile = profiles.find((p) => p.id === profileId);
  const settings: SettingsFilePlan[] = [];
  if (profile) {
    const graphics = clean(profile.graphics);
    if (Object.keys(graphics).length) {
      settings.push({
        target: "fivemGraphics",
        path: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX\\gta5_settings.xml",
        changes: diff(fileValues, graphics),
        skipped: [],
      });
      if (profile.applyToGta) {
        settings.push({
          target: "gtaGraphics",
          path: "C:\\Users\\Player\\Documents\\Rockstar Games\\GTA V\\settings.xml",
          changes: diff(gtaValues, graphics),
          skipped: [],
        });
      }
    }
    const cfg = clean(profile.fivemCfg);
    if (Object.keys(cfg).length) {
      settings.push({
        target: "fivemCfg",
        path: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX\\fivem.cfg",
        changes: diff(cfgValues, cfg),
        skipped: [],
      });
    }
  }
  const wanted = deployedFor(profile);
  const key = (f: DeployedFile) => `${f.root}:${f.path.toLowerCase()}`;
  const files: FileOpPlan[] = [];
  for (const file of deployed) {
    const keep = wanted.find((w) => key(w) === key(file));
    if (!keep) {
      files.push({
        kind: "remove",
        root: file.root,
        path: `${file.root === "gtaInstall" ? "GTA V folder" : "FiveM.app"}/${file.path}`,
        packName: packs.find((p) => p.id === file.packId)?.name ?? null,
        size: file.original?.size ?? 0,
        backsUpOriginal: false,
        restoresOriginal: Boolean(file.original),
        note: null,
      });
    }
  }
  for (const file of wanted) {
    if (!deployed.some((d) => key(d) === key(file))) {
      files.push({
        kind: "install",
        root: file.root,
        path: `${file.root === "gtaInstall" ? "GTA V folder" : "FiveM.app"}/${file.path}`,
        packName: packs.find((p) => p.id === file.packId)?.name ?? null,
        size: file.size,
        backsUpOriginal: file.root === "gtaInstall" || file.path.includes("visualsettings"),
        restoresOriginal: false,
        note: null,
      });
    }
  }
  return {
    profileId,
    profileName: profile?.name ?? null,
    settings,
    files,
    conflicts: [],
    warnings: [],
    errors: [],
    copyBytes: files.reduce((sum, f) => sum + f.size, 0),
    runningProcesses: [...running],
  };
}

function status(): AppStatus {
  const active = profiles.find((p) => p.id === activeProfileId);
  return {
    paths: [
      {
        key: "fivemApp",
        label: "FiveM application data (FiveM.app)",
        path: "C:\\Users\\Player\\AppData\\Local\\FiveM\\FiveM.app",
        exists: true,
        source: "detected",
        hint: "Usually %LOCALAPPDATA%\\FiveM\\FiveM.app. Needed for citizen packs, mods and ReShade.",
      },
      {
        key: "citizenFx",
        label: "FiveM settings (CitizenFX)",
        path: "C:\\Users\\Player\\AppData\\Roaming\\CitizenFX",
        exists: true,
        source: "detected",
        hint: "Usually %APPDATA%\\CitizenFX. Holds gta5_settings.xml and fivem.cfg.",
      },
      {
        key: "gtaInstall",
        label: "GTA V game folder",
        path: config.paths.gtaInstallDir ?? "D:\\Games\\GTAV",
        exists: true,
        source: config.paths.gtaInstallDir ? "override" : "detected",
        hint: "The folder that contains GTA5.exe. Only needed for sound packs that replace game audio.",
      },
      {
        key: "gtaDocuments",
        label: "GTA V settings (Documents)",
        path: "C:\\Users\\Player\\Documents\\Rockstar Games\\GTA V",
        exists: true,
        source: "detected",
        hint: "Documents\\Rockstar Games\\GTA V. Only needed to apply graphics to Story Mode / GTA Online too.",
      },
    ],
    fivemExe: "C:\\Users\\Player\\AppData\\Local\\FiveM\\FiveM.exe",
    runningProcesses: [...running],
    activeProfileId,
    appliedAt,
    settingsDrift:
      drift && active
        ? [
            {
              target: "fivemGraphics",
              key: "graphics/ShadowQuality",
              applied: "1",
              current: "2",
            },
            { target: "fivemCfg", key: "profile_fpsFieldOfView", applied: "10", current: "12" },
          ]
        : [],
    fileDrift: [],
    deployedFiles: deployed,
    recoveryNotice: notice,
    dataDir: "C:\\Users\\Player\\AppData\\Local\\Loadout",
  };
}

const copy = <T>(value: T): T => structuredClone(value);

export const mockApi: Api & {
  setRunning(names: string[]): void;
  setNotice(text: string | null): void;
} = {
  isMock: true,

  setRunning(names) {
    running = names;
  },
  setNotice(text) {
    notice = text;
  },

  async getStatus() {
    await wait();
    return copy(status());
  },
  async runningProcesses() {
    await wait(40);
    return [...running];
  },
  async closeGame() {
    await wait(400);
    const count = running.length;
    running = [];
    return count;
  },
  async dismissNotice() {
    notice = null;
  },

  async getConfig() {
    await wait(60);
    return copy(config);
  },
  async saveConfig(next) {
    await wait();
    config = copy(next);
    return copy(config);
  },
  async completeSetup() {
    await wait(300);
    config = { ...config, setupComplete: true };
    return copy(config);
  },
  async getSchema() {
    return schema;
  },
  async captureCurrent(): Promise<CapturedSettings> {
    await wait();
    const graphicsAll = { ...fileValues };
    const graphicsDefault = Object.fromEntries(
      Object.entries(graphicsAll).filter(([key]) => {
        const def = schema.settings.find((s) => s.key === key);
        return def ? def.capture === "default" : key.startsWith("graphics/");
      }),
    );
    const cfgDefault = Object.fromEntries(
      Object.entries(cfgValues).filter(([key]) => key.startsWith("profile_")),
    );
    return {
      fivemGraphicsFound: true,
      graphicsAll,
      graphicsDefault,
      fivemCfgFound: true,
      cfgAll: { ...cfgValues },
      cfgDefault,
    };
  },

  async listProfiles() {
    await wait();
    return copy(profiles);
  },
  async saveProfile(profile) {
    await wait();
    if (!profile.name.trim()) throw "Give the profile a name (up to 60 characters).";
    const serverAddress = profile.serverAddress?.trim()
      ? normalizeAddress(profile.serverAddress)
      : null;
    const saved: Profile = {
      ...copy(profile),
      name: profile.name.trim(),
      serverAddress,
      serverName: serverAddress ? profile.serverName : null,
      serverIcon: serverAddress ? profile.serverIcon : null,
      updatedAt: now(),
    };
    const index = profiles.findIndex((p) => p.id === profile.id);
    if (index >= 0) profiles[index] = saved;
    else profiles.push({ ...saved, id: id(), createdAt: now() });
    return copy(index >= 0 ? saved : profiles[profiles.length - 1]);
  },
  async duplicateProfile(profileId) {
    await wait();
    const original = profiles.find((p) => p.id === profileId);
    if (!original) throw "That profile wasn't found";
    const duplicate = { ...copy(original), id: id(), name: `${original.name} (copy)` };
    profiles.push(duplicate);
    return copy(duplicate);
  },
  async deleteProfile(profileId) {
    await wait();
    const index = profiles.findIndex((p) => p.id === profileId);
    if (index >= 0) profiles.splice(index, 1);
    if (activeProfileId === profileId) activeProfileId = null;
  },

  async lookupServer(input) {
    await wait(700);
    const address = normalizeAddress(input);
    if (/bad|offline/i.test(address)) {
      throw `Couldn't reach ${address}. Check the address and that the server is online.`;
    }
    const known = knownServers[address.toLowerCase()];
    if (known) return copy({ address, ...known });
    const listing = listed.find((s) => `cfx.re/join/${s.id}` === address.toLowerCase());
    if (listing) {
      const { name, iconUrl, players, maxPlayers } = listing;
      return { address, name, icon: iconUrl, players, maxPlayers };
    }
    const words = ["Vinewood", "Paleto", "Sandy", "Vespucci", "Blaine", "Mirror Park"];
    const pick = words[[...address].reduce((sum, c) => sum + c.charCodeAt(0), 0) % words.length];
    return {
      address,
      name: `${pick} Roleplay`,
      icon: logo("#a855f7", "#312e81", pick.slice(0, 2).toUpperCase()),
      players: 34,
      maxPlayers: 64,
    };
  },
  async searchServers(query) {
    await wait(listLoaded ? 150 : 900);
    if (query.includes("offline!")) {
      throw "Couldn't load the FiveM server list. Check your connection, or paste the server's IP or cfx.re link instead.";
    }
    listLoaded = true;
    return copy(searchListed(query));
  },
  async readLogoFile() {
    await wait(120);
    return logo("#f59e0b", "#7c2d12", "★");
  },

  async listPacks() {
    await wait();
    return copy(packs);
  },
  async importProfileFile(path, kind) {
    const sourceName = path.split(/[\\/]/).pop() ?? path;
    const size = 20_000_000 + (sourceName.length % 7) * 13_000_000;
    for (let done = 0; done <= size; done += size / 4) {
      emit({ stage: "copying", done, total: size, message: `Copying ${sourceName}` });
      await wait(120);
    }
    const pack = profileFile(id(), kind, sourceName, size, 0);
    pack.importedAt = now();
    packs.push(pack);
    return copy(pack);
  },

  async planApply(profileId) {
    await wait(250);
    return copy(plan(profileId));
  },
  async applyProfile(profileId) {
    if (running.length) throw `Close ${running.join(", ")} first, then try again`;
    const result = plan(profileId);
    const total = Math.max(result.copyBytes, 1);
    const steps = Math.max(result.files.length, 2);
    for (let i = 0; i < steps; i++) {
      emit({
        stage: "copying",
        done: Math.round((total * i) / steps),
        total,
        message: result.files[i] ? `Installed ${result.files[i].path}` : "Writing settings",
      });
      await wait(Math.min(260, 1500 / steps));
    }
    emit({ stage: "finishing", done: total, total, message: "Saving" });
    const profile = profiles.find((p) => p.id === profileId);
    if (profile) {
      Object.assign(fileValues, clean(profile.graphics));
      if (profile.applyToGta) Object.assign(gtaValues, clean(profile.graphics));
      Object.assign(cfgValues, clean(profile.fivemCfg));
    }
    deployed = deployedFor(profile);
    activeProfileId = profile?.id ?? null;
    appliedAt = now();
    return { plan: result, appliedAt, snapshotId: "snap-new" };
  },
  async saveDriftToProfile() {
    await wait();
    const profile = profiles.find((p) => p.id === activeProfileId);
    if (!profile) throw "No profile is active right now.";
    return copy(profile);
  },
  async dismissDrift() {
    await wait();
  },

  async listSnapshots() {
    await wait();
    return copy(snapshots);
  },
  async restoreSnapshot() {
    if (running.length) throw `Close ${running.join(", ")} first, then try again`;
    await wait(500);
  },
  async deleteSnapshot(snapshotId) {
    await wait();
    const index = snapshots.findIndex((s) => s.id === snapshotId);
    if (index >= 0) snapshots.splice(index, 1);
  },

  async launchFivem() {
    await wait(300);
  },
  async connectServer() {
    await wait(300);
  },
  async openFolder() {
    await wait(50);
  },

  async pickFolder() {
    await wait(200);
    return "C:\\Users\\Player\\Downloads\\Crisp Gun Sounds v3";
  },
  async pickProfileFiles(kind) {
    await wait(200);
    const downloads = "C:\\Users\\Player\\Downloads\\";
    if (kind === "weaponSounds") return [`${downloads}Glock Sounds v2\\WEAPONS_PLAYER.rpf`];
    if (kind === "residentSounds") return [`${downloads}Glock Sounds v2\\RESIDENT.rpf`];
    return [`${downloads}clear_water.rpf`, `${downloads}tracer_rounds.zip`];
  },
  async pickImage() {
    await wait(200);
    return "C:\\Users\\Player\\Pictures\\server-logo.png";
  },

  async onProgress(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
