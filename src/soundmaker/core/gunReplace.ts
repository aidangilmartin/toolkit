/**
 * One-drop gun replace: one recording of a gunshot fills every part of a gun's shot. The close shot
 * takes it as it is; the distant report, the echo, the indoor and the suppressed shot get versions
 * of it made here (filtered, with reverb), so far-away shots and echoes don't stay vanilla.
 *
 * Only this gun's own files change unless asked: files other guns fire too are left out by default.
 */

import { shotSharing, type GunSection } from "./describe";
import { dbToGain, peak, toInt16 } from "./dsp";
import type { StreamRef } from "./project";
import { encodeWav16Channels, type AudioData } from "./wav";

/** The versions of the dropped shot. */
export type ShotKind = "shot" | "indoor" | "suppressed" | "distant" | "echo";

export const SHOT_KINDS: ShotKind[] = ["shot", "indoor", "suppressed", "distant", "echo"];

export const SHOT_KIND_LABELS: Record<ShotKind, string> = {
  shot: "Gunshot",
  indoor: "Indoor shot",
  suppressed: "Suppressed shot",
  distant: "Distant report",
  echo: "Echo / tail",
};

/** What each made version is, for the file name and the dialog. */
export const SHOT_KIND_NOTES: Record<ShotKind, string> = {
  shot: "your file as it is",
  indoor: "with a short room reverb",
  suppressed: "muffled and quieter",
  distant: "muffled, with distance reverb",
  echo: "only the reverb tail",
};

/** Which version each weapon sound field gets. Other fields (reload, casings…) aren't touched. */
const KIND_OF_ROLE: Record<string, ShotKind> = {
  fire: "shot",
  auto: "shot",
  interior: "indoor",
  suppressed: "suppressed",
  report: "distant",
  echo: "echo",
  suppressedEcho: "echo",
};

export interface ReplaceGroup {
  kind: ShotKind;
  refs: StreamRef[];
}

export interface ReplacePlan {
  /** In SHOT_KINDS order, only kinds with files. */
  groups: ReplaceGroup[];
  /** Shot files other guns fire too, left out (or included when `includeShared`). */
  shared: StreamRef[];
  /** The guns those shared files belong to. */
  sharedGuns: string[];
}

const refKey = (r: StreamRef): string => `${r.pack}/${r.file}:${r.streamId}`.toLowerCase();

/**
 * Which of a gun's files each version goes to. A file in several parts gets the closest version
 * (the gunshot before the report, the report before the echo).
 */
export function planGunReplace(
  sections: GunSection[],
  opts: { includeShared?: boolean } = {},
): ReplacePlan {
  const kindOf = new Map<string, { ref: StreamRef; kind: ShotKind }>();
  const shared = new Map<string, StreamRef>();
  const sharedGuns = new Set<string>();
  for (const section of sections) {
    const kind = KIND_OF_ROLE[section.role];
    if (!kind) continue;
    for (const f of section.files) {
      const ref = { pack: f.pack, file: f.bank, streamId: f.streamId };
      const key = refKey(ref);
      const others = shotSharing(f);
      if (others.length) {
        shared.set(key, ref);
        others.forEach((o) => sharedGuns.add(o.gun));
        if (!opts.includeShared) continue;
      }
      const prev = kindOf.get(key);
      if (!prev || SHOT_KINDS.indexOf(kind) < SHOT_KINDS.indexOf(prev.kind))
        kindOf.set(key, { ref, kind });
    }
  }
  const groups = SHOT_KINDS.map((kind) => ({
    kind,
    refs: [...kindOf.values()].filter((v) => v.kind === kind).map((v) => v.ref),
  })).filter((g) => g.refs.length > 0);
  return {
    groups,
    shared: [...shared.values()],
    sharedGuns: [...sharedGuns].sort((a, b) => a.localeCompare(b)),
  };
}

// ---- Making the versions ---------------------------------------------------------------------

/** Two-pole low-pass (two one-poles in a row): soft, no ringing. */
function lowPass(x: Float32Array, rate: number, cutoff: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoff) / rate);
  const out = new Float32Array(x.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    y1 = (1 - a) * x[i] + a * y1;
    y2 = (1 - a) * y1 + a * y2;
    out[i] = y2;
  }
  return out;
}

/** One-pole high-pass, to keep reverb from building up rumble. */
function highPass(x: Float32Array, rate: number, cutoff: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoff) / rate);
  const out = new Float32Array(x.length);
  let px = 0;
  let py = 0;
  for (let i = 0; i < x.length; i++) {
    py = a * (py + x[i] - px);
    px = x[i];
    out[i] = py;
  }
  return out;
}

interface ReverbSettings {
  /** Seconds for the tail to fall 60 dB. */
  decay: number;
  predelayMs: number;
  /** Damping in the tail: higher is darker. */
  damping: number;
}

const COMBS_MS = [29.7, 37.1, 41.1, 43.7];
const ALLPASS_MS = [5.0, 1.7];

/**
 * A Schroeder reverb (four damped combs, two all-passes), wet only, with `tail` seconds added so
 * it can ring out. `spread` shifts the delays a little per channel for width.
 */
