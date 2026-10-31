/**
 * The sound maker's back end: everything the Electron main process used to do, on top of a Host
 * (files + the CodeWalker bridge) and a Shell (dialogs and the OS shell).
 */
import { installReadme, PACK_ARCHIVES, sanitizePackName } from "../core/pack";
import type { SoundMap } from "../core/usage";
import type { WeaponIndex } from "../core/weapons";
import type {
  Api,
  BankFile,
  ExportArchivesResult,
  ExportIdPackResult,
  GameSettings,
  ImportReport,
  PickedFile,
  ProjectFileSource,
  ScanReport,
  StoredWeaponIndex,
  VanillaStatus,
} from "../ipc";
import type { BuildRpfResult, ExtractResult, ScanResult } from "./bridge";
import { basename, isGtaFolder, join, readJson, type Host } from "./host";
import { buildIdPack } from "./idPack";
import { JsonStore, LabelStore, TemplateLibrary } from "./library";
import { packProject, unpackProject } from "./projectFile";
import { gunBanks, importPack, makePack, sourceArgs, vanillaKind, vanillaStatus } from "./vanilla";

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Dialogs and the OS shell. */
export interface Shell {
  pickFiles(opts: { title: string; filters?: FileFilter[]; multiple?: boolean }): Promise<string[]>;
  pickFolder(title: string): Promise<string | null>;
  pickSaveFile(opts: {
    title: string;
    defaultPath: string;
    filters: FileFilter[];
  }): Promise<string | null>;
  /** Asks a yes/no question; true means go ahead. */
  confirm(message: string, detail: string, okLabel: string): Promise<boolean>;
  showInFolder(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** The GTA V folder Loadout found, used until the player picks one here. */
  detectGtaFolder(): Promise<string | null>;
}

export const AUDIO_EXTENSIONS = ["wav", "mp3", "ogg", "flac", "m4a", "aac", "opus", "webm"];

/** The weapon index version that comes with a sound usage map. */
const INDEX_VERSION = 3;

export function createService(host: Host, shell: Shell): Api {
  const root = host.root;
  const library = new TemplateLibrary(host, join(root, "templates"));
  const labels = new LabelStore(host, join(root, "labels.json"));
  const settings = new JsonStore<{ gtaPath: string }>(host, join(root, "settings.json"));
  const indexPath = join(root, "weapon-index.json");
  const indexMetaPath = join(root, "weapon-index.meta.json");
  const mapPath = join(root, "sound-map.json");
  /** The vanilla pack the app works from (see vanilla.ts). */
  const vanillaDir = join(root, "vanilla");
  /** An optional list of known names (one per line) the player can drop in to get readable hashes. */
  const namesPath = join(root, "names.txt");

  const listeners = new Set<(message: string) => void>();
  const progress = (message: string): void => listeners.forEach((l) => l(message));

  let cachedMap: SoundMap | null = null;

  async function readSoundMap(): Promise<SoundMap | null> {
    if (cachedMap) return cachedMap;
    if (!(await host.exists(mapPath))) return null;
    cachedMap = await readJson<SoundMap>(host, mapPath);
    return cachedMap;
  }

  async function gameSettings(): Promise<GameSettings> {
    const s = await settings.get();
    const gtaPath = s.gtaPath ?? (await shell.detectGtaFolder()) ?? null;
    return {
      gtaPath,
      gtaValid: !!gtaPath && (await isGtaFolder(host, gtaPath)),
      confirmed: !!s.gtaPath && (await host.exists(indexPath)),
      bridgeAvailable: await host.bridgeAvailable(),
    };
  }

  /** Size + modified time of the game exe, to notice game updates after a scan. */
  async function exeSignature(gtaPath: string): Promise<string | null> {
    for (const exe of ["gta5.exe", "GTA5.exe", "gta5_enhanced.exe"]) {
      const st = await host.stat(join(gtaPath, exe));
      if (st) return `${st.size}:${Math.round(st.mtimeMs)}`;
    }
    return null;
  }

  /** Bridge arguments for the original sounds: the vanilla pack (plus the GTA V folder for an archives-only pack). */
  async function source(): Promise<string[]> {
    const game = await gameSettings();
    return sourceArgs(host, vanillaDir, game.gtaValid ? game.gtaPath : null);
  }

  /** Forgets the gun data of the previous pack, so the app asks to load the new one. */
  async function forgetLoadedPack(): Promise<void> {
    for (const p of [indexPath, indexMetaPath, mapPath]) await host.rm(p);
    cachedMap = null;
  }

  /** Asks before replacing files of ours in an existing export folder, then removes them. */
  async function clearExportFolder(folder: string, files: string[]): Promise<boolean> {
    const existing: string[] = [];
    for (const f of files) if (await host.exists(join(folder, f))) existing.push(f);
    if (existing.length) {
      const ok = await shell.confirm(
        `"${basename(folder)}" already has ${existing.join(", ")}.`,
        "Replacing overwrites those files.",
        "Replace",
      );
      if (!ok) return false;
      for (const f of existing) await host.rm(join(folder, f));
    }
    await host.mkdir(folder);
    return true;
  }

  async function readPicked(paths: string[]): Promise<PickedFile[]> {
    return Promise.all(
      paths.map(async (p) => ({ name: basename(p), bytes: await host.readFile(p) })),
    );
  }

  async function withTemp<T>(prefix: string, f: (dir: string) => Promise<T>): Promise<T> {
    const dir = await host.mkdtemp(prefix);
    try {
      return await f(dir);
    } finally {
      await host.rm(dir);
    }
  }

  /** Rebuilds the archives with `banks` into `folder` and writes the README. */
  async function buildArchives(
    original: string[],
    packName: string,
    banks: BankFile[],
    folder: string,
  ): Promise<ExportArchivesResult> {
    return withTemp("gsm-export-", async (tmp) => {
      const lines: string[] = [];
      for (const b of banks) {
        const path = join(tmp, `${b.pack}__${b.file}`);
        await host.writeFile(path, b.bytes);
        lines.push(`${b.pack}/${b.file}=${path}`);
      }
      const list = join(tmp, "banks.txt");
      await host.writeFile(list, lines.join("\n"));
      const result = await host.runBridge<BuildRpfResult>(
        ["build-rpf", ...original, "--out", folder, "--bank-list", list],
        progress,
      );
      const files = result.archives.map((a) => a.file);
      await host.writeFile(
        join(folder, "README.txt"),
        installReadme(packName, files).replace(/\n/g, "\r\n"),
      );
      return {
        folder,
        archives: result.archives.map((a) => ({
          file: a.file,
          path: a.path,
          size: a.size,
          replaced: a.replaced,
        })),
        errors: result.errors.map((e) => `${e.pack}/${e.file}: ${e.error}`),
      };
    });
  }

  return {
    listTemplates: () => library.list(),

    importAwcFiles: async (paths) => {
      const files = paths?.length
        ? paths
        : await shell.pickFiles({
            title: "Import .awc sound banks",
            multiple: true,
            filters: [{ name: "AWC sound bank", extensions: ["awc"] }],
          });
      return library.importAwc(files);
    },

    importCodeWalkerFolders: async (paths) => {
      const files = paths?.length
        ? paths
        : await shell.pickFiles({
            title: "Import CodeWalker XML export (.awc.xml)",
            multiple: true,
            filters: [{ name: "CodeWalker AWC XML", extensions: ["xml"] }],
          });
      return library.importCodeWalker(files);
    },

    readTemplate: (pack, file) => library.read(pack, file),
    removeTemplate: (pack, file) => library.remove(pack, file),
    setTemplatePack: (pack, file, newPack) => library.setPack(pack, file, newPack),

    getLabels: () => labels.get(),
    setLabel: (key, label) => labels.set(key, label),

    pickAudioFiles: async () =>
      readPicked(
        await shell.pickFiles({
          title: "Add sounds",
          multiple: true,
          filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
        }),
      ),

    readFiles: (paths) =>
      readPicked(
        paths.filter((p) => AUDIO_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(`.${ext}`))),
      ),

    saveProject: async (json: string, sources: ProjectFileSource[], path: string | null) => {
      let target = path;
      if (!target) {
        const picked = await shell.pickSaveFile({
          title: "Save project",
          defaultPath: "my_gunpack.gunpack",
          filters: [{ name: "Gun soundpack project", extensions: ["gunpack"] }],
        });
        if (!picked) return null;
        target = picked.toLowerCase().endsWith(".gunpack") ? picked : `${picked}.gunpack`;
      }
      await host.writeFile(target, packProject(json, sources));
      return target;
    },

    openProject: async () => {
      const [path] = await shell.pickFiles({
        title: "Open project",
        filters: [{ name: "Gun soundpack project", extensions: ["gunpack"] }],
      });
      if (!path) return null;
      return { path, ...unpackProject(await host.readFile(path)) };
    },

    exportArchives: async (name, banks): Promise<ExportArchivesResult | null> => {
      const original = await source();
      const parent = await shell.pickFolder("Choose where to save the sound pack");
      if (!parent) return null;
      const packName = sanitizePackName(name);
      const folder = join(parent, packName);
      if (!(await clearExportFolder(folder, ["README.txt", ...Object.values(PACK_ARCHIVES)])))
        return null;
      return buildArchives(original, packName, banks, folder);
    },

    exportToLoadout: async (name, banks) => {
      const original = await source();
      const packName = sanitizePackName(name);
      const folder = join(root, "exports", packName);
      await host.rm(folder);
      return buildArchives(original, packName, banks, folder);
    },

    exportIdPack: async (name, banks): Promise<ExportIdPackResult | null> => {
      const original = await source();
      const map = await readSoundMap();
      if (!map)
        throw new Error("Load the vanilla pack again first: the ID pack needs the sound map.");
      const parent = await shell.pickFolder("Choose where to save the ID pack");
      if (!parent) return null;
      const folder = join(parent, sanitizePackName(name));
      if (
        !(await clearExportFolder(folder, [
          "README.txt",
          "ID-LEGEND.txt",
          ...Object.values(PACK_ARCHIVES),
        ]))
      )
        return null;
      return withTemp("gsm-idpack-", (tmp) =>
        buildIdPack({ host, source: original, map, banks, folder, tmp, progress }),
      );
    },

    getGameSettings: () => gameSettings(),

    setGtaPath: async (path) => {
      const dir = path ?? (await shell.pickFolder("Select your Grand Theft Auto V folder"));
      if (!dir) return gameSettings();
      if (!(await isGtaFolder(host, dir)))
        throw new Error(
          `gta5.exe was not found in ${dir}. Choose the folder GTA V is installed in.`,
        );
      await settings.update({ gtaPath: dir });
      return gameSettings();
    },

    getVanillaStatus: (): Promise<VanillaStatus> => vanillaStatus(host, vanillaDir),

    importVanillaPack: async (from, path) => {
      const src =
        path ??
        (from === "zip"
          ? (
              await shell.pickFiles({
                title: "Choose a vanilla pack (.zip)",
                filters: [{ name: "Vanilla pack", extensions: ["zip"] }],
              })
            )[0]
          : await shell.pickFolder("Choose a vanilla pack folder"));
      if (!src) return null;
      await importPack(host, src, vanillaDir, progress);
      await forgetLoadedPack();
      return vanillaStatus(host, vanillaDir);
    },

    makeVanillaPack: async () => {
      const s = await gameSettings();
      if (!s.gtaPath || !s.gtaValid)
        throw new Error("Choose your GTA V folder first (the one containing gta5.exe).");
      await makePack(host, s.gtaPath, vanillaDir, {
        names: (await host.exists(namesPath)) ? namesPath : undefined,
        appVersion: host.appVersion,
        progress,
      });
      await settings.update({ gtaPath: s.gtaPath });
      await forgetLoadedPack();
      return vanillaStatus(host, vanillaDir);
    },

    saveVanillaZip: async () => {
      if (!(await vanillaKind(host, vanillaDir)))
        throw new Error("There is no vanilla pack to save yet.");
      const picked = await shell.pickSaveFile({
        title: "Save the vanilla pack",
        defaultPath: "gta-v-vanilla-pack.zip",
        filters: [{ name: "Vanilla pack", extensions: ["zip"] }],
      });
      if (!picked) return null;
      const target = picked.toLowerCase().endsWith(".zip") ? picked : `${picked}.zip`;
      await host.runBridge(["zip", "--in", vanillaDir, "--out", target], progress);
      return target;
    },

    loadVanillaPack: async (): Promise<ScanReport> => {
      const kind = await vanillaKind(host, vanillaDir);
      const original = await source();
      return withTemp("gsm-load-", async (out) => {
        let result: {
          extracted: ExtractResult["extracted"];
          errors: ExtractResult["errors"];
          weapons: number;
          warnings: string[];
        };
        let indexFile: string;
        let soundMapFile: string;
        if (kind === "self-contained") {
          indexFile = join(vanillaDir, "weapon-index.json");
          soundMapFile = join(vanillaDir, "sound-map.json");
          const index = await readJson<WeaponIndex>(host, indexFile);
          const banks = gunBanks(index);
          const extract = banks.length
            ? await host.runBridge<ExtractResult>(
                ["extract", ...original, "--out", out, ...banks.flatMap((b) => ["--bank", b])],
                progress,
              )
            : { extracted: [], errors: [] };
          result = { ...extract, weapons: index.weapons.length, warnings: index.warnings ?? [] };
        } else {
          const names = (await host.exists(namesPath)) ? ["--names", namesPath] : [];
          const scan = await host.runBridge<ScanResult>(
            ["scan", ...original, "--out", out, ...names],
            progress,
          );
          indexFile = scan.indexPath;
          soundMapFile = scan.mapPath;
          result = scan;
        }
        progress("Adding sound banks to your library");
        // banks read from an earlier source (e.g. the live game) must not stand in for the originals
        for (const t of await library.list())
          if (t.origin === "gta") await library.remove(t.pack, t.file);
        const banks = await library.importExtracted(result.extracted);
        banks.errors.push(
          ...result.errors.map((e) => ({ name: `${e.pack}/${e.file}`, message: e.error })),
        );
        await host.writeFile(indexPath, await host.readFile(indexFile));
        await host.writeFile(mapPath, await host.readFile(soundMapFile));
        cachedMap = null;
        const game = await gameSettings();
        const gtaPath = kind === "archives" ? game.gtaPath : null;
        await host.writeFile(
          indexMetaPath,
          JSON.stringify({
            kind,
            gtaPath,
            exe: gtaPath ? await exeSignature(gtaPath) : null,
            scannedAt: new Date().toISOString(),
          }),
        );
        return { weapons: result.weapons, banks, warnings: result.warnings };
      });
    },

    getWeaponIndex: async (): Promise<StoredWeaponIndex | null> => {
      if (!(await host.exists(indexPath))) return null;
      const index = await readJson<WeaponIndex>(host, indexPath);
      let meta: { gtaPath?: string; exe?: string | null; scannedAt?: string } = {};
      try {
        meta = await readJson(host, indexMetaPath);
      } catch {
        // older scans have no metadata
      }
      const now = meta.gtaPath ? await exeSignature(meta.gtaPath) : null;
      return {
        index,
        scannedAt: meta.scannedAt ?? "",
        stale: !!meta.exe && !!now && meta.exe !== now,
        outdated: (index.version ?? 1) < INDEX_VERSION || !(await host.exists(mapPath)),
        missingPack: !(await vanillaKind(host, vanillaDir)),
      };
    },

    getSoundMap: () => readSoundMap(),

    loadGameBanks: async (banks): Promise<ImportReport> => {
      const original = await source();
      return withTemp("gsm-extract-", async (out) => {
        const result = await host.runBridge<ExtractResult>(
          ["extract", ...original, "--out", out, ...banks.flatMap((b) => ["--bank", b])],
          progress,
        );
        const report = await library.importExtracted(result.extracted);
        report.errors.push(
          ...result.errors.map((e) => ({ name: `${e.pack}/${e.file}`, message: e.error })),
        );
        return report;
      });
    },

    onGameProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    showInFolder: (path) => shell.showInFolder(path),
    openExternal: async (url) => {
      if (/^https:\/\//.test(url)) await shell.openExternal(url);
    },
  };
}
