import { importCodeWalkerXml } from "../core/awc/codewalkerXml";
import { parseAwc } from "../core/awc/read";
import { writeAwc } from "../core/awc/write";
import { guessPack, isValidPackName, normalizeFileName } from "../core/catalog";
import type { ImportReport, LibraryTemplate, TemplateData } from "../ipc";
import { basename, dirname, join, readJson, readText, type Host } from "./host";

interface Meta {
  importedAt: string;
  origin: LibraryTemplate["origin"];
  streamCount: number;
  names: Record<number, string>;
}

/**
 * Imported template banks, stored as plain unencrypted .awc files under
 * <root>/<pack>/<file> with a <file>.meta.json sidecar (stream names, origin).
 */
export class TemplateLibrary {
  constructor(
    readonly host: Host,
    readonly root: string,
  ) {}

  private paths(pack: string, file: string): { awc: string; meta: string } {
    if (!isValidPackName(pack)) throw new Error(`Invalid wave pack name "${pack}".`);
    const f = normalizeFileName(file);
    if (!/^[a-z0-9_.-]+$/.test(f)) throw new Error(`Invalid bank file name "${file}".`);
    const awc = join(this.root, pack, f);
    return { awc, meta: `${awc}.meta.json` };
  }

  async list(): Promise<LibraryTemplate[]> {
    const out: LibraryTemplate[] = [];
    for (const pack of await this.host.readdir(this.root)) {
      if (!isValidPackName(pack)) continue;
      const dir = join(this.root, pack);
      if (!(await this.host.stat(dir))?.isDir) continue;
      for (const file of await this.host.readdir(dir)) {
        if (!file.endsWith(".awc")) continue;
        out.push(await this.describe(pack, file));
      }
    }
    return out.sort((a, b) => a.pack.localeCompare(b.pack) || a.file.localeCompare(b.file));
  }

  private async readMeta(pack: string, file: string): Promise<Meta | undefined> {
    try {
      return await readJson<Meta>(this.host, this.paths(pack, file).meta);
    } catch {
      return undefined;
    }
  }

  private async describe(pack: string, file: string): Promise<LibraryTemplate> {
    const { awc } = this.paths(pack, file);
    const meta = await this.readMeta(pack, file);
    const size = (await this.host.stat(awc))?.size ?? 0;
    return {
      pack,
      file,
      streamCount: meta?.streamCount ?? parseAwc(await this.host.readFile(awc)).streams.length,
      sizeBytes: size,
      importedAt: meta?.importedAt ?? new Date(0).toISOString(),
      origin: meta?.origin ?? "awc",
      hasNames: Object.keys(meta?.names ?? {}).length > 0,
    };
  }

  private async store(
    pack: string,
    file: string,
    bytes: Uint8Array,
    meta: Meta,
  ): Promise<LibraryTemplate> {
    const p = this.paths(pack, file);
    await this.host.writeFile(p.awc, bytes);
    await this.host.writeFile(p.meta, JSON.stringify(meta));
    return this.describe(pack, normalizeFileName(file));
  }

  async importAwc(paths: string[]): Promise<ImportReport> {
    const report: ImportReport = { imported: [], errors: [], warnings: [] };
    for (const path of paths) {
      const name = basename(path);
      try {
        const awc = parseAwc(await this.host.readFile(path));
        const file = normalizeFileName(name);
        // Store our own serialization so the library only ever holds clean, unencrypted banks.
        const t = await this.store(guessPack(file), file, writeAwc(awc), {
          importedAt: new Date().toISOString(),
          origin: "awc",
          streamCount: awc.streams.length,
          names: (await this.readMeta(guessPack(file), file))?.names ?? {},
        });
        report.imported.push(t);
      } catch (e) {
        report.errors.push({ name, message: (e as Error).message });
      }
    }
    return report;
  }

