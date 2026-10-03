import { Ban, CircleMinus, FileText, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type {
  ImportProposal,
  PackCategory,
  PackLayout,
  Progress,
  ProposedFile,
} from "../../api/types";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/ui/button";
import { Checkbox, Field, Input, Select } from "../../components/ui/form";
import { Badge, ProgressBar } from "../../components/ui/misc";
import { Modal } from "../../components/ui/overlay";
import { formatBytes, plural } from "../../lib/format";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "../../lib/profile";
import { useApp } from "../../store/app";

const layouts: { value: PackLayout; label: string }[] = [
  { value: "gtaAudio", label: "GTA V folder → x64/audio/sfx (sound packs)" },
  { value: "fivemTree", label: "FiveM.app, keeping its citizen/mods/plugins folders" },
  { value: "modsFolder", label: "FiveM.app/mods (.rpf mods)" },
  { value: "pluginsFolder", label: "FiveM.app/plugins (ReShade)" },
];

export function ImportWizard({ source, onClose }: { source: string | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={source !== null}
      onOpenChange={(open) => !open && onClose()}
      dismissable={!busy}
      size="lg"
      title="Import pack"
      description={source ?? undefined}
    >
      {source && <Wizard key={source} source={source} onDone={onClose} onBusy={setBusy} />}
    </Modal>
  );
}

function Wizard({
  source,
  onDone,
  onBusy,
}: {
  source: string;
  onDone: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const refresh = useApp((s) => s.refresh);
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [importing, setImporting] = useState(false);

  const inspect = async (layout?: PackLayout) => {
    setError(null);
    try {
      const next = await api.inspectPack(source, layout ?? null);
      // Keep a name the user already typed.
      setProposal((current) => (current ? { ...next, name: current.name } : next));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void api.inspectPack(source, null).then(setProposal, (e) => setError(errorMessage(e)));
  }, [source]);

  if (error) {
    return (
      <div className="space-y-4">
        <Banner tone="danger" title="Can't import this">
          {error}
        </Banner>
        <div className="flex justify-end">
          <Button onClick={onDone}>Close</Button>
        </div>
      </div>
    );
  }
  if (!proposal) {
    return (
      <div className="flex items-center gap-3 py-8 text-sm text-muted">
        <LoaderCircle className="size-5 animate-spin" /> Looking inside…
      </div>
    );
  }

  const deploy = proposal.files.filter((f) => f.kind === "deploy" && f.include);
  const size = deploy.reduce((sum, f) => sum + f.size, 0);
  const setFile = (index: number, include: boolean) =>
    setProposal({
      ...proposal,
      files: proposal.files.map((f, i) => (i === index ? { ...f, include } : f)),
    });

  const runImport = async () => {
    setImporting(true);
    onBusy(true);
    const unlisten = await api.onProgress(setProgress);
    try {
      const pack = await api.importPack(proposal);
      await refresh("packs");
      toast.success(`Imported “${pack.name}”`, {
        description: "Add it to a profile to use it.",
      });
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      unlisten();
      setImporting(false);
      onBusy(false);
    }
  };

  if (importing) {
    return (
      <div className="space-y-3 py-4">
        <ProgressBar value={progress ? progress.done / Math.max(progress.total, 1) : 0.02} />
        <p className="truncate text-xs text-muted">{progress?.message || "Copying…"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name">
          <Input
            value={proposal.name}
            maxLength={80}
            onChange={(e) => setProposal({ ...proposal, name: e.target.value })}
          />
        </Field>
        <Field label="Category">
          <Select
            value={proposal.category}
            onChange={(e) => setProposal({ ...proposal, category: e.target.value as PackCategory })}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Install into"
        hint="Detected automatically. Change it if the pack's instructions say otherwise."
      >
        <Select
          value={proposal.layout}
          onChange={(e) => void inspect(e.target.value as PackLayout)}
        >
          {layouts.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </Select>
      </Field>

      {proposal.warnings.map((w) => (
        <Banner key={w} tone="warn" title={w} />
      ))}

      <div className="rounded-xl border border-line bg-surface-2">
        <div className="flex items-center justify-between px-4 py-2.5 text-xs">
          <span className="font-medium text-fg">Files</span>
          <span className="text-muted">
            {plural(deploy.length, "file")} to install · {formatBytes(size)}
          </span>
        </div>
        <div className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
          {proposal.files.map((file, index) => (
            <FileLine
              key={`${file.source}:${index}`}
              file={file}
              onToggle={(on) => setFile(index, on)}
            />
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          disabled={deploy.length === 0 || !proposal.name.trim()}
          onClick={() => void runImport()}
        >
          Import {plural(deploy.length, "file")}
        </Button>
      </div>
    </div>
  );
}

function FileLine({ file, onToggle }: { file: ProposedFile; onToggle: (on: boolean) => void }) {
  const selectable = file.kind === "deploy" || file.kind === "doc";
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs">
      {selectable ? (
        <Checkbox
          checked={file.include}
          onCheckedChange={onToggle}
          label={`Include ${file.source}`}
        />
      ) : file.kind === "blocked" ? (
        <Ban className="size-4 shrink-0 text-danger" />
      ) : (
        <CircleMinus className="size-4 shrink-0 text-subtle" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[11px] text-fg" title={file.source}>
          {file.source}
        </p>
        {file.kind === "deploy" && (
          <p className="truncate font-mono text-[11px] text-accent/80" title={file.dest}>
            → {file.dest}
          </p>
        )}
        {file.reason && <p className="text-[11px] text-subtle">{file.reason}</p>}
      </div>
      {file.kind === "doc" && <Badge icon={<FileText className="size-3" />}>readme</Badge>}
      {file.kind === "blocked" && <Badge tone="danger">blocked</Badge>}
      <span className="w-16 shrink-0 text-right text-muted tabular-nums">
        {formatBytes(file.size)}
      </span>
    </div>
  );
}
