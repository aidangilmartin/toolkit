import { ArrowDown, ArrowUp, Package, Plus, X } from "lucide-react";

import type { Pack } from "../../api/types";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/ui/button";
import { Badge, Card, EmptyState } from "../../components/ui/misc";
import { formatBytes, plural } from "../../lib/format";
import { CATEGORY_LABEL, CATEGORY_ORDER, packConflicts, ROOT_LABEL } from "../../lib/profile";
import { useApp } from "../../store/app";
import { CategoryIcon } from "../packs/CategoryIcon";
import type { TabProps } from "./ProfileEditor";

export function PacksTab({ draft, update }: TabProps) {
  const packs = useApp((s) => s.packs);
  const navigate = useApp((s) => s.navigate);
  const selected = draft.packs
    .map((id) => packs.find((p) => p.id === id))
    .filter((p): p is Pack => Boolean(p));
  const available = packs.filter((p) => !draft.packs.includes(p.id));
  const conflicts = packConflicts(selected);
  const touchesGta = selected.some((p) => p.root === "gtaInstall");

  const move = (index: number, by: number) =>
    update((d) => {
      const [item] = d.packs.splice(index, 1);
      d.packs.splice(index + by, 0, item);
    });

  if (packs.length === 0) {
    return (
      <EmptyState
        icon={<Package className="size-8" />}
        title="Your pack library is empty"
        description="Import sound packs, citizen packs, ReShade presets or .rpf mods first. Then pick which ones this profile uses."
        action={<Button onClick={() => navigate({ name: "packs" })}>Go to Packs</Button>}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section>
        <h3 className="text-sm font-semibold">In this profile</h3>
        <p className="mb-2 text-xs text-muted">
          Installed when you apply the profile, removed again when you switch away. Lower packs win
          if two ship the same file.
        </p>
        {selected.length === 0 ? (
          <EmptyState
            title="No packs"
            description="This profile uses vanilla game files: any packs from other profiles are removed when it's applied."
          />
        ) : (
          <Card className="divide-y divide-line">
            {selected.map((pack, index) => (
              <div key={pack.id} className="flex items-center gap-3 px-3 py-2.5">
                <CategoryIcon category={pack.category} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{pack.name}</p>
                  <p className="text-xs text-muted">
                    {CATEGORY_LABEL[pack.category]} · {ROOT_LABEL[pack.root]} ·{" "}
                    {plural(pack.files.length, "file")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move down"
                  disabled={index === selected.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove from profile"
                  onClick={() =>
                    update((d) => void (d.packs = d.packs.filter((id) => id !== pack.id)))
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
          </Card>
        )}
        <div className="mt-3 space-y-3">
          {conflicts.length > 0 && (
            <Banner
              tone="info"
              title={`${plural(conflicts.length, "file")} shipped by more than one pack`}
            >
              {conflicts.slice(0, 3).map((c) => (
                <div key={c.path}>
                  <span className="font-mono text-fg">{c.path}</span>: {c.packs.join(" vs ")} (
                  {c.packs[c.packs.length - 1]} wins)
                </div>
              ))}
            </Banner>
          )}
          {touchesGta && (
            <Banner tone="warn" title="This profile changes files in the GTA V game folder">
              They also affect Story Mode and GTA Online. Restore vanilla (or switch to a profile
              without these packs) before playing Online.
            </Banner>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold">Library</h3>
        <p className="mb-2 text-xs text-muted">Add packs from your library to this profile.</p>
        {available.length === 0 ? (
          <EmptyState title="Every pack is already in this profile" />
        ) : (
          <div className="space-y-4">
            {CATEGORY_ORDER.map((category) => {
              const items = available.filter((p) => p.category === category);
              if (!items.length) return null;
              return (
                <div key={category}>
                  <p className="mb-1.5 text-[11px] font-medium tracking-wider text-subtle uppercase">
                    {CATEGORY_LABEL[category]}
                  </p>
                  <Card className="divide-y divide-line">
                    {items.map((pack) => (
                      <div key={pack.id} className="flex items-center gap-3 px-3 py-2.5">
                        <CategoryIcon category={pack.category} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{pack.name}</p>
                          <p className="text-xs text-muted">
                            {ROOT_LABEL[pack.root]} · {formatBytes(pack.totalSize)}
                          </p>
                        </div>
                        {pack.root === "gtaInstall" && <Badge tone="warn">GTA folder</Badge>}
                        <Button
                          size="sm"
                          icon={<Plus className="size-3.5" />}
                          onClick={() => update((d) => void d.packs.push(pack.id))}
                        >
                          Add
                        </Button>
                      </div>
                    ))}
                  </Card>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
