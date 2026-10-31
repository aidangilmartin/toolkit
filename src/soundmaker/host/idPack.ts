import { parseAwc } from "../core/awc/read";
import { pickChannel } from "../core/dsp";
import {
  bankPitch,
  buildIdBank,
  clipCache,
  codeOf,
  composeClip,
  idCodes,
  idEligible,
  idLegend,
  layerDelay,
  stereoLeft,
  toneClip,
  type Clip,
} from "../core/idpack";
import { idPackReadme, PACK_ARCHIVES } from "../core/pack";
import type { SoundMap } from "../core/usage";
import { parseWav } from "../core/wav";
import { BridgeError, type BuildRpfResult, type ExtractResult } from "./bridge";
import { join, type Host } from "./host";

export interface IdPackOptions {
  host: Host;
  /** Bridge arguments for the original sounds (see vanilla.ts `sourceArgs`). */
  source: string[];
  map: SoundMap;
  /** "pack/bank.awc" keys to label. */
  banks: string[];
  /** Folder that receives the archives, README.txt and ID-LEGEND.txt. */
  folder: string;
  /** Scratch folder (removed by the caller). */
  tmp: string;
  progress?: (message: string) => void;
}

export interface IdPackResult {
  folder: string;
  archives: { file: string; path: string; size: number; replaced: string[] }[];
  /** Streams that got a label. */
  labelled: number;
  /** The Windows voice used, or null when the labels are beeps. */
  voice: string | null;
  warnings: string[];
  errors: string[];
}

const yieldToEvents = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Builds the in-game ID pack: extracts the chosen banks from the game, replaces every sound with its
 * spoken code (or beeps without a voice), rebuilds WEAPONS_PLAYER.rpf / RESIDENT.rpf and writes the
 * legend that maps each code back to what the game data says the sound is for.
 */
export async function buildIdPack(o: IdPackOptions): Promise<IdPackResult> {
  const say = (m: string): void => o.progress?.(m);
  const host = o.host;
  const warnings: string[] = [];
  const errors: string[] = [];
  const banks = o.banks.filter((b) => {
    const pack = b.split("/")[0];
    const bank = o.map.banks[b];
    if (!bank || !(pack in PACK_ARCHIVES)) return false;
    if (bank.mc || bank.error) {
      warnings.push(
        `${b} is skipped: ${bank.mc ? "streamed multichannel banks cannot be relabelled" : bank.error}.`,
      );
      return false;
    }
    return true;
  });
  if (banks.length === 0) throw new Error("None of the chosen banks can be relabelled.");
  const codes = idCodes(o.map);

  say("Reading the banks from your game");
  const bankDir = join(o.tmp, "banks");
  const extracted = await host.runBridge<ExtractResult>(
    ["extract", ...o.source, "--out", bankDir, ...banks.flatMap((b) => ["--bank", b])],
    o.progress,
  );
  errors.push(...extracted.errors.map((e) => `${e.pack}/${e.file}: ${e.error}`));

  // speech: each bank's words once and each number once, joined per stream
  const words = [...new Set(banks.map((b) => codes.bankWords.get(b)!))];
  const maxIndex = Math.max(...banks.map((b) => o.map.banks[b].streams.length));
  const phrases = [
    ...words.map((w, i) => ({ id: `w${i}`, text: w, key: `w:${w}` })),
    ...Array.from({ length: maxIndex }, (_, i) => ({
      id: `n${i + 1}`,
      text: String(i + 1),
      key: `n:${i + 1}`,
    })),
  ];
  const parts = new Map<string, Clip>();
  let voice: string | null = null;
  try {
    say("Speaking the labels");
    const phrasesPath = join(o.tmp, "phrases.json");
    await host.writeFile(
      phrasesPath,
      JSON.stringify(phrases.map(({ id, text }) => ({ id, text }))),
    );
    const spoken = await host.runBridge<{ voice: string; files: { id: string; path: string }[] }>(
      ["speak", "--in", phrasesPath, "--out", join(o.tmp, "speech")],
      o.progress,
    );
    for (const f of spoken.files) {
      const p = phrases.find((x) => x.id === f.id);
      if (!p) continue;
      const wav = parseWav(await host.readFile(f.path));
      parts.set(p.key, { samples: pickChannel(wav, "mix"), rate: wav.sampleRate });
    }
    voice = spoken.voice;
  } catch (e) {
    if (!(e instanceof BridgeError && e.code === "no-tts")) throw e;
    warnings.push("No Windows voice was available, so the labels are beeps (see ID-LEGEND.txt).");
  }
  const part = clipCache(parts);

  const composed = new Map<string, Float32Array>();
  const labelFor = (bank: string, id: number, rate: number): Float32Array | null => {
    if (!idEligible(o.map, bank, id)) return null;
    const code = codeOf(codes, bank, stereoLeft(o.map, bank, id) ?? id);
    if (!code) return null;
    const lead = layerDelay(o.map, bank, id);
    const key = `${code.code}|${lead}|${rate}`;
    const hit = composed.get(key);
    if (hit) return hit;
    let clip: Float32Array;
    const w = part(`w:${code.words}`, rate);
    const n = part(`n:${code.index}`, rate);
    if (voice && w && n) clip = composeClip([w, n], rate, lead);
    else clip = composeClip([toneClip(code.index, rate, bankPitch(code.words))], rate, lead);
    composed.set(key, clip);
    return clip;
  };

  const lines: string[] = [];
  let labelled = 0;
  let n = 0;
  for (const e of extracted.extracted) {
    const key = `${e.pack}/${e.file}`.toLowerCase();
    say(`Labelling ${key} (${++n}/${extracted.extracted.length})`);
    await yieldToEvents();
    const bytes = await host.readFile(e.path);
    let awc;
    try {
      awc = parseAwc(bytes);
    } catch (err) {
      warnings.push(`${key} is skipped: ${(err as Error).message}`);
      continue;
    }
    const r = buildIdBank(awc, o.map.banks[key]?.size ?? bytes.length, (id, rate) =>
      labelFor(key, id, rate),
    );
    if (r.overBudget)
      warnings.push(
        `${key} is larger than the original even with short labels; the game may not load it.`,
      );
    labelled += r.replaced;
    const out = join(o.tmp, "labelled", `${e.pack}__${e.file}`);
    await host.writeFile(out, r.bytes);
    lines.push(`${e.pack}/${e.file}=${out}`);
  }
  if (lines.length === 0) throw new Error("No bank could be relabelled.");

  const listPath = join(o.tmp, "banks.txt");
  await host.writeFile(listPath, lines.join("\n"));
  const built = await host.runBridge<BuildRpfResult>(
    ["build-rpf", ...o.source, "--out", o.folder, "--bank-list", listPath],
    o.progress,
  );
  errors.push(...built.errors.map((e) => `${e.pack}/${e.file}: ${e.error}`));

  const files = built.archives.map((a) => a.file);
  await host.writeFile(join(o.folder, "README.txt"), idPackReadme(files).replace(/\n/g, "\r\n"));
  await host.writeFile(
    join(o.folder, "ID-LEGEND.txt"),
    idLegend(o.map, codes, banks, voice).replace(/\n/g, "\r\n"),
  );
  return {
    folder: o.folder,
    archives: built.archives.map((a) => ({
      file: a.file,
      path: a.path,
      size: a.size,
      replaced: a.replaced,
    })),
    labelled,
    voice,
    warnings,
    errors,
  };
}
