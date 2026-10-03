import { FileDown, Gauge, Scale, Sparkles, Square, Sun, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import { Button } from "../../components/ui/button";
import { Field, Input } from "../../components/ui/form";
import { Modal } from "../../components/ui/overlay";
import { cn } from "../../lib/cn";
import { emptyProfile, PROFILE_COLORS } from "../../lib/profile";
import { useApp } from "../../store/app";

const presetIcons: Record<string, LucideIcon> = {
  "max-fps": Gauge,
  balanced: Scale,
  high: Sun,
  ultra: Sparkles,
};

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PROFILE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-label={`Colour ${color}`}
          className={cn(
            "size-7 rounded-full border-2 transition-transform hover:scale-110",
            value === color ? "border-fg" : "border-transparent",
          )}
          style={{ background: color }}
        />
      ))}
    </div>
  );
}

export function NewProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="New profile"
      description="Start from a preset or from the settings you're using right now. You can fine-tune everything next."
      size="md"
    >
      {open && <NewProfileForm onDone={onClose} />}
    </Modal>
  );
}

function NewProfileForm({ onDone }: { onDone: () => void }) {
  const schema = useApp((s) => s.schema);
  const profiles = useApp((s) => s.profiles);
  const refresh = useApp((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROFILE_COLORS[profiles.length % PROFILE_COLORS.length]);
  const [start, setStart] = useState<string>("current");
  const [saving, setSaving] = useState(false);

  const options = [
    {
      id: "current",
      name: "My current settings",
      description: "Copy what FiveM is using right now.",
      icon: FileDown,
    },
    ...(schema?.presets ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      icon: presetIcons[p.id] ?? Sun,
    })),
    { id: "empty", name: "Blank", description: "Change only what you pick.", icon: Square },
  ];

  const create = async () => {
    setSaving(true);
    try {
      const profile = emptyProfile({ name, color });
      if (start === "current") {
        const captured = await api.captureCurrent();
        if (!captured.fivemGraphicsFound) {
          toast.warning("FiveM's settings file wasn't found, so the profile starts blank.");
        }
        profile.graphics = captured.graphicsDefault;
        profile.fivemCfg = captured.cfgDefault;
      } else if (start !== "empty") {
        profile.graphics = { ...(schema?.presets.find((p) => p.id === start)?.values ?? {}) };
      }
      const saved = await api.saveProfile(profile);
      await refresh("profiles");
      onDone();
      navigate({ name: "profile", id: saved.id });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="grid grid-cols-[1fr_auto] items-end gap-4">
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Arena – Max FPS"
            maxLength={60}
          />
        </Field>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Colour</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
      </div>
      <div>
        <span className="mb-1.5 block text-xs font-medium text-muted">Start from</span>
        <div className="grid grid-cols-2 gap-2">
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <button
                type="button"
                key={option.id}
                onClick={() => setStart(option.id)}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                  start === option.id
                    ? "border-accent/60 bg-accent/8"
                    : "border-line bg-surface-2 hover:border-line-strong",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    start === option.id ? "text-accent" : "text-muted",
                  )}
                />
                <span>
                  <span className="block text-sm font-medium">{option.name}</span>
                  <span className="block text-xs text-muted">{option.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>
          Create profile
        </Button>
      </div>
    </form>
  );
}
