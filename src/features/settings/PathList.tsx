import { CircleAlert, CircleCheck, FolderOpen, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { PathInfo, PathKey, PathOverrides } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Badge, Card } from "../../components/ui/misc";
import { Tooltip } from "../../components/ui/overlay";
import { useApp } from "../../store/app";

const overrideKey: Record<PathKey, keyof PathOverrides> = {
  fivemApp: "fivemAppDir",
  citizenFx: "citizenfxDir",
  gtaInstall: "gtaInstallDir",
  gtaDocuments: "gtaDocumentsDir",
};

/** Detected folders, with "Browse" / "Reset" to override detection. */
export function PathList() {
  const status = useApp((s) => s.status);
  const config = useApp((s) => s.config);
  const saveConfig = useApp((s) => s.saveConfig);
  if (!status || !config) return null;

  const setOverride = async (info: PathInfo, value: string | null) => {
    await saveConfig({ ...config, paths: { ...config.paths, [overrideKey[info.key]]: value } });
  };

  const browse = async (info: PathInfo) => {
    try {
      const picked = await api.pickFolder(info.label);
      if (picked) await setOverride(info, picked);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Card className="divide-y divide-line">
      {status.paths.map((info) => (
        <div key={info.key} className="flex items-center gap-4 px-4 py-3">
          {info.exists ? (
            <CircleCheck className="size-5 shrink-0 text-accent" />
          ) : (
            <CircleAlert className="size-5 shrink-0 text-warn" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{info.label}</p>
              {info.source === "override" && <Badge tone="info">set by you</Badge>}
              {info.source === "missing" && <Badge tone="warn">not found</Badge>}
            </div>
            <Tooltip content={info.hint}>
              <p className="truncate font-mono text-[11px] text-muted selectable">
                {info.path ?? info.hint}
              </p>
            </Tooltip>
          </div>
          {info.exists && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open folder"
              onClick={() =>
                void api
                  .openFolder({ kind: "game", key: info.key })
                  .catch((e) => toast.error(errorMessage(e)))
              }
            >
              <FolderOpen className="size-4" />
            </Button>
          )}
          {info.source === "override" && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-3.5" />}
              onClick={() => void setOverride(info, null)}
            >
              Auto-detect
            </Button>
          )}
          <Button size="sm" onClick={() => void browse(info)}>
            Browse…
          </Button>
        </div>
      ))}
    </Card>
  );
}
