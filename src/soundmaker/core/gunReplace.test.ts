import { describe, expect, it } from "vitest";
import type { GunFile, GunSection } from "./describe";
import { peak } from "./dsp";
import {
  encodeVersion,
  planGunReplace,
  renderShotVersion,
  versionFileName,
  type ShotKind,
} from "./gunReplace";
import { parseWav, type AudioData } from "./wav";

const file = (bank: string, streamId: number, sharedGuns: string[] = []): GunFile => ({
  pack: bank === "weapons.awc" ? "resident" : "weapons_player",
  bank,
  streamId,
  text: "",
  heardBy: "you",
  alsoRoles: [],
  sharedWith: sharedGuns.map((gun) => ({ gun, parts: ["fire"] })),
});

const section = (role: string, files: GunFile[]): GunSection => ({
  role,
  label: role,
  meaning: "",
  inferred: false,
  files,
});

const pistol: GunSection[] = [
  section("fire", [
    file("ptl_pistol.awc", 1),
    file("ptl_pistol.awc", 2),
    file("weapons.awc", 9, ["SMG", "Combat Pistol"]),
  ]),
  // file 1 is also the report: it keeps the close shot
  section("report", [file("ptl_pistol.awc", 1), file("ptl_pistol.awc", 3)]),
  section("echo", [file("ptl_pistol.awc", 4)]),
  section("suppressed", [file("ptl_pistol.awc", 5)]),
  section("reload", [file("ptl_pistol.awc", 6)]),
];

const ids = (plan: ReturnType<typeof planGunReplace>, kind: ShotKind) =>
  plan.groups.find((g) => g.kind === kind)?.refs.map((r) => r.streamId) ?? [];

describe("planGunReplace", () => {
  it("gives each shot part its version, and leaves other guns' files and non-shot parts alone", () => {
    const plan = planGunReplace(pistol);
    expect(plan.groups.map((g) => g.kind)).toEqual(["shot", "suppressed", "distant", "echo"]);
    expect(ids(plan, "shot")).toEqual([1, 2]);
    expect(ids(plan, "distant")).toEqual([3]);
    expect(ids(plan, "echo")).toEqual([4]);
    expect(ids(plan, "suppressed")).toEqual([5]);
    expect(plan.shared.map((r) => r.streamId)).toEqual([9]);
    expect(plan.sharedGuns).toEqual(["Combat Pistol", "SMG"]);
  });

  it("includes shared files when asked", () => {
    const plan = planGunReplace(pistol, { includeShared: true });
    expect(ids(plan, "shot")).toEqual([1, 2, 9]);
  });
});

const rate = 32000;
/** A gunshot-like burst: noise with a fast decay, then silence. */
function shot(channels = 1): AudioData {
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const n = rate / 2;
  return {
    sampleRate: rate,
    channels: Array.from({ length: channels }, () =>
      Float32Array.from({ length: n }, (_, i) =>
        i < rate / 4 ? noise() * Math.exp(-i / 800) * 0.9 : 0,
      ),
    ),
  };
}

/** Energy above ~4 kHz relative to the whole, from sample-to-sample differences. */
const brightness = (x: Float32Array): number => {
  let diff = 0;
  let all = 0;
  for (let i = 1; i < x.length; i++) {
    diff += (x[i] - x[i - 1]) ** 2;
    all += x[i] ** 2;
  }
  return diff / all;
};

describe("renderShotVersion", () => {
  it("keeps the close shot as it is", () => {
    const a = shot();
    expect(renderShotVersion(a, "shot")).toBe(a);
  });

  it("makes muffled, reverberant versions that keep the channels and rate", () => {
    const a = shot(2);
    for (const kind of ["indoor", "suppressed", "distant", "echo"] as const) {
      const v = renderShotVersion(a, kind);
      expect(v.sampleRate).toBe(rate);
      expect(v.channels).toHaveLength(2);
      expect(v.channels[0].length).toBe(v.channels[1].length);
      for (const c of v.channels) expect(c.every(Number.isFinite)).toBe(true);
      expect(Math.max(...v.channels.map(peak))).toBeLessThanOrEqual(1);
    }
    const dry = brightness(a.channels[0]);
    expect(brightness(renderShotVersion(a, "distant").channels[0])).toBeLessThan(dry / 4);
    expect(brightness(renderShotVersion(a, "suppressed").channels[0])).toBeLessThan(dry / 4);
  });

  it("rings out: the echo carries on well after the shot and starts after a pre-delay", () => {
    const echo = renderShotVersion(shot(), "echo").channels[0];
    expect(echo.length / rate).toBeGreaterThan(1);
    expect(peak(echo.slice(0, Math.round(0.05 * rate)))).toBe(0);
    expect(peak(echo.slice(Math.round(0.6 * rate)))).toBeGreaterThan(0.001);
  });

  it("keeps suppressed shots short and quieter", () => {
    const s = renderShotVersion(shot(), "suppressed").channels[0];
    expect(s.length / rate).toBeLessThan(0.4);
    expect(peak(s)).toBeCloseTo(10 ** (-9 / 20), 2);
  });
});

describe("made versions as source files", () => {
  it("encode as WAVs with every channel", () => {
    const v = renderShotVersion(shot(2), "distant");
    const wav = parseWav(encodeVersion(v));
    expect(wav.sampleRate).toBe(rate);
    expect(wav.channels).toHaveLength(2);
    expect(wav.channels[0].length).toBe(v.channels[0].length);
  });

  it("are named after the file", () => {
    expect(versionFileName("my shot.mp3", "distant")).toBe("my shot (distant).wav");
    expect(versionFileName("my shot.mp3", "shot")).toBe("my shot.mp3");
  });
});
