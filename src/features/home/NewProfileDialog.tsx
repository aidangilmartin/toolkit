import { FileDown, Gauge, Scale, Sparkles, Square, Sun, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/form";
import { Modal } from "../../components/ui/overlay";
import { cn } from "../../lib/cn";
import { emptyProfile, PROFILE_COLORS } from "../../lib/profile";
import { useApp } from "../../store/app";
import { FilesSection } from "../profile/FilesSection";
import { ServerSection, type ServerFields } from "../profile/ServerSection";

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
      description="Settings, sounds and mods that get switched together, and the server to join with them. You can change all of it later."
      size="lg"
    >
      {open && <NewProfileForm onDone={onClose} />}
    </Modal>
  );
}

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[1.5rem_1fr] gap-x-3">
      <span className="mt-px flex size-6 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {title}
          {hint && <span className="ml-2 text-xs font-normal text-subtle">{hint}</span>}
        </p>
        <div className="mt-2.5">{children}</div>
      </div>
    </section>
  );
}

function NewProfileForm({ onDone }: { onDone: () => void }) {
  const schema = useApp((s) => s.schema);
  const profiles = useApp((s) => s.profiles);
  const refresh = useApp((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [color, setColor] = useState(PROFILE_COLORS[profiles.length % PROFILE_COLORS.length]);
  const [server, setServer] = useState<ServerFields>({
    serverAddress: null,
    serverName: null,
    serverIcon: null,
  });
  const [lookingUp, setLookingUp] = useState(false);
  const [packs, setPacks] = useState<string[]>([]);
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
      const profile = emptyProfile({ name, color, ...server, packs });
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
      toast.success(`“${saved.name}” is ready`, {
        description: saved.serverAddress
          ? "Press Play to switch to it and join the server."
          : "Press Play to switch to it and start FiveM.",
        action: { label: "Edit", onClick: () => navigate({ name: "profile", id: saved.id }) },
      });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <Step n={1} title="Server" hint="optional">
        <ServerSection
          autoFocus
          value={server}
          color={color}
          onChange={(patch) => setServer((current) => ({ ...current, ...patch }))}
          onFound={(info) => {
            if (!nameTouched && info.name) setName(info.name.slice(0, 60));
          }}
          onBusy={setLookingUp}
        />
      </Step>

      <Step n={2} title="Name">
        <div className="grid grid-cols-[1fr_auto] items-center gap-4">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder="e.g. Arena – Max FPS"
            aria-label="Profile name"
            maxLength={60}
          />
          <ColorPicker value={color} onChange={setColor} />
        </div>
      </Step>

      <Step n={3} title="Graphics" hint="fine-tune them later in the profile">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
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
      </Step>

      <Step n={4} title="Sounds & mods" hint="optional">
        <FilesSection packIds={packs} onChange={setPacks} narrow />
      </Step>

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={saving || lookingUp}
          disabled={!name.trim()}
        >
          Create profile
        </Button>
      </div>
    </form>
  );
}
