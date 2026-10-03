import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input, Select } from "../../components/ui/form";
import { Card, EmptyState } from "../../components/ui/misc";
import { useApp } from "../../store/app";
import type { TabProps } from "./ProfileEditor";

/** Settings.xml keys without a friendly control, written exactly as typed. */
export function RawTab({ draft, update, captured }: TabProps) {
  const schema = useApp((s) => s.schema)!;
  const known = new Set(schema.settings.map((s) => s.key));
  const entries = Object.entries(draft.graphics)
    .filter(([key]) => !known.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const candidates = Object.keys(captured?.graphicsAll ?? {})
    .filter((key) => !known.has(key) && draft.graphics[key] === undefined)
    .sort();
  const [adding, setAdding] = useState("");

  return (
    <div className="space-y-4">
      <Card className="px-4 py-3 text-xs text-muted">
        Settings from <span className="font-mono text-fg">gta5_settings.xml</span> that don't have a
        friendly control (shadow split distances, LOD biases…). They're written exactly as typed, so
        only change them if you know what they do.
      </Card>

      {entries.length === 0 ? (
        <EmptyState title="No advanced settings in this profile" />
      ) : (
        <Card className="divide-y divide-line">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{key}</span>
              <Input
                value={value ?? ""}
                onChange={(e) => update((d) => void (d.graphics[key] = e.target.value))}
                className="h-8 w-56 font-mono text-xs"
                aria-label={`Value for ${key}`}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${key}`}
                onClick={() => update((d) => void delete d.graphics[key])}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </Card>
      )}

      {candidates.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className="w-80 [&_select]:h-8"
            aria-label="Setting to add"
          >
            <option value="">Add a setting from your current file…</option>
            {candidates.map((key) => (
              <option key={key} value={key}>
                {key} = {captured?.graphicsAll[key]}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            icon={<Plus className="size-3.5" />}
            disabled={!adding}
            onClick={() => {
              const value = captured?.graphicsAll[adding];
              if (value !== undefined) update((d) => void (d.graphics[adding] = value));
              setAdding("");
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
