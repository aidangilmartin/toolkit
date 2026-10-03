import { FolderOpen, ScrollText } from "lucide-react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { AfterLaunch } from "../../api/types";
import { PageBody, PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/form";
import { Card, SectionTitle } from "../../components/ui/misc";
import { cn } from "../../lib/cn";
import { useApp } from "../../store/app";
import { PathList } from "./PathList";

const afterLaunchOptions: { value: AfterLaunch; label: string; description: string }[] = [
  { value: "keepOpen", label: "Keep Loadout open", description: "Stay on screen." },
  { value: "minimize", label: "Minimise", description: "Out of the way, one click to come back." },
  { value: "close", label: "Close", description: "Frees every bit of memory for the game." },
];

export function SettingsPage() {
  const config = useApp((s) => s.config);
  const status = useApp((s) => s.status);
  const saveConfig = useApp((s) => s.saveConfig);
  if (!config) return null;

  const open = (target: "data" | "logs") =>
    void api.openFolder({ kind: target }).catch((e) => toast.error(errorMessage(e)));

  return (
    <>
      <PageHeader title="Settings" description="Where your games live and how Loadout behaves." />
      <PageBody>
        <section>
          <SectionTitle
            title="Game folders"
            description="Found automatically. Point Loadout somewhere else if you've moved things."
          />
          <PathList />
        </section>

        <section>
          <SectionTitle title="After launching FiveM" />
          <div className="grid grid-cols-3 gap-3">
            {afterLaunchOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => void saveConfig({ ...config, afterLaunch: option.value })}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  config.afterLaunch === option.value
                    ? "border-accent/60 bg-accent/8"
                    : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <p className="text-sm font-medium">{option.label}</p>
                <p className="mt-0.5 text-xs text-muted">{option.description}</p>
              </button>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle title="Safety" />
          <Card className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                Show what will change before installing pack files
              </p>
              <p className="text-xs text-muted">
                Settings-only changes always apply straight away. Restoring vanilla always asks.
              </p>
            </div>
            <Switch
              checked={config.confirmFileChanges}
              onCheckedChange={(on) => void saveConfig({ ...config, confirmFileChanges: on })}
              label="Confirm file changes"
            />
          </Card>
        </section>

        <section>
          <SectionTitle title="Loadout's data" description={status?.dataDir} />
          <div className="flex gap-2">
            <Button icon={<FolderOpen className="size-4" />} onClick={() => open("data")}>
              Open data folder
            </Button>
            <Button icon={<ScrollText className="size-4" />} onClick={() => open("logs")}>
              Open logs
            </Button>
            <Button
              variant="ghost"
              onClick={() => void saveConfig({ ...config, setupComplete: false })}
            >
              Run first-time setup again
            </Button>
          </div>
        </section>

        <p className="pb-4 text-xs text-subtle">
          Loadout {__APP_VERSION__} · Not affiliated with Rockstar Games, Take-Two or Cfx.re. It
          only changes settings files and the client-side folders FiveM supports. Servers using Pure
          Mode may still refuse modified files.
        </p>
      </PageBody>
    </>
  );
}
