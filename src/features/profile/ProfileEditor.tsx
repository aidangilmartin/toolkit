import { ChevronLeft, Play, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { CapturedSettings, Profile } from "../../api/types";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/form";
import { Badge, Card, EmptyState } from "../../components/ui/misc";
import { TabPanel, Tabs } from "../../components/ui/overlay";
import { serverLabel } from "../../lib/profile";
import { useApp, type AfterApply } from "../../store/app";
import { ColorPicker } from "../home/NewProfileDialog";
import { GraphicsTab } from "./GraphicsTab";
import { IngameTab } from "./IngameTab";
import { FilesSection } from "./FilesSection";
import { RawTab } from "./RawTab";
import { ServerSection } from "./ServerSection";

export interface TabProps {
  draft: Profile;
  update: (change: (draft: Profile) => void) => void;
  captured: CapturedSettings | null;
}

export function ProfileEditor({ profileId }: { profileId: string }) {
  const profiles = useApp((s) => s.profiles);
  const schema = useApp((s) => s.schema);
  const navigate = useApp((s) => s.navigate);
  const setDirty = useApp((s) => s.setDirty);
  const refresh = useApp((s) => s.refresh);
  const requestApply = useApp((s) => s.requestApply);
  const original = profiles.find((p) => p.id === profileId);
  const [draft, setDraft] = useState<Profile | null>(() =>
    original ? structuredClone(original) : null,
  );
  const [captured, setCaptured] = useState<CapturedSettings | null>(null);
  const [tab, setTab] = useState("graphics");
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(
    () => Boolean(draft && original && JSON.stringify(draft) !== JSON.stringify(original)),
    [draft, original],
  );

  useEffect(() => setDirty(dirty), [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);
  useEffect(() => {
    api.captureCurrent().then(setCaptured, () => setCaptured(null));
  }, []);

  if (!draft || !original || !schema) {
    return (
      <div className="p-8">
        <EmptyState
          title="This profile doesn't exist any more"
          action={<Button onClick={() => navigate({ name: "home" })}>Back</Button>}
        />
      </div>
    );
  }

  const update = (change: (draft: Profile) => void) =>
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      change(next);
      return next;
    });

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const saved = await api.saveProfile(draft);
      await refresh("profiles");
      setDraft(structuredClone(saved));
      toast.success("Profile saved");
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const graphicsCount = Object.keys(draft.graphics).length;
  const serverName = serverLabel(draft);
  const rawCount = Object.keys(draft.graphics).filter(
    (key) => !schema.settings.some((s) => s.key === key),
  ).length;

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        leading={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            onClick={() => navigate({ name: "home" })}
          >
            <ChevronLeft className="size-5" />
          </Button>
        }
        title={
          <input
            value={draft.name}
            onChange={(e) => update((d) => void (d.name = e.target.value))}
            maxLength={60}
            aria-label="Profile name"
            className="w-full rounded-md bg-transparent px-1 -ml-1 outline-none focus:bg-surface-2"
          />
        }
        description={dirty ? "Unsaved changes" : "All changes saved"}
        actions={
          <>
            <Button
              variant={dirty ? "secondary" : "ghost"}
              icon={<Save className="size-4" />}
              loading={saving}
              disabled={!dirty}
              onClick={() => void save()}
            >
              Save
            </Button>
            <Button
              variant="primary"
              icon={<Play className="size-3.5 fill-current" />}
              onClick={async () => {
                if (dirty && !(await save())) return;
                // Read the saved profile: saving normalises the address.
                const saved = useApp.getState().profiles.find((p) => p.id === draft.id);
                const then: AfterApply = saved?.serverAddress
                  ? { kind: "connect", address: saved.serverAddress }
                  : { kind: "launch" };
                requestApply(draft.id, then);
              }}
            >
              {dirty ? "Save & play" : "Play"}
            </Button>
          </>
        }
      />
      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-8 py-6">
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
          <Card className="p-4">
            <p className="mb-3 text-xs font-medium text-muted">
              Server{serverName ? ` · Play joins ${serverName}` : " · Play only starts FiveM"}
            </p>
            <ServerSection
              value={draft}
              color={draft.color}
              onChange={(patch) => update((d) => void Object.assign(d, patch))}
            />
          </Card>
          <div className="space-y-4">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-muted">Colour</span>
              <ColorPicker
                value={draft.color}
                onChange={(c) => update((d) => void (d.color = c))}
              />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Notes</span>
              <Textarea
                value={draft.notes}
                onChange={(e) => update((d) => void (d.notes = e.target.value))}
                placeholder="What's this profile for?"
                className="min-h-9 resize-none py-1.5"
                rows={2}
              />
            </label>
          </div>
        </div>
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            {
              value: "graphics",
              label: "Graphics",
              badge: <Badge>{graphicsCount - rawCount}</Badge>,
            },
            {
              value: "files",
              label: "Sounds & mods",
              badge: <Badge>{draft.packs.length}</Badge>,
            },
            {
              value: "ingame",
              label: "In-game settings",
              badge: <Badge>{Object.keys(draft.fivemCfg).length}</Badge>,
            },
            {
              value: "raw",
              label: "Advanced",
              badge: rawCount ? <Badge>{rawCount}</Badge> : undefined,
            },
          ]}
        >
          <TabPanel value="graphics" className="pt-5 outline-none">
            <GraphicsTab draft={draft} update={update} captured={captured} />
          </TabPanel>
          <TabPanel value="files" className="pt-5 outline-none">
            <FilesSection
              packIds={draft.packs}
              onChange={(ids) => update((d) => void (d.packs = ids))}
            />
          </TabPanel>
          <TabPanel value="ingame" className="pt-5 outline-none">
            <IngameTab draft={draft} update={update} captured={captured} />
          </TabPanel>
          <TabPanel value="raw" className="pt-5 outline-none">
            <RawTab draft={draft} update={update} captured={captured} />
          </TabPanel>
        </Tabs>
      </div>
    </div>
  );
}
