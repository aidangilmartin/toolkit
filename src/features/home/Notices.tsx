import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/ui/button";
import { displayValue } from "../../lib/profile";
import { plural } from "../../lib/format";
import { useApp } from "../../store/app";

/** Recovery, in-game changes and FiveM-update warnings, shown above everything else. */
export function Notices() {
  const status = useApp((s) => s.status);
  const profiles = useApp((s) => s.profiles);
  const schema = useApp((s) => s.schema);
  const refresh = useApp((s) => s.refresh);
  const requestApply = useApp((s) => s.requestApply);
  if (!status) return null;
  const active = profiles.find((p) => p.id === status.activeProfileId);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast.success(success);
      await refresh("status", "profiles");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const drift = status.settingsDrift;
  const labelFor = (key: string) =>
    schema?.settings.find((s) => s.key === key)?.label ?? key.replace(/^graphics\/|^video\//, "");

  if (!status.recoveryNotice && !(active && drift.length) && !status.fileDrift.length) {
    return null;
  }

  return (
    <div className="space-y-3">
      {status.recoveryNotice && (
        <Banner
          tone="info"
          title="Recovered from an interrupted apply"
          onDismiss={() => void run(() => api.dismissNotice())}
        >
          {status.recoveryNotice}
        </Banner>
      )}
      {active && drift.length > 0 && (
        <Banner
          tone="warn"
          title={`Your in-game settings changed since you applied “${active.name}”`}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  void run(() => api.saveDriftToProfile(), `Saved to “${active.name}”`)
                }
              >
                Save to profile
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void run(() => api.dismissDrift())}>
                Ignore
              </Button>
            </>
          }
        >
          {plural(drift.length, "setting")} changed:{" "}
          {drift.slice(0, 4).map((d, i) => {
            const def = schema?.settings.find((s) => s.key === d.key);
            return (
              <span key={d.key}>
                {i > 0 && ", "}
                <span className="text-fg">{labelFor(d.key)}</span> {displayValue(def, d.applied)} →{" "}
                {displayValue(def, d.current ?? undefined)}
              </span>
            );
          })}
          {drift.length > 4 && ` and ${drift.length - 4} more`}. Save them into the profile so they
          stick next time, or ignore them.
        </Banner>
      )}
      {status.fileDrift.length > 0 && (
        <Banner
          tone="warn"
          title={`${plural(status.fileDrift.length, "installed file")} changed by something else`}
          actions={
            active && (
              <Button size="sm" variant="primary" onClick={() => requestApply(active.id)}>
                Re-apply “{active.name}”
              </Button>
            )
          }
        >
          Usually a FiveM update or a game file check put the original back. Re-applying installs
          your file again and keeps the new file as the original.
        </Banner>
      )}
    </div>
  );
}
