import {
  Check,
  Copy,
  Crosshair,
  EllipsisVertical,
  Globe,
  Music,
  Pencil,
  Play,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Profile } from "../../api/types";
import { ServerLogo } from "../../components/ServerLogo";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/misc";
import { ConfirmDialog, Menu, MenuItem, MenuSeparator } from "../../components/ui/overlay";
import { plural } from "../../lib/format";
import { filesSummary, graphicsSummary, serverLabel } from "../../lib/profile";
import { useApp, type AfterApply } from "../../store/app";

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-subtle">
      {icon}
      <span className="truncate">{children}</span>
    </div>
  );
}

export function ProfileCard({ profile }: { profile: Profile }) {
  const status = useApp((s) => s.status);
  const packs = useApp((s) => s.packs);
  const schema = useApp((s) => s.schema);
  const navigate = useApp((s) => s.navigate);
  const requestApply = useApp((s) => s.requestApply);
  const refresh = useApp((s) => s.refresh);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const active = status?.activeProfileId === profile.id;
  const drifted = active && (status?.settingsDrift.length ?? 0) > 0;
  const cfgCount = Object.keys(profile.fivemCfg).length;
  const server = serverLabel(profile);
  const edit = () => navigate({ name: "profile", id: profile.id });
  const play: AfterApply = profile.serverAddress
    ? { kind: "connect", address: profile.serverAddress }
    : { kind: "launch" };

  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong"
      style={{
        borderColor: active ? `${profile.color}66` : undefined,
        boxShadow: active
          ? `0 0 0 1px ${profile.color}33, 0 12px 40px -24px ${profile.color}`
          : undefined,
      }}
    >
      <div
        className="h-1.5"
        style={{ background: `linear-gradient(90deg, ${profile.color}, ${profile.color}33)` }}
      />
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <button onClick={edit} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <ServerLogo icon={profile.serverIcon} color={profile.color} className="size-12" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{profile.name}</p>
            <p className="truncate text-xs text-muted" title={profile.serverAddress ?? undefined}>
              {!profile.serverAddress
                ? "No server · Play starts FiveM"
                : profile.serverName && profile.serverName !== profile.name
                  ? profile.serverName
                  : profile.serverAddress}
            </p>
          </div>
        </button>
        <Menu
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="Profile options">
              <EllipsisVertical className="size-4" />
            </Button>
          }
        >
          <MenuItem icon={<Pencil />} onSelect={edit}>
            Edit
          </MenuItem>
          <MenuItem icon={<Check />} onSelect={() => requestApply(profile.id)}>
            Apply without playing
          </MenuItem>
          <MenuItem
            icon={<Copy />}
            onSelect={async () => {
              try {
                await api.duplicateProfile(profile.id);
                await refresh("profiles");
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
          >
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(true)}>
            Delete
          </MenuItem>
        </Menu>
      </div>

      {(active || drifted || profile.applyToGta) && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-2.5">
          {active && (
            <Badge tone="accent" className="border-transparent">
              Active
            </Badge>
          )}
          {drifted && <Badge tone="warn">Changed in-game</Badge>}
          {profile.applyToGta && <Badge icon={<Globe className="size-3" />}>+ GTA V</Badge>}
        </div>
      )}

      <button onClick={edit} className="space-y-1.5 px-4 pt-3 text-left">
        <Line icon={<SlidersHorizontal />}>{graphicsSummary(profile, schema)}</Line>
        <Line icon={<Music />}>{filesSummary(profile, packs)}</Line>
        <Line icon={<Crosshair />}>
          {cfgCount ? plural(cfgCount, "in-game setting") : "In-game settings unchanged"}
        </Line>
      </button>

      <div className="mt-auto px-4 pt-4 pb-4">
        <Button
          variant="primary"
          className="w-full"
          icon={<Play className="size-3.5 fill-current" />}
          onClick={() => requestApply(profile.id, play)}
        >
          <span className="truncate">{server ? `Play · ${server}` : "Play"}</span>
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${profile.name}”?`}
        description={
          active
            ? "Its settings, sounds and mods stay installed until you apply another profile or restore vanilla."
            : "Its uploaded sounds and mods are cleaned up too, unless another profile uses them."
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          try {
            await api.deleteProfile(profile.id);
            await refresh("profiles", "packs", "status");
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
    </div>
  );
}
