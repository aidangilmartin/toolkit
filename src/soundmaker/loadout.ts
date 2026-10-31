/** Where the sound maker meets the rest of Loadout: its profiles. */
import { api } from "../api";
import type { ProfileFileKind } from "../api/types";
import { setSoundFile, type SoundKind } from "../lib/profile";
import { useApp } from "../store/app";
import type { ExportArchivesResult } from "./ipc";

const KIND_BY_ARCHIVE: Record<string, SoundKind> = {
  "weapons_player.rpf": "weaponSounds",
  "resident.rpf": "residentSounds",
};

/** The profile sound slot an exported archive fills, if any. */
export function soundKindOf(file: string): SoundKind | null {
  return KIND_BY_ARCHIVE[file.toLowerCase()] ?? null;
}

/**
 * Puts a freshly exported pack's WEAPONS_PLAYER.rpf / RESIDENT.rpf into a profile's sound slots,
 * replacing what the profile had there. Returns the slots that changed.
 */
export async function addPackToProfile(
  profileId: string,
  exported: ExportArchivesResult,
): Promise<ProfileFileKind[]> {
  const store = useApp.getState();
  const profile = store.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("That profile no longer exists.");
  let packIds = profile.packs;
  const filled: ProfileFileKind[] = [];
  const imported = [];
  for (const archive of exported.archives) {
    const kind = soundKindOf(archive.file);
    if (!kind) continue;
    const pack = await api.importProfileFile(archive.path, kind);
    imported.push({ kind, pack });
  }
  if (imported.length === 0)
    throw new Error("The export has no WEAPONS_PLAYER.rpf or RESIDENT.rpf to add.");
  await store.refresh("packs");
  const packs = useApp.getState().packs;
  for (const { kind, pack } of imported) {
    packIds = setSoundFile(packIds, packs, kind, pack.id);
    filled.push(kind);
  }
  await api.saveProfile({ ...profile, packs: packIds });
  await useApp.getState().refresh("profiles", "status");
  return filled;
}
