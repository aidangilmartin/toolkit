import { Crosshair, Package, Plus, Upload, Volume2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Pack, ProfileFileKind, Progress } from "../../api/types";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/ui/button";
import { Card, EmptyState, ProgressBar, SectionTitle } from "../../components/ui/misc";
import { cn } from "../../lib/cn";
import { formatBytes, plural } from "../../lib/format";
import { profileFiles, setSoundFile, SOUND_FILES, type SoundKind } from "../../lib/profile";
import { useApp } from "../../store/app";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The files a profile installs: its own WEAPONS_PLAYER.rpf / RESIDENT.rpf and
 * mods for FiveM's mods folder. Uploads are copied into Loadout straight away;
 * the profile only lists them, so `onChange` gets the new pack id list.
 */
export function FilesSection({
  packIds,
  onChange,
  narrow = false,
}: {
  packIds: string[];
  onChange: (packIds: string[]) => void;
  /** Stack the two sound slots (in a dialog). */
  narrow?: boolean;
}) {
  const packs = useApp((s) => s.packs);
  const refresh = useApp((s) => s.refresh);
  const [busy, setBusy] = useState<ProfileFileKind | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const files = profileFiles(packIds, packs);
  const fraction = progress && progress.total > 0 ? progress.done / progress.total : 0;

  const upload = async (kind: ProfileFileKind) => {
    let paths: string[];
    try {
      paths = await api.pickProfileFiles(kind);
    } catch (err) {
      toast.error(errorMessage(err));
      return;
    }
    if (!paths.length) return;
    setBusy(kind);
    setProgress(null);
    const unlisten = await api.onProgress(setProgress);
    const added: Pack[] = [];
    try {
      for (const path of paths) {
        try {
          added.push(await api.importProfileFile(path, kind));
        } catch (err) {
          toast.error(`${fileName(path)}: ${errorMessage(err)}`);
        }
      }
    } finally {
      unlisten();
    }
    if (added.length) {
      await refresh("packs");
      onChange(
        kind === "mod"
          ? [...packIds, ...added.map((p) => p.id)]
          : setSoundFile(packIds, packs, kind, added[0].id),
      );
    }
    setBusy(null);
    setProgress(null);
  };

  const remove = (id: string) => onChange(packIds.filter((p) => p !== id));

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle
          title="Sounds"
          description="Your own gun and world sounds. They replace the game's files in GTA V/x64/audio/sfx while this profile is active."
        />
        <div className={cn("grid grid-cols-1 gap-2", !narrow && "md:grid-cols-2")}>
          {(Object.keys(SOUND_FILES) as SoundKind[]).map((kind) => {
            const pack = files[kind];
            return (
              <Card key={kind} className="flex items-center gap-3 p-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted">
                  {kind === "weaponSounds" ? (
                    <Crosshair className="size-4" />
                  ) : (
                    <Volume2 className="size-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{SOUND_FILES[kind].label}</p>
                  {busy === kind ? (
                    <ProgressBar value={fraction} className="mt-1.5 h-1.5" />
                  ) : (
                    <p className="truncate text-xs text-muted">
                      {pack
                        ? `${pack.sourceName} · ${formatBytes(pack.totalSize)}`
                        : `The game's own ${SOUND_FILES[kind].file}`}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  icon={<Upload className="size-3.5" />}
                  loading={busy === kind}
                  disabled={busy !== null}
                  onClick={() => void upload(kind)}
                >
                  {pack ? "Replace" : "Upload"}
                </Button>
                {pack && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${SOUND_FILES[kind].label.toLowerCase()}`}
                    disabled={busy !== null}
                    onClick={() => onChange(setSoundFile(packIds, packs, kind, null))}
                  >
                    <X className="size-3.5" />
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      <section>
        <SectionTitle
          title="Mods"
          description=".rpf mods for FiveM's mods folder. They're added when you play this profile and removed when you switch away."
          actions={
            <Button
              size="sm"
              icon={<Plus className="size-3.5" />}
              loading={busy === "mod"}
              disabled={busy !== null}
              onClick={() => void upload("mod")}
            >
              Add mods
            </Button>
          }
        />
        {busy === "mod" && (
          <div className="mb-2 flex items-center gap-3 text-xs text-muted">
            <ProgressBar value={fraction} className="h-1.5 flex-1" />
            <span className="max-w-64 truncate">{progress?.message ?? "Copying…"}</span>
          </div>
        )}
        {files.mods.length === 0 ? (
          <EmptyState
            className="py-6"
            title="No mods"
            description="Add .rpf files, or a .zip of them."
          />
        ) : (
          <Card className="divide-y divide-line">
            {files.mods.map((pack) => (
              <FileRow
                key={pack.id}
                icon={<Package className="size-4" />}
                title={pack.name}
                detail={`mods/${fileName(pack.files[0]?.path ?? pack.sourceName)}${
                  pack.files.length > 1 ? ` + ${plural(pack.files.length - 1, "more file")}` : ""
                } · ${formatBytes(pack.totalSize)}`}
                onRemove={() => remove(pack.id)}
                disabled={busy !== null}
              />
            ))}
          </Card>
        )}
      </section>

      {files.older.length > 0 && (
        <section>
          <SectionTitle
            title="Packs from Loadout 0.1"
            description="Imported into the old pack library. They still work; remove them here if you don't want them."
          />
          <Card className="divide-y divide-line">
            {files.older.map((pack) => (
              <FileRow
                key={pack.id}
                icon={<Package className="size-4" />}
                title={pack.name}
                detail={`${plural(pack.files.length, "file")} · ${formatBytes(pack.totalSize)}`}
                onRemove={() => remove(pack.id)}
                disabled={busy !== null}
              />
            ))}
          </Card>
        </section>
      )}

      {(files.weaponSounds || files.residentSounds) && (
        <Banner tone="warn" title="Sound files change the GTA V game folder">
          They also affect Story Mode and GTA Online. Use Backups → Restore vanilla (or play a
          profile without sounds) before playing GTA Online.
        </Banner>
      )}
    </div>
  );
}

function FileRow({
  icon,
  title,
  detail,
  onRemove,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="text-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted">{detail}</p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${title}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
