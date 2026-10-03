import { describe, expect, it } from "vitest";

import type { GraphicsSchema, Pack, SettingDef } from "../api/types";
import schemaJson from "../mock/schema.json";
import {
  defaultValue,
  displayValue,
  emptyProfile,
  graphicsSummary,
  matchingPreset,
  normalizeValue,
  packConflicts,
} from "./profile";

const schema = schemaJson as unknown as GraphicsSchema;
const def = (key: string) => schema.settings.find((s) => s.key === key) as SettingDef;

function pack(id: string, name: string, paths: string[], root: Pack["root"] = "fivemApp"): Pack {
  return {
    id,
    name,
    category: "citizen",
    root,
    files: paths.map((path) => ({ path, size: 1, hash: "x" })),
    docs: [],
    totalSize: paths.length,
    sourceName: name,
    importedAt: "",
    notes: "",
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

describe("pack conflicts", () => {
  it("flags files shipped by two packs on the same root, case-insensitively", () => {
    const a = pack("a", "Pack A", ["citizen/common/data/visualsettings.dat", "citizen/x.xml"]);
    const b = pack("b", "Pack B", ["CITIZEN/common/data/VisualSettings.dat"]);
    const c = pack("c", "Pack C", ["citizen/x.xml"], "gtaInstall");
    const conflicts = packConflicts([a, b, c]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].packs).toEqual(["Pack A", "Pack B"]);
  });
});
