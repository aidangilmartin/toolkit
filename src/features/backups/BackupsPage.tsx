import { ArchiveRestore, Pin, RotateCcw, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Snapshot } from "../../api/types";
import { PageBody, PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/button";
import { Badge, Card, EmptyState, SectionTitle } from "../../components/ui/misc";
import { ConfirmDialog } from "../../components/ui/overlay";
import { dateTime, formatBytes, plural, timeAgo } from "../../lib/format";
import { ROOT_LABEL } from "../../lib/profile";
import { useApp } from "../../store/app";

const fileLabel = {
  fivemGraphics: "FiveM graphics",
  gtaGraphics: "GTA V graphics",
  fivemCfg: "In-game settings",
};

export function BackupsPage() {
  const status = useApp((s) => s.status);
  const packs = useApp((s) => s.packs);
  const snapshots = useApp((s) => s.snapshots);
  const requestApply = useApp((s) => s.requestApply);
  const deployed = status?.deployedFiles ?? [];
  const totalSize = deployed.reduce((sum, f) => sum + f.size, 0);

  return (
    <>
      <PageHeader
        title="Backups"
        description="Everything Loadout changes is backed up first, so you can always get back."
      />
      <PageBody>
        <Card className="flex items-center gap-5 p-5">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ShieldCheck className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Restore vanilla</p>
            <p className="mt-0.5 text-sm text-muted">
              Removes every sound and mod file Loadout installed and puts the original game files
              back. Do this before playing GTA Online if a profile changed the GTA V folder. Your
              settings files are left as they are; restore a backup below for those.
            </p>
          </div>
          <Button
            variant="primary"
            icon={<Undo2 className="size-4" />}
            disabled={deployed.length === 0}
            onClick={() => requestApply(null)}
          >
            Restore vanilla
          </Button>
        </Card>

        <section>
          <SectionTitle
            title="Installed by Loadout"
            description={
              deployed.length
                ? `${plural(deployed.length, "file")} · ${formatBytes(totalSize)}`
                : "Nothing right now: your game files are vanilla."
            }
          />
          {deployed.length > 0 && (
            <Card className="max-h-72 divide-y divide-line overflow-y-auto">
              {deployed.map((file) => (
                <div
                  key={`${file.rootDir}/${file.path}`}
                  className="flex items-center gap-3 px-4 py-2 text-xs"
                >
                  <Badge>{ROOT_LABEL[file.root]}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.path}>
                    {file.path}
                  </span>
                  <span className="truncate text-muted">
                    {packs.find((p) => p.id === file.packId)?.name ?? "Deleted file"}
                  </span>
                  {file.original ? (
                    <Badge tone="accent">original backed up</Badge>
                  ) : (
                    <Badge>new file</Badge>
                  )}
                </div>
              ))}
            </Card>
          )}
        </section>

        <section>
          <SectionTitle
            title="Settings backups"
            description="Taken automatically before every apply. The first-run backup is kept forever."
          />
          {snapshots.length === 0 ? (
            <EmptyState
              icon={<ArchiveRestore className="size-8" />}
              title="No backups yet"
              description="One is made the first time you apply a profile."
            />
          ) : (
            <Card className="divide-y divide-line">
              {snapshots.map((snapshot) => (
                <SnapshotRow key={snapshot.id} snapshot={snapshot} />
              ))}
            </Card>
          )}
        </section>
      </PageBody>
    </>
  );
}

function SnapshotRow({ snapshot }: { snapshot: Snapshot }) {
  const refresh = useApp((s) => s.refresh);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{snapshot.label}</p>
          {snapshot.pinned && (
            <Badge tone="info" icon={<Pin className="size-3" />}>
              kept
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {dateTime(snapshot.createdAt)} ({timeAgo(snapshot.createdAt)}) ·{" "}
          {snapshot.files.map((f) => fileLabel[f.target]).join(", ")}
        </p>
      </div>
      <Button
        size="sm"
        icon={<RotateCcw className="size-3.5" />}
        onClick={() => setRestoring(true)}
      >
        Restore
      </Button>
      {!snapshot.pinned && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete backup"
          onClick={() => setDeleting(true)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
      <ConfirmDialog
        open={restoring}
        onOpenChange={setRestoring}
        title="Restore these settings?"
        description={`${snapshot.files.map((f) => fileLabel[f.target]).join(", ")} go back to how they were ${timeAgo(snapshot.createdAt)}. Your current files are backed up first. Sounds and mods aren't touched.`}
        confirmLabel="Restore"
        onConfirm={async () => {
          try {
            await api.restoreSnapshot(snapshot.id);
            toast.success("Settings restored");
            await refresh("snapshots", "status");
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this backup?"
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          try {
            await api.deleteSnapshot(snapshot.id);
            await refresh("snapshots");
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
    </div>
  );
}
