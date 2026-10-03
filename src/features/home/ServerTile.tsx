import { EllipsisVertical, Pencil, Play, Server as ServerIcon, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Server } from "../../api/types";
import { Button } from "../../components/ui/button";
import { ColorDot } from "../../components/ui/misc";
import { ConfirmDialog, Menu, MenuItem } from "../../components/ui/overlay";
import { timeAgo } from "../../lib/format";
import { useApp } from "../../store/app";

export function ServerTile({ server, onEdit }: { server: Server; onEdit: () => void }) {
  const profiles = useApp((s) => s.profiles);
  const requestApply = useApp((s) => s.requestApply);
  const refresh = useApp((s) => s.refresh);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const profile = profiles.find((p) => p.id === server.profileId);

  const play = async () => {
    const then = { kind: "connect" as const, address: server.address, serverId: server.id };
    if (profile) {
      requestApply(profile.id, then);
      return;
    }
    try {
      await api.connectServer(server.address, server.id);
      toast.success(`Joining ${server.name}…`);
      await refresh("servers");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong">
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: profile?.color ?? "var(--color-line-strong)" }}
      />
      <div className="flex items-start gap-3 px-4 pt-4 pl-5">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted">
          <ServerIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{server.name}</p>
          <p className="truncate font-mono text-xs text-subtle selectable">{server.address}</p>
        </div>
        <Menu
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="Server options">
              <EllipsisVertical className="size-4" />
            </Button>
          }
        >
          <MenuItem icon={<Pencil />} onSelect={onEdit}>
            Edit
          </MenuItem>
          <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(true)}>
            Remove
          </MenuItem>
        </Menu>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 px-4 pt-4 pb-4 pl-5">
        <div className="min-w-0 text-xs">
          {profile ? (
            <span className="flex items-center gap-1.5 text-fg">
              <ColorDot color={profile.color} />
              <span className="truncate">{profile.name}</span>
            </span>
          ) : (
            <span className="text-muted">Keeps current settings</span>
          )}
          <span className="mt-0.5 block text-subtle">Played {timeAgo(server.lastPlayedAt)}</span>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void play()}
          icon={<Play className="size-3.5 fill-current" />}
        >
          Play
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Remove ${server.name}?`}
        description="Only the shortcut is removed. Nothing changes in your game."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={async () => {
          try {
            await api.deleteServer(server.id);
            await refresh("servers");
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
    </div>
  );
}