  /** Accepts .awc.xml files and/or folders containing them (CodeWalker "Export XML" output). */
  async importCodeWalker(paths: string[]): Promise<ImportReport> {
    const report: ImportReport = { imported: [], errors: [], warnings: [] };
    const xmls: string[] = [];
    for (const p of paths) {
      if ((await this.host.stat(p))?.isDir) {
        const found = (await this.host.readdir(p)).filter((f) =>
          f.toLowerCase().endsWith(".awc.xml"),
        );
        if (found.length === 0)
          report.errors.push({ name: basename(p), message: "No .awc.xml files in this folder." });
        xmls.push(...found.map((f) => join(p, f)));
      } else {
        xmls.push(p);
      }
    }
    for (const xmlPath of xmls) {
      const name = basename(xmlPath);
      try {
        if (!name.toLowerCase().endsWith(".awc.xml"))
          throw new Error("Expected a CodeWalker .awc.xml file.");
        const file = normalizeFileName(name.slice(0, -".xml".length));
        const wavDirs = [
          join(dirname(xmlPath), name.slice(0, -".awc.xml".length)),
          dirname(xmlPath),
        ];
        const xml = await readText(this.host, xmlPath);
        const wavs = new Map<string, Uint8Array>();
        for (const d of wavDirs) {
          for (const f of await this.host.readdir(d)) {
            if (f.toLowerCase().endsWith(".wav") && !wavs.has(f.toLowerCase())) {
              wavs.set(f.toLowerCase(), await this.host.readFile(join(d, f)));
            }
          }
        }
        const result = importCodeWalkerXml(xml, (n) => wavs.get(n.toLowerCase()));
        const t = await this.store(guessPack(file), file, writeAwc(result.awc), {
          importedAt: new Date().toISOString(),
          origin: "codewalker-xml",
          streamCount: result.awc.streams.length,
          names: result.names,
        });
        report.imported.push(t);
        report.warnings.push(...result.warnings.map((w) => `${name}: ${w}`));
      } catch (e) {
        report.errors.push({ name, message: (e as Error).message });
      }
    }
    return report;
  }

  /** Banks the CodeWalker bridge extracted from the game (already unencrypted). */
  async importExtracted(
    items: { pack: string; file: string; path: string; names: Record<string, string> }[],
  ): Promise<ImportReport> {
    const report: ImportReport = { imported: [], errors: [], warnings: [] };
    for (const item of items) {
      try {
        const awc = parseAwc(await this.host.readFile(item.path));
        const names: Record<number, string> = {};
        for (const [id, name] of Object.entries(item.names)) names[Number(id) & 0x1fffffff] = name;
        const t = await this.store(item.pack, item.file, writeAwc(awc), {
          importedAt: new Date().toISOString(),
          origin: "gta",
          streamCount: awc.streams.length,
          names: Object.keys(names).length
            ? names
            : ((await this.readMeta(item.pack, item.file))?.names ?? {}),
        });
        report.imported.push(t);
      } catch (e) {
        report.errors.push({ name: `${item.pack}/${item.file}`, message: (e as Error).message });
      }
    }
    return report;
  }

  async read(pack: string, file: string): Promise<TemplateData> {
    const p = this.paths(pack, file);
    return {
      bytes: await this.host.readFile(p.awc),
      names: (await this.readMeta(pack, file))?.names ?? {},
    };
  }

  async remove(pack: string, file: string): Promise<void> {
    const p = this.paths(pack, file);
    await this.host.rm(p.awc);
    await this.host.rm(p.meta);
  }

  async setPack(pack: string, file: string, newPack: string): Promise<LibraryTemplate> {
    const from = this.paths(pack, file);
    const to = this.paths(newPack, file);
    if (from.awc === to.awc) return this.describe(pack, normalizeFileName(file));
    if (await this.host.exists(to.awc))
      throw new Error(`${newPack}/${normalizeFileName(file)} already exists in the library.`);
    await this.host.mkdir(dirname(to.awc));
    await this.host.rename(from.awc, to.awc);
    if (await this.host.exists(from.meta)) await this.host.rename(from.meta, to.meta);
    return this.describe(newPack, normalizeFileName(file));
  }
}

/** A small JSON file (settings, labels). */
export class JsonStore<T extends object> {
  constructor(
    readonly host: Host,
    readonly path: string,
  ) {}

  async get(): Promise<Partial<T>> {
    try {
      return await readJson<Partial<T>>(this.host, this.path);
    } catch {
      return {};
    }
  }

  async update(patch: Partial<T>): Promise<Partial<T>> {
    const next = { ...(await this.get()), ...patch };
    await this.host.writeFile(this.path, JSON.stringify(next, null, 1));
    return next;
  }
}

/** Stream labels the user typed, keyed "<pack>/<file>:<HEXID>". */
export class LabelStore {
  constructor(
    readonly host: Host,
    readonly path: string,
  ) {}

  async get(): Promise<Record<string, string>> {
    try {
      return await readJson<Record<string, string>>(this.host, this.path);
    } catch {
      return {};
    }
  }

  async set(key: string, label: string | null): Promise<void> {
    const all = await this.get();
    const trimmed = label?.trim();
    if (trimmed) all[key] = trimmed.slice(0, 120);
    else delete all[key];
    await this.host.writeFile(this.path, JSON.stringify(all, null, 1));
  }
}
