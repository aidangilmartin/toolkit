import { describe, expect, it } from "vitest";

import type { GraphicsSchema, Pack, SettingDef } from "../api/types";
import schemaJson from "../mock/schema.json";
import {
  defaultValue,
  displayValue,
  emptyProfile,
  graphicsSummary,
  matchingPreset,
  filesSummary,
  normalizeValue,
  profileFiles,
  setSoundFile,
} from "./profile";

const schema = schemaJson as unknown as GraphicsSchema;
const def = (key: string) => schema.settings.find((s) => s.key === key) as SettingDef;

function pack(id: string, profileFile: Pack["profileFile"]): Pack {
  return {
    id,
    name: id,
    category: profileFile === "mod" ? "mods" : "soundPack",
    root: profileFile === "mod" ? "fivemApp" : "gtaInstall",
    files: [{ path: `${id}.rpf`, size: 1, hash: "x" }],
    docs: [],
    totalSize: 1,
    sourceName: `${id}.rpf`,
    importedAt: "",
    notes: "",
    profileFile,
  };
}

describe("presets", () => {
  it("recognises a profile built from a preset, even with extra keys", () => {
    const maxFps = schema.presets.find((p) => p.id === "max-fps")!;
    const graphics = { ...maxFps.values, "video/Windowed": "0" };
    expect(matchingPreset(graphics, schema)?.id).toBe("max-fps");
    expect(graphicsSummary(emptyProfile({ graphics }), schema)).toBe("Max FPS (PvP) graphics");
  });

  it("stops matching once a preset value is changed", () => {
    const ultra = schema.presets.find((p) => p.id === "ultra")!;
    const graphics = { ...ultra.values, "graphics/GrassQuality": "0" };
    expect(matchingPreset(graphics, schema)).toBeNull();
    expect(graphicsSummary(emptyProfile({ graphics }), schema)).toMatch(/^Custom graphics · \d+/);
  });

  it("describes empty graphics", () => {
    expect(graphicsSummary(emptyProfile(), schema)).toBe("Graphics unchanged");
  });
});

describe("values", () => {
  it("formats values like the backend stores them", () => {
    expect(normalizeValue(def("graphics/LodScale"), "0.5")).toBe("0.500000");
    expect(normalizeValue(def("graphics/ShadowQuality"), "2")).toBe("2");
  });

  it("shows friendly labels", () => {
    expect(displayValue(def("graphics/ShadowQuality"), "3")).toBe("Very High");
    expect(displayValue(def("graphics/DoF"), "false")).toBe("Off");
    expect(displayValue(def("graphics/CityDensity"), "0.700000")).toBe("70%");
    expect(displayValue(undefined, "raw")).toBe("raw");
    expect(displayValue(def("graphics/DoF"), undefined)).toBe("—");
  });

  it("starts a newly included setting from the current value when known", () => {
    expect(defaultValue(def("graphics/ShadowQuality"), "2")).toBe("2");
    expect(defaultValue(def("graphics/ShadowQuality"))).toBe("1");
    expect(defaultValue(def("graphics/DoF"))).toBe("false");
  });
});

describe("profile files", () => {
  const packs = [
    pack("w1", "weaponSounds"),
    pack("w2", "weaponSounds"),
    pack("r1", "residentSounds"),
    pack("m1", "mod"),
    pack("m2", "mod"),
    pack("old", null),
  ];

  it("sorts a profile's packs into its slots", () => {
    const files = profileFiles(["old", "w1", "m1", "r1", "m2", "gone"], packs);
    expect(files.weaponSounds?.id).toBe("w1");
    expect(files.residentSounds?.id).toBe("r1");
    expect(files.mods.map((p) => p.id)).toEqual(["m1", "m2"]);
    expect(files.older.map((p) => p.id)).toEqual(["old"]);
  });

  it("replaces and clears a sound slot, keeping everything else in order", () => {
    expect(setSoundFile(["w1", "old", "m1"], packs, "weaponSounds", "w2")).toEqual([
      "old",
      "m1",
      "w2",
    ]);
    expect(setSoundFile(["w1", "r1"], packs, "residentSounds", null)).toEqual(["w1"]);
  });

  it("summarises what a profile installs", () => {
    const profile = (ids: string[]) => emptyProfile({ packs: ids });
    expect(filesSummary(profile(["w1", "m1", "m2"]), packs)).toBe("Weapon sounds · 2 mods");
    expect(filesSummary(profile(["r1", "old"]), packs)).toBe("Resident sounds · 1 pack");
    expect(filesSummary(profile([]), packs)).toBe("Vanilla sounds · no mods");
  });
});
