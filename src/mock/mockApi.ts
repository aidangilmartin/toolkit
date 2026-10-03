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
  ImportProposal,
  KeyChange,
  Pack,
  PackLayout,
  Profile,
  Progress,
  Server,
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

function packFiles(paths: [string, number][]) {
  return paths.map(([path, size], i) => ({ path, size, hash: `h${i}${path.length}` }));
}

const packs: Pack[] = [
  {
    id: "p-sounds",
    name: "Crisp PvP Gun Sounds",
    category: "soundPack",
    root: "gtaInstall",
    files: packFiles([
      ["x64/audio/sfx/RESIDENT.rpf", 41_200_000],
      ["x64/audio/sfx/WEAPONS_PLAYER.rpf", 146_800_000],
    ]),
    docs: ["readme.txt"],
    totalSize: 188_000_000,
    sourceName: "Crisp PvP Gun Sounds v3.zip",
    importedAt: ago(60 * 26),
    notes: "",
  },
  {
    id: "p-citizen",
    name: "Clean PvP Citizen",
    category: "citizen",
    root: "fivemApp",
    files: packFiles([
      ["citizen/common/data/timecycle/timecycle_mods_4.xml", 820_000],
      ["citizen/common/data/visualsettings.dat", 95_000],
      ["citizen/common/data/effects/peds/first_person.meta", 12_000],
      ["citizen/platform/levels/gta5/clouds.ytd", 5_300_000],
    ]),
    docs: [],
    totalSize: 6_227_000,
    sourceName: "clean-pvp-citizen",
    importedAt: ago(60 * 50),
    notes: "",
  },
  {
    id: "p-reshade",
    name: "Cinematic ReShade",
    category: "reshade",
    root: "fivemApp",
    files: packFiles([
      ["plugins/ReShade.ini", 4_000],
      ["plugins/dxgi.dll", 6_100_000],
      ["plugins/cinematic.ini", 6_000],
      ["plugins/reshade-shaders/Shaders/qUINT_lightroom.fx", 52_000],
    ]),
    docs: ["preview.jpg"],
    totalSize: 6_162_000,
    sourceName: "Cinematic ReShade",
    importedAt: ago(60 * 24 * 6),
    notes: "",
  },
  {
    id: "p-nve",
    name: "Night Lights Visual Mod",
    category: "mods",
    root: "fivemApp",
    files: packFiles([["mods/night_lights.rpf", 412_000_000]]),
    docs: [],
    totalSize: 412_000_000,
    sourceName: "night_lights.rpf",
    importedAt: ago(60 * 24 * 12),
    notes: "",
  },
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
    packs: ["p-sounds", "p-citizen"],
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
    packs: ["p-reshade"],
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
    createdAt: ago(60 * 24 * 2),
    updatedAt: ago(60 * 24 * 2),
  },
];

const servers: Server[] = [
  {
    id: "s1",
    name: "Arena PvP EU",
    address: "cfx.re/join/q4x9za",
    profileId: "arena",
    lastPlayedAt: ago(90),
  },
  {
    id: "s2",
    name: "Los Santos Life RP",
    address: "cfx.re/join/lsl8rp",
    profileId: "rp",
    lastPlayedAt: ago(60 * 24),
  },
  {
    id: "s3",
    name: "Friends' server",
    address: "51.68.12.4:30120",
    profileId: null,
    lastPlayedAt: null,
  },
];

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

