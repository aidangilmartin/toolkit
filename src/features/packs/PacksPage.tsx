import {
  EllipsisVertical,
  FileArchive,
  FolderOpen,
  FolderPlus,
  Package,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Pack } from "../../api/types";
import { PageBody, PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/button";
import { Badge, Card, EmptyState, SectionTitle } from "../../components/ui/misc";
import { ConfirmDialog, Menu, MenuItem, MenuSeparator } from "../../components/ui/overlay";
import { formatBytes, plural, timeAgo } from "../../lib/format";
import { CATEGORY_LABEL, CATEGORY_ORDER, ROOT_LABEL } from "../../lib/profile";
import { useApp } from "../../store/app";
import { CategoryIcon } from "./CategoryIcon";
import { EditPackDialog } from "./EditPackDialog";
import { ImportWizard } from "./ImportWizard";

export function PacksPage() {
  const packs = useApp((s) => s.packs);
  const [source, setSource] = useState<string | null>(null);

  const pick = async (kind: "folder" | "file") => {
    try {
      const path =
        kind === "folder"
          ? await api.pickFolder("Choose the pack's folder")
          : await api.pickPackFile();
      if (path) setSource(path);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const importButtons = (
    <>
      <Button icon={<FolderPlus className="size-4" />} onClick={() => void pick("folder")}>
        Import folder
      </Button>
      <Button
        variant="primary"
        icon={<FileArchive className="size-4" />}
        onClick={() => void pick("file")}
      >
        Import .zip / .rpf
      </Button>
    </>
  );

  return (
    <>
      <PageHeader
        title="Packs"
        description="Sound packs, citizen packs, ReShade presets and .rpf mods. Import once, then add them to profiles."
        actions={importButtons}
      />
      <PageBody>
        {packs.length === 0 ? (
          <EmptyState
            icon={<Package className="size-8" />}
            title="No packs yet"
            description="Import a downloaded pack (a folder, .zip or .rpf). Loadout works out where its files go and keeps a copy, so you can switch it on and off per profile."
            action={<div className="flex gap-2">{importButtons}</div>}
          />
        ) : (
          CATEGORY_ORDER.map((category) => {
            const items = packs.filter((p) => p.category === category);
            if (!items.length) return null;
            return (
              <section key={category}>
                <SectionTitle title={CATEGORY_LABEL[category]} />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {items.map((pack) => (
                    <PackCard key={pack.id} pack={pack} />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </PageBody>
      <ImportWizard source={source} onClose={() => setSource(null)} />
    </>
  );
}

function PackCard({ pack }: { pack: Pack }) {
  const profiles = useApp((s) => s.profiles);
  const status = useApp((s) => s.status);
  const refresh = useApp((s) => s.refresh);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const usedBy = profiles.filter((p) => p.packs.includes(pack.id));
  const installed = status?.deployedFiles.some((f) => f.packId === pack.id) ?? false;

  return (
    <Card className="flex gap-3 p-4">
      <CategoryIcon category={pack.category} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate font-medium">{pack.name}</p>
          {installed && <Badge tone="accent">Installed</Badge>}
          {pack.root === "gtaInstall" && <Badge tone="warn">GTA folder</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {plural(pack.files.length, "file")} · {formatBytes(pack.totalSize)} →{" "}
          {ROOT_LABEL[pack.root]}
        </p>
        <p className="mt-2 truncate text-xs text-subtle">
          {usedBy.length
            ? `Used by ${usedBy.map((p) => p.name).join(", ")}`
            : "Not used by any profile"}{" "}
          · imported {timeAgo(pack.importedAt)}
        </p>
      </div>
      <Menu
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="Pack options">
            <EllipsisVertical className="size-4" />
          </Button>
        }
      >
        <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
          Rename / details
        </MenuItem>
        <MenuItem
          icon={<FolderOpen />}
          onSelect={() =>
            void api
              .openFolder({ kind: "pack", id: pack.id })
              .catch((e) => toast.error(errorMessage(e)))
          }
        >
          Show files
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(true)}>
          Delete
        </MenuItem>
      </Menu>
      <EditPackDialog pack={editing ? pack : null} onClose={() => setEditing(false)} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${pack.name}”?`}
        description={
          installed
            ? "It's installed right now. Apply a profile without it (or restore vanilla) first."
            : `Its library copy is deleted${usedBy.length ? ` and it's removed from ${plural(usedBy.length, "profile")}` : ""}.`
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          try {
            await api.deletePack(pack.id);
            await refresh("packs", "profiles");
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
    </Card>
  );
}
