import { Play, Plus, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import type { Server } from "../../api/types";
import { PageBody, PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/button";
import { Input, Select } from "../../components/ui/form";
import { SectionTitle } from "../../components/ui/misc";
import { useApp } from "../../store/app";
import { Notices } from "./Notices";
import { NewProfileDialog } from "./NewProfileDialog";
import { ProfileCard } from "./ProfileCard";
import { ServerDialog } from "./ServerDialog";
import { ServerTile } from "./ServerTile";

export function HomePage() {
  const servers = useApp((s) => s.servers);
  const profiles = useApp((s) => s.profiles);
  const requestApply = useApp((s) => s.requestApply);
  const [editing, setEditing] = useState<Server | null>(null);
  const [creatingServer, setCreatingServer] = useState(false);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [quickAddress, setQuickAddress] = useState("");
  const [quickProfile, setQuickProfile] = useState("");

  const sortedServers = [...servers].sort((a, b) =>
    (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""),
  );

  const quickPlay = async () => {
    const address = quickAddress.trim();
    if (!address) return;
    if (quickProfile) {
      requestApply(quickProfile, { kind: "connect", address, serverId: null });
      return;
    }
    try {
      await api.connectServer(address, null);
      toast.success("Opening FiveM…");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const launchOnly = async () => {
    try {
      await api.launchFivem();
      toast.success("Starting FiveM…");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <>
      <PageHeader
        title="Play"
        description="Pick a server or a profile. Loadout swaps your settings and packs, then starts FiveM."
        actions={
          <Button icon={<Rocket className="size-4" />} onClick={() => void launchOnly()}>
            Launch FiveM
          </Button>
        }
      />
      <PageBody>
        <Notices />

        <section>
          <SectionTitle
            title="Quick play"
            description="Each server remembers which profile to use."
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-4" />}
                onClick={() => setCreatingServer(true)}
              >
                Add server
              </Button>
            }
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {sortedServers.map((server) => (
              <ServerTile key={server.id} server={server} onEdit={() => setEditing(server)} />
            ))}
            <button
              onClick={() => setCreatingServer(true)}
              className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm text-muted transition-colors hover:border-accent/50 hover:text-fg"
            >
              <Plus className="size-5" />
              Add a server
            </button>
          </div>
          <form
            className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void quickPlay();
            }}
          >
            <span className="px-1 text-xs font-medium text-muted">Join once</span>
            <Input
              value={quickAddress}
              onChange={(e) => setQuickAddress(e.target.value)}
              placeholder="IP:port or cfx.re/join code"
              className="h-8 min-w-56 flex-1"
            />
            <Select
              value={quickProfile}
              onChange={(e) => setQuickProfile(e.target.value)}
              className="w-56 [&_select]:h-8"
              aria-label="Profile to apply"
            >
              <option value="">Keep current settings</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  Apply “{p.name}”
                </option>
              ))}
            </Select>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!quickAddress.trim()}
              icon={<Play className="size-3.5 fill-current" />}
            >
              Play
            </Button>
          </form>
        </section>

        <section>
          <SectionTitle
            title="Profiles"
            description="Graphics, in-game settings and packs that get switched together."
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-4" />}
                onClick={() => setCreatingProfile(true)}
              >
                New profile
              </Button>
            }
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {profiles.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} />
            ))}
            <button
              onClick={() => setCreatingProfile(true)}
              className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm text-muted transition-colors hover:border-accent/50 hover:text-fg"
            >
              <Plus className="size-5" />
              New profile
            </button>
          </div>
        </section>
      </PageBody>

      <ServerDialog
        open={creatingServer || editing !== null}
        server={editing}
        onClose={() => {
          setCreatingServer(false);
          setEditing(null);
        }}
      />
      <NewProfileDialog open={creatingProfile} onClose={() => setCreatingProfile(false)} />
    </>
  );
}