function proposalFor(path: string, layout?: PackLayout | null): ImportProposal {
  const name =
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(zip|rpf)$/i, "") ?? "New pack";
  const isSound = /sound|gun|weapon|audio/i.test(path);
  const chosen: PackLayout = layout ?? (isSound ? "gtaAudio" : "fivemTree");
  const deploy =
    chosen === "gtaAudio"
      ? [
          ["WEAPONS_PLAYER.rpf", "x64/audio/sfx/WEAPONS_PLAYER.rpf", 151_000_000],
          ["RESIDENT.rpf", "x64/audio/sfx/RESIDENT.rpf", 40_100_000],
        ]
      : [
          [
            "citizen/common/data/timecycle/timecycle_mods_4.xml",
            "citizen/common/data/timecycle/timecycle_mods_4.xml",
            790_000,
          ],
          [
            "citizen/common/data/visualsettings.dat",
            "citizen/common/data/visualsettings.dat",
            92_000,
          ],
        ];
  return {
    sourcePath: path,
    sourceName: path.split(/[\\/]/).pop() ?? path,
    name,
    category: chosen === "gtaAudio" ? "soundPack" : "citizen",
    layout: chosen,
    root: chosen === "gtaAudio" ? "gtaInstall" : "fivemApp",
    files: [
      ...deploy.map(([source, dest, size]) => ({
        source: `${name}/${source}`,
        dest: String(dest),
        kind: "deploy" as const,
        reason: null,
        size: Number(size),
        include: true,
      })),
      {
        source: `${name}/README.txt`,
        dest: "README.txt",
        kind: "doc",
        reason: null,
        size: 1_200,
        include: true,
      },
      {
        source: `${name}/Install.exe`,
        dest: "Install.exe",
        kind: "blocked",
        reason: "Programs and scripts can't be installed",
        size: 2_400_000,
        include: false,
      },
      {
        source: "__MACOSX/._WEAPONS_PLAYER.rpf",
        dest: "",
        kind: "ignored",
        reason: "System junk file",
        size: 220,
        include: false,
      },
    ],
    warnings:
      chosen === "gtaAudio"
        ? [
            "Some files are blocked and won't be imported.",
            'This pack replaces GTA V game files. That also affects Story Mode and GTA Online, so use "Restore vanilla" before playing GTA Online.',
          ]
        : ["Some files are blocked and won't be imported."],
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
    const saved = { ...copy(profile), name: profile.name.trim(), updatedAt: now() };
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
    servers.forEach((s) => {
      if (s.profileId === profileId) s.profileId = null;
    });
    if (activeProfileId === profileId) activeProfileId = null;
  },

  async listServers() {
    await wait();
    return copy(servers);
  },
  async saveServer(server) {
    await wait();
    const address = server.address.trim().replace(/^https?:\/\//, "");
    if (!/^(cfx\.re\/join\/\w+|[\w.-]+\.[\w.-]+(:\d+)?|\w{5,8})$/i.test(address)) {
      throw "Use an IP:port (like 1.2.3.4:30120), a hostname, or a cfx.re/join code.";
    }
    const normalized = /^\w{5,8}$/.test(address) ? `cfx.re/join/${address}` : address;
    const saved = { ...copy(server), address: normalized, name: server.name.trim() || normalized };
    const index = servers.findIndex((s) => s.id === server.id);
    if (index >= 0) servers[index] = saved;
    else servers.push({ ...saved, id: id() });
    return copy(index >= 0 ? saved : servers[servers.length - 1]);
  },
  async deleteServer(serverId) {
    await wait();
    const index = servers.findIndex((s) => s.id === serverId);
    if (index >= 0) servers.splice(index, 1);
  },

  async listPacks() {
    await wait();
    return copy(packs);
  },
  async inspectPack(path, layout) {
    await wait(350);
    return proposalFor(path, layout);
  },
  async importPack(proposal) {
    const files = proposal.files.filter((f) => f.include && f.kind === "deploy");
    const total = files.reduce((sum, f) => sum + f.size, 0);
    let done = 0;
    for (const file of files) {
      emit({ stage: "copying", done, total, message: `Copying ${file.source}` });
      await wait(350);
      done += file.size;
    }
    const pack: Pack = {
      id: id(),
      name: proposal.name,
      category: proposal.category,
      root: proposal.layout === "gtaAudio" ? "gtaInstall" : "fivemApp",
      files: files.map((f) => ({ path: f.dest, size: f.size, hash: "x" })),
      docs: proposal.files.filter((f) => f.include && f.kind === "doc").map((f) => f.dest),
      totalSize: total,
      sourceName: proposal.sourceName,
      importedAt: now(),
      notes: "",
    };
    packs.push(pack);
    return copy(pack);
  },
  async updatePack(packId, name, category, notes) {
    await wait();
    const pack = packs.find((p) => p.id === packId);
    if (!pack) throw "That pack wasn't found";
    Object.assign(pack, { name, category, notes });
    return copy(pack);
  },
  async deletePack(packId) {
    await wait();
    if (deployed.some((d) => d.packId === packId)) {
      throw "This pack is installed right now. Apply a profile without it (or restore vanilla) first.";
    }
    const index = packs.findIndex((p) => p.id === packId);
    if (index >= 0) packs.splice(index, 1);
    profiles.forEach((p) => (p.packs = p.packs.filter((x) => x !== packId)));
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
  async connectServer(_address, serverId) {
    await wait(300);
    const server = servers.find((s) => s.id === serverId);
    if (server) server.lastPlayedAt = now();
  },
  async openFolder() {
    await wait(50);
  },

  async pickFolder() {
    await wait(200);
    return "C:\\Users\\Player\\Downloads\\Crisp Gun Sounds v3";
  },
  async pickPackFile() {
    await wait(200);
    return "C:\\Users\\Player\\Downloads\\Clean PvP Citizen.zip";
  },

  async onProgress(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
