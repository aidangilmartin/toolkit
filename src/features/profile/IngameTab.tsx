import { FileDown, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox, Input } from "../../components/ui/form";
import { Card, EmptyState } from "../../components/ui/misc";
import { Modal } from "../../components/ui/overlay";
import { isProfileKey } from "../../lib/profile";
import type { TabProps } from "./ProfileEditor";

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;
const BAD_VALUE = /["\r\n;]/;

export function IngameTab({ draft, update, captured }: TabProps) {
  const [picking, setPicking] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const entries = Object.entries(draft.fivemCfg).sort(([a], [b]) => a.localeCompare(b));
  const keyError =
    newKey && !KEY_PATTERN.test(newKey) ? "Letters, numbers, _ . : - only" : undefined;

  return (
    <div className="space-y-4">
      <Card className="px-4 py-3 text-xs text-muted">
        These come from FiveM's <span className="font-mono text-fg">fivem.cfg</span>.{" "}
        <span className="font-mono text-fg">profile_*</span> entries are GTA's pause-menu settings
        (field of view, brightness, HUD, audio volumes…). The easiest way to fill this in: set
        things up in-game, close FiveM, then pick them from your current settings below.
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon={<FileDown className="size-3.5" />}
          disabled={!captured?.fivemCfgFound}
          onClick={() => setPicking(true)}
        >
          Pick from my current settings
        </Button>
        {!captured?.fivemCfgFound && (
          <span className="self-center text-xs text-subtle">
            fivem.cfg wasn't found. Start FiveM once to create it.
          </span>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title="No in-game settings in this profile"
          description="They'll stay however you last left them in-game."
        />
      ) : (
        <Card className="divide-y divide-line">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={key}>
                {key}
              </span>
              <Input
                value={value ?? ""}
                onChange={(e) => update((d) => void (d.fivemCfg[key] = e.target.value))}
                className="h-8 w-56 font-mono text-xs"
                aria-label={`Value for ${key}`}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${key}`}
                onClick={() => update((d) => void delete d.fivemCfg[key])}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </Card>
      )}

      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newKey || keyError || BAD_VALUE.test(newValue)) return;
          update((d) => void (d.fivemCfg[newKey] = newValue));
          setNewKey("");
          setNewValue("");
        }}
      >
        <div className="flex-1">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.trim())}
            placeholder="Setting name, e.g. profile_fpsFieldOfView"
            className="h-8 font-mono text-xs"
          />
          {keyError && <p className="mt-1 text-[11px] text-danger">{keyError}</p>}
        </div>
        <Input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="Value"
          className="h-8 w-56 font-mono text-xs"
        />
        <Button
          type="submit"
          size="sm"
          icon={<Plus className="size-3.5" />}
          disabled={!newKey || Boolean(keyError) || BAD_VALUE.test(newValue)}
        >
          Add
        </Button>
      </form>

      <PickDialog
        open={picking}
        onClose={() => setPicking(false)}
        all={captured?.cfgAll ?? {}}
        initial={
          Object.keys(draft.fivemCfg).length
            ? Object.keys(draft.fivemCfg)
            : Object.keys(captured?.cfgDefault ?? {})
        }
        onPick={(picked) =>
          update((d) => {
            const next: Record<string, string> = {};
            for (const [key, value] of picked) next[key] = value;
            d.fivemCfg = next;
          })
        }
      />
    </div>
  );
}

function PickDialog({
  open,
  onClose,
  all,
  initial,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  all: { [key in string]?: string };
  initial: string[];
  onPick: (entries: [string, string][]) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Pick in-game settings"
      description="Ticked settings are saved into the profile with their current values."
      size="lg"
    >
      {open && <PickList all={all} initial={initial} onPick={onPick} onClose={onClose} />}
    </Modal>
  );
}

function PickList({
  all,
  initial,
  onPick,
  onClose,
}: {
  all: { [key in string]?: string };
  initial: string[];
  onPick: (entries: [string, string][]) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState(() => new Set(initial));
  const entries = Object.entries(all)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .sort(([a], [b]) => Number(isProfileKey(b)) - Number(isProfileKey(a)) || a.localeCompare(b));
  const toggle = (key: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setChosen(new Set(entries.filter(([k]) => isProfileKey(k)).map(([k]) => k)))
          }
        >
          Only GTA in-game settings
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setChosen(new Set())}>
          None
        </Button>
      </div>
      <Card className="max-h-[50vh] divide-y divide-line overflow-y-auto">
        {entries.map(([key, value]) => (
          <label key={key} className="flex cursor-pointer items-center gap-3 px-4 py-2">
            <Checkbox checked={chosen.has(key)} onCheckedChange={(on) => toggle(key, on)} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{key}</span>
            <span className="max-w-48 truncate font-mono text-xs text-muted">{value}</span>
          </label>
        ))}
      </Card>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onPick(entries.filter(([key]) => chosen.has(key)));
            onClose();
          }}
        >
          Use {chosen.size} settings
        </Button>
      </div>
    </div>
  );
}
