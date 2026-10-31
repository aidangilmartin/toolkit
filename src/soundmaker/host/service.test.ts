import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../test/nodeHost";
import { createService, type Shell } from "./service";

const tmp = (): string => mkdtempSync(join(tmpdir(), "gsm-service-"));

function fakeShell(over: Partial<Shell> = {}): Shell {
  return {
    pickFiles: async () => [],
    pickFolder: async () => null,
    pickSaveFile: async () => null,
    confirm: async () => true,
    showInFolder: async () => {},
    openExternal: async () => {},
    detectGtaFolder: async () => null,
    ...over,
  };
}

describe("sound maker service", () => {
  it("uses the GTA V folder Loadout found until one is picked", async () => {
    const found = tmp();
    writeFileSync(join(found, "GTA5.exe"), "");
    const other = tmp();
    const api = createService(
      nodeHost(tmp(), { bridge: "/nope" }),
      fakeShell({ detectGtaFolder: async () => found }),
    );
    expect(await api.getGameSettings()).toEqual({
      gtaPath: found,
      gtaValid: true,
      confirmed: false,
      bridgeAvailable: false,
    });
    await expect(api.setGtaPath(other)).rejects.toThrow(/gta5.exe was not found/);
    writeFileSync(join(other, "gta5_enhanced.exe"), "");
    expect((await api.setGtaPath(other)).gtaPath).toBe(other);
    expect((await api.getGameSettings()).gtaPath).toBe(other);
  });

  it("saves and reopens projects, and reads only audio files", async () => {
    const dir = tmp();
    const target = join(dir, "mine");
    const api = createService(
      nodeHost(tmp()),
      fakeShell({ pickSaveFile: async () => target, pickFiles: async () => [`${target}.gunpack`] }),
    );
    const saved = await api.saveProject(
      '{"a":1}',
      [{ id: "s", fileName: "shot.wav", bytes: new Uint8Array([9]) }],
      null,
    );
    expect(saved).toBe(`${target}.gunpack`);
    const opened = await api.openProject();
    expect(opened?.json).toBe('{"a":1}');
    expect(opened?.sources[0].bytes).toEqual(new Uint8Array([9]));

    mkdirSync(join(dir, "audio"));
    writeFileSync(join(dir, "audio", "shot.WAV"), "x");
    writeFileSync(join(dir, "audio", "notes.txt"), "x");
    const files = await api.readFiles([
      join(dir, "audio", "shot.WAV"),
      join(dir, "audio", "notes.txt"),
    ]);
    expect(files.map((f) => f.name)).toEqual(["shot.WAV"]);
  });

  it("keeps labels, and has no gun data before a vanilla pack is loaded", async () => {
    const api = createService(nodeHost(tmp()), fakeShell());
    await api.setLabel("resident/weapons.awc:1A", " Shot ");
    expect(await api.getLabels()).toEqual({ "resident/weapons.awc:1A": "Shot" });
    expect(await api.getWeaponIndex()).toBeNull();
    expect(await api.getSoundMap()).toBeNull();
    expect((await api.getVanillaStatus()).kind).toBeNull();
    await expect(api.exportArchives("x", [])).rejects.toThrow(/vanilla pack first/);
  });
});
