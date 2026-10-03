import { ChevronDown, FileDown, Globe, Info } from "lucide-react";

import type { SettingDef, SettingGroup } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Checkbox, Input, Select, Slider, Switch } from "../../components/ui/form";
import { Badge, Card } from "../../components/ui/misc";
import { Menu, MenuItem, Tooltip } from "../../components/ui/overlay";
import { cn } from "../../lib/cn";
import { defaultValue, displayValue, matchingPreset, normalizeValue } from "../../lib/profile";
import { useApp } from "../../store/app";
import type { TabProps } from "./ProfileEditor";

const groups: { id: SettingGroup; title: string; description: string }[] = [
  {
    id: "display",
    title: "Display",
    description: "Screen mode and VSync. Resolution is optional (handy for stretched res).",
  },
  { id: "graphics", title: "Graphics", description: "The main graphics menu." },
  { id: "advanced", title: "Advanced graphics", description: "The heavy hitters." },
];

export function GraphicsTab({ draft, update, captured }: TabProps) {
  const schema = useApp((s) => s.schema)!;
  const preset = matchingPreset(draft.graphics, schema);

  const setValue = (key: string, value: string | undefined) =>
    update((d) => {
      if (value === undefined) delete d.graphics[key];
      else d.graphics[key] = value;
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Menu
          trigger={
            <Button size="sm" icon={<ChevronDown className="size-3.5" />}>
              Fill from preset
            </Button>
          }
        >
          {schema.presets.map((p) => (
            <MenuItem
              key={p.id}
              onSelect={() =>
                update((d) => {
                  Object.assign(d.graphics, p.values);
                })
              }
            >
              <span>
                <span className="block">{p.name}</span>
                <span className="block text-xs text-muted">{p.description}</span>
              </span>
            </MenuItem>
          ))}
        </Menu>
        <Button
          size="sm"
          variant="ghost"
          icon={<FileDown className="size-3.5" />}
          disabled={!captured?.fivemGraphicsFound}
          onClick={() =>
            update((d) => {
              Object.assign(d.graphics, captured?.graphicsDefault ?? {});
            })
          }
        >
          Copy my current FiveM settings
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            update((d) => {
              for (const def of schema.settings) delete d.graphics[def.key];
            })
          }
        >
          Clear all
        </Button>
        {preset && (
          <Badge tone="accent" className="ml-auto">
            Matches {preset.name}
          </Badge>
        )}
      </div>

      <Card className="flex items-center gap-4 px-4 py-3">
        <Globe className="size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Also apply to GTA V (Story Mode & GTA Online)</p>
          <p className="text-xs text-muted">
            FiveM keeps its own settings file. Turn this on to write the same graphics to GTA V's
            settings.xml too.
          </p>
        </div>
        <Switch
          checked={draft.applyToGta}
          onCheckedChange={(on) => update((d) => void (d.applyToGta = on))}
          label="Also apply to GTA V"
        />
      </Card>

      {groups.map((group) => {
        const defs = schema.settings.filter((s) => s.group === group.id);
        const included = defs.filter((d) => draft.graphics[d.key] !== undefined).length;
        return (
          <section key={group.id}>
            <div className="mb-2 flex items-end justify-between">
              <div>
                <h3 className="text-sm font-semibold">{group.title}</h3>
                <p className="text-xs text-muted">{group.description}</p>
              </div>
              <span className="text-xs text-subtle">
                {included} of {defs.length} set by this profile
              </span>
            </div>
            <Card className="divide-y divide-line">
              {defs.map((def) => (
                <SettingRow
                  key={def.key}
                  def={def}
                  value={draft.graphics[def.key]}
                  current={captured?.graphicsAll[def.key]}
                  onChange={(value) => setValue(def.key, value)}
                />
              ))}
            </Card>
          </section>
        );
      })}
    </div>
  );
}

function SettingRow({
  def,
  value,
  current,
  onChange,
}: {
  def: SettingDef;
  value: string | undefined;
  current: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const included = value !== undefined;
  const shown = value ?? current ?? defaultValue(def);
  const set = (v: string) => onChange(normalizeValue(def, v));

  return (
    <div className={cn("flex items-center gap-4 px-4 py-2.5", !included && "opacity-75")}>
      <Checkbox
        checked={included}
        onCheckedChange={(on) =>
          onChange(on ? normalizeValue(def, defaultValue(def, current)) : undefined)
        }
        label={`Include ${def.label}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("text-sm", included ? "text-fg" : "text-muted")}>{def.label}</span>
          {!def.verified && (
            <Tooltip content="Value names for this setting haven't been confirmed in-game yet. Check the result after applying.">
              <span>
                <Badge tone="warn">verify</Badge>
              </span>
            </Tooltip>
          )}
          {def.description && (
            <Tooltip content={def.description}>
              <Info className="size-3.5 text-subtle" />
            </Tooltip>
          )}
        </div>
        {!included && (
          <p className="text-[11px] text-subtle">
            Not changed{current !== undefined && ` · currently ${displayValue(def, current)}`}
          </p>
        )}
      </div>
      <div className="flex w-64 shrink-0 justify-end">
        <Control def={def} value={shown} disabled={!included} onChange={set} />
      </div>
    </div>
  );
}

function Control({
  def,
  value,
  disabled,
  onChange,
}: {
  def: SettingDef;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const control = def.control;
  switch (control.kind) {
    case "select":
      return (
        <Select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full [&_select]:h-8"
          aria-label={def.label}
        >
          {!control.options.some((o) => o.value === value) && (
            <option value={value}>{value} (unknown)</option>
          )}
          {control.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case "toggle":
      return (
        <Switch
          checked={value === "true"}
          disabled={disabled}
          onCheckedChange={(on) => onChange(on ? "true" : "false")}
          label={def.label}
        />
      );
    case "slider":
      return (
        <div className="flex w-full items-center gap-3">
          <Slider
            value={Number(value)}
            min={control.min}
            max={control.max}
            step={control.step}
            disabled={disabled}
            onValueChange={(v) => onChange(v.toFixed(6))}
            label={def.label}
          />
          <span className="w-10 text-right text-xs tabular-nums text-muted">
            {Math.round(Number(value) * 100)}%
          </span>
        </div>
      );
    case "number":
      return (
        <Input
          type="number"
          value={value}
          min={control.min}
          max={control.max}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-28 text-right"
          aria-label={def.label}
        />
      );
  }
}
