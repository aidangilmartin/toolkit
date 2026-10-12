import { ArrowUpCircle, CircleCheck, Download, ExternalLink, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Progress, UpdateInfo } from "../../api/types";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/ui/button";
import { ProgressBar } from "../../components/ui/misc";
import { Modal } from "../../components/ui/overlay";
import { formatBytes } from "../../lib/format";
import { useApp } from "../../store/app";

type Phase = "ready" | "downloading" | "failed";

/** "A new version is out": what's new, and one button to download and install it. */
export function UpdateDialog() {
  const update = useApp((s) => s.update);
  const open = useApp((s) => s.updateOpen);
  const setOpen = useApp((s) => s.setUpdateOpen);
  if (!update) return null;
  return <UpdateFlow key={update.version} update={update} open={open} onOpenChange={setOpen} />;
}

function UpdateFlow({
  update,
  open,
  onOpenChange,
}: {
  update: UpdateInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = phase === "downloading";
  const downloaded = progress !== null && progress.total > 0 && progress.done >= progress.total;

  const install = async () => {
    setPhase("downloading");
    setProgress(null);
    setError(null);
    const unlisten = await api.onUpdateProgress(setProgress);
    try {
      // On success Loadout closes, and the new version opens by itself.
      await api.installUpdate();
    } catch (err) {
      setError(errorMessage(err));
      setPhase("failed");
    } finally {
      unlisten();
    }
  };

  const openPage = () => void api.openReleasePage().catch((err) => toast.error(errorMessage(err)));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!busy}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <ArrowUpCircle className="size-5 text-accent" />
          Update available
        </span>
      }
      description={`Loadout ${update.version} is out. You have ${update.currentVersion}.`}
      footer={
        phase === "downloading" ? null : (
          <>
            {phase === "failed" ? (
              <Button variant="ghost" icon={<ExternalLink className="size-4" />} onClick={openPage}>
                Open download page
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Later
              </Button>
            )}
            <Button
              variant="primary"
              icon={<Download className="size-4" />}
              onClick={() => void install()}
            >
              {phase === "failed" ? "Try again" : "Update now"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {update.notes.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted">What's new</p>
            <ul className="space-y-1.5">
              {update.notes.map((note) => (
                <li key={note} className="flex gap-2 text-sm">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {phase === "downloading" ? (
          <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
            <div className="flex items-center gap-2 text-sm">
              <LoaderCircle className="size-4 animate-spin text-accent" />
              {downloaded
                ? update.kind === "installer"
                  ? "Installing… Loadout will close and reopen by itself."
                  : "Restarting Loadout…"
                : "Downloading…"}
            </div>
            <ProgressBar value={progress && progress.total ? progress.done / progress.total : 0} />
            <p className="text-[11px] text-subtle">
              {formatBytes(progress?.done ?? 0)} of {formatBytes(update.size)} · checked against the
              published checksum before installing
            </p>
          </div>
        ) : phase === "failed" ? (
          <Banner tone="danger" title="The update didn't install">
            {error} Your current version still works.
          </Banner>
        ) : (
          <p className="text-xs text-muted">
            {update.kind === "installer"
              ? "Loadout downloads the installer and runs it with just a progress bar, then reopens. Your profiles, sounds and mods stay as they are."
              : "Loadout downloads the new version, swaps it in and restarts. Your profiles, sounds and mods stay as they are."}{" "}
            {formatBytes(update.size)} download.
          </p>
        )}
      </div>
    </Modal>
  );
}
