/** Where the sound maker meets the rest of Loadout: its profiles. */
import { api } from "../api";
import { useApp } from "../store/app";
import type { ExportArchivesResult } from "./ipc";

const ARCHIVES = ["weapons_player.rpf", "resident.rpf"];
const stem = (file: string) => file.replace(/\.rpf$/i, "").toLowerCase();

/**
 * Adds a freshly exported pack's WEAPONS_PLAYER.rpf / RESIDENT.rpf to a profile as mods for
 * FiveM's mods folder, replacing sound maker archives the profile had. They don't go in the
 * profile's sound slots: those replace the files in the GTA V folder, and FiveM refuses to start
 * with rebuilt (unencrypted) archives there.
 */
export async function addPackToProfile(
  profileId: string,
  exported: ExportArchivesResult,
): Promise<string[]> {
  const store = useApp.getState();
  const profile = store.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("That profile no longer exists.");
  const archives = exported.archives.filter((a) => ARCHIVES.includes(a.file.toLowerCase()));
  if (archives.length === 0)
    throw new Error("The export has no WEAPONS_PLAYER.rpf or RESIDENT.rpf to add.");

  const added = [];
  for (const archive of archives) added.push(await api.importProfileFile(archive.path, "mod"));

  // a mod named like one of the new archives is an older export: the new one replaces it
  const replaced = new Set(archives.map((a) => stem(a.file)));
  const packs = store.packs;
  const kept = profile.packs.filter((id) => {
    const pack = packs.find((p) => p.id === id);
    return !(pack?.profileFile === "mod" && replaced.has(pack.name.toLowerCase()));
  });
  await api.saveProfile({ ...profile, packs: [...kept, ...added.map((p) => p.id)] });
  await useApp.getState().refresh("packs", "profiles", "status");
  return archives.map((a) => a.file);
}
