import {
  Copy,
  Crosshair,
  EllipsisVertical,
  Globe,
  Package,
  Pencil,
  Play,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Profile } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/misc";
import { ConfirmDialog, Menu, MenuItem, MenuSeparator } from "../../components/ui/overlay";
import { plural } from "../../lib/format";
import { graphicsSummary, packNames } from "../../lib/profile";
import { useApp } from "../../store/app";

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
  const names = packNames(profile, packs);
  const cfgCount = Object.keys(profile.fivemCfg).length;
  const edit = () => navigate({ name: "profile", id: profile.id });

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
      <div className="flex items-start gap-2 px-4 pt-3.5">
        <button onClick={edit} className="min-w-0 flex-1 text-left">
          <p className="truncate font-semibold">{profile.name}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {active && (
              <Badge tone="accent" className="border-transparent">
                Active
              </Badge>
            )}
            {drifted && <Badge tone="warn">Changed in-game</Badge>}
            {profile.applyToGta && <Badge icon={<Globe className="size-3" />}>+ GTA V</Badge>}
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

      <button onClick={edit} className="space-y-1.5 px-4 pt-3 text-left">
        <Line icon={<SlidersHorizontal />}>{graphicsSummary(profile, schema)}</Line>
        <Line icon={<Package />}>
          {names.length ? names.join(" · ") : "No packs (vanilla files)"}
        </Line>
        <Line icon={<Crosshair />}>
          {cfgCount ? plural(cfgCount, "in-game setting") : "In-game settings unchanged"}
        </Line>
      </button>

      <div className="mt-auto flex items-center gap-2 px-4 pt-4 pb-4">
        <Button size="sm" className="flex-1" onClick={() => requestApply(profile.id)}>
          {active ? "Re-apply" : "Apply"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          className="flex-1"
          icon={<Play className="size-3.5 fill-current" />}
          onClick={() => requestApply(profile.id, { kind: "launch" })}
        >
          Play
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${profile.name}”?`}
        description={
          active
            ? "Its settings and packs stay installed until you apply another profile or restore vanilla."
            : "This only deletes the profile. Your packs stay in the library."
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          try {
            await api.deleteProfile(profile.id);
            await refresh("profiles", "servers", "status");
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
    </div>
  );
}