function reverb(
  x: Float32Array,
  rate: number,
  s: ReverbSettings,
  tail: number,
  spread: number,
): Float32Array {
  const pre = Math.round((s.predelayMs / 1000) * rate);
  const n = x.length + pre + Math.round(tail * rate);
  const input = new Float32Array(n);
  input.set(x, pre);
  const out = new Float32Array(n);
  for (const ms of COMBS_MS) {
    const d = Math.max(1, Math.round(((ms + spread) / 1000) * rate));
    const g = Math.pow(10, (-3 * d) / (s.decay * rate));
    const buf = new Float32Array(d);
    let pos = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[pos];
      lp = y * (1 - s.damping) + lp * s.damping;
      buf[pos] = input[i] + lp * g;
      out[i] += y / COMBS_MS.length;
      pos = (pos + 1) % d;
    }
  }
  for (const ms of ALLPASS_MS) {
    const d = Math.max(1, Math.round(((ms + spread / 4) / 1000) * rate));
    const buf = new Float32Array(d);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[pos];
      const v = out[i] + b * 0.7;
      buf[pos] = v;
      out[i] = b - v * 0.7;
      pos = (pos + 1) % d;
    }
  }
  return out;
}

const mixInto = (dry: Float32Array, wet: Float32Array, wetGain: number): Float32Array => {
  const out = new Float32Array(Math.max(dry.length, wet.length));
  out.set(dry);
  for (let i = 0; i < wet.length; i++) out[i] += wet[i] * wetGain;
  return out;
};

const scale = (x: Float32Array, g: number): Float32Array => x.map((v) => v * g);

/** Cuts trailing near-silence (below -60 dBFS) so tails don't carry seconds of nothing. */
function trimTail(channels: Float32Array[], rate: number): Float32Array[] {
  const floor = dbToGain(-60);
  let end = 0;
  for (const c of channels) {
    for (let i = c.length - 1; i > end; i--) {
      if (Math.abs(c[i]) > floor) {
        end = i;
        break;
      }
    }
  }
  const len = Math.min(channels[0].length, end + Math.round(0.02 * rate));
  return channels.map((c) => c.slice(0, len));
}

/** Scales every channel together so the loudest sample sits at `db` dBFS. */
function normalizeTo(channels: Float32Array[], db: number): Float32Array[] {
  const p = Math.max(...channels.map(peak));
  return p > 0 ? channels.map((c) => scale(c, dbToGain(db) / p)) : channels;
}

/** Fades the end out over `ms`, from `startS` seconds. */
function fadeAfter(x: Float32Array, rate: number, startS: number, ms: number): Float32Array {
  const start = Math.round(startS * rate);
  const len = Math.round((ms / 1000) * rate);
  const out = x.slice(0, Math.min(x.length, start + len));
  for (let i = start; i < out.length; i++) out[i] *= 1 - (i - start) / len;
  return out;
}

/**
 * The version of a gunshot for one part of the shot. The close shot is unchanged; the others keep
 * the recording's channels and rate. Levels are relative: the game's own curves still set how loud
 * each part plays at a distance.
 */
export function renderShotVersion(audio: AudioData, kind: ShotKind): AudioData {
  const rate = audio.sampleRate;
  const chans = audio.channels;
  let out: Float32Array[];
  switch (kind) {
    case "shot":
      return audio;
    case "indoor": {
      const room = { decay: 0.6, predelayMs: 8, damping: 0.35 };
      out = chans.map((c, i) =>
        mixInto(c, reverb(highPass(c, rate, 150), rate, room, 0.6, i * 1.3), 0.35),
      );
      out = normalizeTo(trimTail(out, rate), -1);
      break;
    }
    case "suppressed": {
      out = chans.map((c) => fadeAfter(lowPass(c, rate, 1100), rate, 0.25, 120));
      out = normalizeTo(out, -9);
      break;
    }
    case "distant": {
      const outdoors = { decay: 1.3, predelayMs: 25, damping: 0.5 };
      out = chans.map((c, i) => {
        const muffled = highPass(lowPass(c, rate, 900), rate, 120);
        return mixInto(muffled, reverb(muffled, rate, outdoors, 1.3, i * 1.7), 0.45);
      });
      out = normalizeTo(trimTail(out, rate), -3);
      break;
    }
    case "echo": {
      const tail = { decay: 2.2, predelayMs: 70, damping: 0.6 };
      out = chans.map((c, i) =>
        reverb(highPass(lowPass(c, rate, 2500), rate, 150), rate, tail, 2.2, i * 2.1),
      );
      out = normalizeTo(trimTail(out, rate), -3);
      break;
    }
  }
  return { sampleRate: rate, channels: out };
}

/** A 16-bit WAV of `audio`, to keep a made version with the project like any other source file. */
export function encodeVersion(audio: AudioData): Uint8Array {
  return encodeWav16Channels(
    audio.channels.map((c) => toInt16(c).pcm),
    audio.sampleRate,
  );
}

/** "my_shot (distant).wav" */
export function versionFileName(fileName: string, kind: ShotKind): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return kind === "shot" ? fileName : `${stem} (${kind}).wav`;
}
