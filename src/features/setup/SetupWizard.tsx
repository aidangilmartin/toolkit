import { ArrowRight, Check, FileDown, Gauge, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/misc";
import { emptyProfile, PROFILE_COLORS } from "../../lib/profile";
import { useApp } from "../../store/app";
import { PathList } from "../settings/PathList";

/** First run: confirm the detected folders, take the "before Loadout" backup, offer a first profile. */
export function SetupWizard() {
  const status = useApp((s) => s.status);
  const schema = useApp((s) => s.schema);
  const refresh = useApp((s) => s.refresh);
  const [step, setStep] = useState<1 | 2>(1);
  const [working, setWorking] = useState<string | null>(null);
  const fivemFound = status?.paths.find((p) => p.key === "citizenFx")?.exists ?? false;

  const finish = async (starter: "current" | "presets" | "none") => {
    setWorking(starter);
    try {
      if (starter === "current") {
        const captured = await api.captureCurrent();
        await api.saveProfile(
          emptyProfile({
            name: "My current setup",
            graphics: captured.graphicsDefault,
            fivemCfg: captured.cfgDefault,
          }),
        );
      } else if (starter === "presets" && schema) {
        const pick = [
          ["max-fps", "Arena – Max FPS", PROFILE_COLORS[0]],
          ["ultra", "RP – Ultra", PROFILE_COLORS[1]],
        ] as const;
        for (const [presetId, name, color] of pick) {
          const values = schema.presets.find((p) => p.id === presetId)?.values ?? {};
          await api.saveProfile(emptyProfile({ name, color, graphics: { ...values } }));
        }
      }
      await api.completeSetup();
      await refresh();
      toast.success("You're all set");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-12">
        <div className="mb-8 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-11" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Welcome to Loadout</h1>
            <p className="text-sm text-muted">
              Switch FiveM graphics, in-game settings, sounds and mods in one click, then join your
              server.
            </p>
          </div>
        </div>

        {step === 1 ? (
          <div className="space-y-5">
            <div>
              <h2 className="text-sm font-semibold">1. Check your game folders</h2>
              <p className="text-xs text-muted">
                Loadout found these. Anything marked “not found” can be set now or later in
                Settings. Only the FiveM ones are needed to get going.
              </p>
            </div>
            <PathList />
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                icon={<RefreshCw className="size-4" />}
                onClick={() => void refresh("status")}
              >
                Detect again
              </Button>
              <Button
                variant="primary"
                icon={<ArrowRight className="size-4" />}
                onClick={() => setStep(2)}
              >
                Continue
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <h2 className="text-sm font-semibold">2. Your first profiles</h2>
              <p className="text-xs text-muted">
                Before anything changes, Loadout backs up your current settings files. That backup
                is kept forever under Backups.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Card className="flex flex-col p-5">
                <FileDown className="size-5 text-accent" />
                <p className="mt-3 font-medium">Save what I have now</p>
                <p className="mt-1 flex-1 text-xs text-muted">
                  Creates “My current setup” from FiveM's current graphics and in-game settings, so
                  you can always switch back to it.
                </p>
                <Button
                  variant="primary"
                  className="mt-4"
                  disabled={!fivemFound || working !== null}
                  loading={working === "current"}
                  onClick={() => void finish("current")}
                >
                  Create from current settings
                </Button>
              </Card>
              <Card className="flex flex-col p-5">
                <Gauge className="size-5 text-info" />
                <p className="mt-3 font-medium">Start with two presets</p>
                <p className="mt-1 flex-1 text-xs text-muted">
                  “Arena – Max FPS” and “RP – Ultra”. Add your server, sounds and mods to them
                  afterwards.
                </p>
                <Button
                  className="mt-4"
                  disabled={working !== null}
                  loading={working === "presets"}
                  onClick={() => void finish("presets")}
                >
                  Create preset profiles
                </Button>
              </Card>
            </div>
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                variant="ghost"
                icon={<Check className="size-4" />}
                loading={working === "none"}
                disabled={working !== null}
                onClick={() => void finish("none")}
              >
                Skip, I'll make my own
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
