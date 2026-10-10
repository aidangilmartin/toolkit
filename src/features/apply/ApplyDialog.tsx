import {
  ArrowRight,
  CircleCheck,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  RefreshCw,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { ApplyPlan, FileOpPlan, Progress, SettingsTarget } from "../../api/types";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/ui/button";
import { Badge, ColorDot, ProgressBar } from "../../components/ui/misc";
import { Modal } from "../../components/ui/overlay";
import { formatBytes, plural } from "../../lib/format";
import { displayValue, serverLabel } from "../../lib/profile";
import { useApp, type AfterApply, type ApplyRequest } from "../../store/app";

type Phase =
  | { name: "planning" }
  | { name: "blocked"; plan: ApplyPlan }
  | { name: "review"; plan: ApplyPlan }
  | { name: "applying"; plan: ApplyPlan; progress: Progress | null }
  | { name: "failed"; message: string };

const targetLabel: Record<SettingsTarget, string> = {
  fivemGraphics: "FiveM graphics",
  gtaGraphics: "GTA V graphics (Story Mode & Online)",
  fivemCfg: "In-game settings",
};

export function ApplyDialog() {
  const request = useApp((s) => s.apply);
  const close = useApp((s) => s.closeApply);
  return request ? <ApplyFlow key={request.key} request={request} onClose={close} /> : null;
}

function thenLabel(then: AfterApply, serverName: string | null): string {
  if (!then) return "Apply";
  if (then.kind === "launch") return "Apply & launch FiveM";
  return serverName ? `Apply & join ${serverName}` : "Apply & join";
}

function ApplyFlow({ request, onClose }: { request: ApplyRequest; onClose: () => void }) {
  const profiles = useApp((s) => s.profiles);
  const confirmFiles = useApp((s) => s.config?.confirmFileChanges ?? true);
  const refresh = useApp((s) => s.refresh);
  const [phase, setPhase] = useState<Phase>({ name: "planning" });
  const [closing, setClosing] = useState(false);
  const started = useRef(false);

  const profile = profiles.find((p) => p.id === request.profileId);
  const then = request.then;
  const serverName = then?.kind === "connect" && profile ? serverLabel(profile) : null;
  const title = profile ? profile.name : "Restore vanilla";

  const runThen = useCallback(async () => {
    const then = request.then;
    if (!then) return;
    if (then.kind === "launch") {
      await api.launchFivem();
      toast.success("Starting FiveM…");
    } else {
      await api.connectServer(then.address);
      toast.success(`Joining ${serverName ?? then.address}…`);
    }
  }, [request.then, serverName]);

  const apply = useCallback(
    async (plan: ApplyPlan) => {
      setPhase({ name: "applying", plan, progress: null });
      const unlisten = await api.onProgress((progress) =>
        setPhase((p) => (p.name === "applying" ? { ...p, progress } : p)),
      );
      try {
        await api.applyProfile(request.profileId);
        unlisten();
        await refresh("status", "snapshots", "packs");
        toast.success(profile ? `“${profile.name}” applied` : "Back to vanilla");
        try {
          await runThen();
        } catch (error) {
          toast.error(errorMessage(error));
        }
        onClose();
      } catch (error) {
        unlisten();
        await refresh("status");
        setPhase({ name: "failed", message: errorMessage(error) });
      }
    },
    [onClose, profile, refresh, request.profileId, runThen],
  );

  const plan = useCallback(async () => {
    setPhase({ name: "planning" });
    try {
      const result = await api.planApply(request.profileId);
      if (result.errors.length) {
        setPhase({ name: "failed", message: result.errors.join("\n") });
      } else if (result.runningProcesses.length) {
        setPhase({ name: "blocked", plan: result });
      } else {
        const needsReview =
          !profile || // restoring vanilla always asks first
          result.warnings.length > 0 ||
          result.conflicts.length > 0 ||
          (confirmFiles && result.files.length > 0);
        if (needsReview) setPhase({ name: "review", plan: result });
        else await apply(result);
      }
    } catch (error) {
      setPhase({ name: "failed", message: errorMessage(error) });
    }
  }, [apply, confirmFiles, profile, request.profileId]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void plan();
  }, [plan]);

  // While the game is running, keep checking and continue on our own once it closes.
  useEffect(() => {
    if (phase.name !== "blocked") return;
    const timer = window.setInterval(async () => {
      const running = await api.runningProcesses().catch(() => ["?"]);
      if (running.length === 0) {
        window.clearInterval(timer);
        void plan();
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [phase.name, plan]);

  const busy = phase.name === "applying" || phase.name === "planning";

  let body: ReactNode = null;
  let footer: ReactNode = null;
  switch (phase.name) {
    case "planning":
      body = (
        <div className="flex items-center gap-3 py-6 text-sm text-muted">
          <LoaderCircle className="size-5 animate-spin" /> Checking what needs to change…
        </div>
      );
      break;
    case "blocked":
      body = (
        <div className="space-y-4">
          <Banner tone="warn" title="Close the game first">
            FiveM reads its settings and mods when it starts, and saves over them when it exits.
            Loadout will carry on by itself as soon as these are closed:
            <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-fg">
              {phase.plan.runningProcesses.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </Banner>
          <div className="flex items-center gap-2 text-xs text-muted">
            <LoaderCircle className="size-3.5 animate-spin" /> Waiting for the game to close…
          </div>
        </div>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={closing}
            onClick={async () => {
              setClosing(true);
              try {
                await api.closeGame();
              } finally {
                setClosing(false);
              }
            }}
          >
            Close FiveM for me
          </Button>
        </>
      );
      break;
    case "review":
      body = <PlanSummary plan={phase.plan} vanilla={!profile} />;
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void apply(phase.plan)}
            icon={request.then ? <Play className="size-3.5 fill-current" /> : undefined}
          >
            {profile ? thenLabel(request.then, serverName) : "Restore vanilla"}
          </Button>
        </>
      );
      break;
    case "applying": {
      const p = phase.progress;
      body = (
        <div className="space-y-3 py-2">
          <ProgressBar value={p ? p.done / Math.max(p.total, 1) : 0.05} />
          <p className="truncate text-xs text-muted">
            {p?.message || "Starting…"}
            {p && p.total > 1 && ` · ${formatBytes(p.done)} of ${formatBytes(p.total)}`}
          </p>
        </div>
      );
      break;
    }
    case "failed":
      body = (
        <Banner tone="danger" title="Nothing was changed">
          <span className="whitespace-pre-line selectable">{phase.message}</span>
        </Banner>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button icon={<RefreshCw className="size-4" />} onClick={() => void plan()}>
            Try again
          </Button>
        </>
      );
      break;
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      dismissable={!busy}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          {profile ? <ColorDot color={profile.color} /> : <Undo2 className="size-4 text-muted" />}
          {phase.name === "applying" ? `Applying ${title}…` : title}
        </span>
      }
      description={
        phase.name === "review"
          ? "Here's what will change. Everything is backed up first and can be undone."
          : undefined
      }
      footer={footer}
    >
      {body}
    </Modal>
  );
}

function PlanSummary({ plan, vanilla }: { plan: ApplyPlan; vanilla: boolean }) {
  const schema = useApp((s) => s.schema);
  const settings = plan.settings.filter((s) => s.changes.length > 0 || s.skipped.length > 0);
  const nothing = settings.length === 0 && plan.files.length === 0;
  const touchesGta = plan.files.some((f) => f.root === "gtaInstall" && f.kind !== "forget");

  return (
    <div className="space-y-5">
      {plan.warnings.map((warning) => (
        <Banner key={warning} tone="warn" title={warning} />
      ))}
      {nothing && (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
          <CircleCheck className="size-4 text-accent" />
          {vanilla
            ? "Nothing to undo: your game files are already vanilla."
            : "Everything already matches this profile."}
        </div>
      )}

      {settings.map((file) => (
        <details
          key={file.target}
          className="group rounded-xl border border-line bg-surface-2"
          open={file.changes.length <= 8}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3">
            <span className="text-sm font-medium">{targetLabel[file.target]}</span>
            <Badge tone="info">{plural(file.changes.length, "change")}</Badge>
          </summary>
          <div className="space-y-1 border-t border-line px-4 py-3">
            {file.changes.map((change) => {
              const def = schema?.settings.find((s) => s.key === change.key);
              return (
                <div key={change.key} className="grid grid-cols-[1fr_auto] gap-4 text-xs">
                  <span className="truncate text-muted">{def?.label ?? change.key}</span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <span className="text-subtle">
                      {displayValue(def, change.from ?? undefined)}
                    </span>
                    <ArrowRight className="size-3 text-subtle" />
                    <span>{displayValue(def, change.to)}</span>
                  </span>
                </div>
              );
            })}
            {file.skipped.length > 0 && (
              <p className="pt-1 text-[11px] text-warn">
                Skipped (not in this file): {file.skipped.join(", ")}
              </p>
            )}
          </div>
        </details>
      ))}

      {plan.files.length > 0 && (
        <div className="rounded-xl border border-line bg-surface-2">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-medium">Sounds & mods</span>
            <span className="text-xs text-muted">
              {plural(plan.files.length, "file")} · {formatBytes(plan.copyBytes)} to copy
            </span>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto border-t border-line px-4 py-3">
            {plan.files.map((file) => (
              <FileRow key={`${file.kind}:${file.path}`} file={file} />
            ))}
          </div>
        </div>
      )}

      {plan.conflicts.length > 0 && (
        <Banner tone="info" title="Some files are in this profile twice">
          {plan.conflicts.map((c) => (
            <div key={c.path}>
              <span className="font-mono text-fg">{c.path}</span>: “{c.winner}” wins (it was added
              last).
            </div>
          ))}
        </Banner>
      )}
      {touchesGta && (
        <p className="flex items-start gap-2 text-xs text-muted">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          Some files go into the GTA V game folder. They also affect Story Mode and GTA Online, so
          restore vanilla before playing Online.
        </p>
      )}
    </div>
  );
}

const fileKinds: Record<FileOpPlan["kind"], { icon: ReactNode; label: string; className: string }> =
  {
    install: { icon: <Plus className="size-3" />, label: "Install", className: "text-accent" },
    replace: { icon: <RefreshCw className="size-3" />, label: "Swap", className: "text-info" },
    remove: { icon: <Minus className="size-3" />, label: "Remove", className: "text-warn" },
    forget: { icon: <ArrowRight className="size-3" />, label: "Leave", className: "text-subtle" },
  };

function FileRow({ file }: { file: FileOpPlan }) {
  const kind = fileKinds[file.kind];
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span className={`flex w-16 shrink-0 items-center gap-1 font-medium ${kind.className}`}>
          {kind.icon}
          {kind.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg" title={file.path}>
          {file.path}
        </span>
        {file.backsUpOriginal && <Badge>backs up original</Badge>}
        {file.restoresOriginal && <Badge tone="accent">restores original</Badge>}
      </div>
      {file.note && <p className="mt-0.5 pl-18 text-[11px] text-subtle">{file.note}</p>}
    </div>
  );
}
