import { Plus, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, errorMessage } from "../../api";
import { PageBody, PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/button";
import { SectionTitle } from "../../components/ui/misc";
import { useApp } from "../../store/app";
import { Notices } from "./Notices";
import { NewProfileDialog } from "./NewProfileDialog";
import { ProfileCard } from "./ProfileCard";

export function HomePage() {
  const profiles = useApp((s) => s.profiles);
  const [creating, setCreating] = useState(false);

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
        description="Each profile has its own settings, sounds, mods and server. Press Play and Loadout switches everything over, then joins the server."
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
            title="Profiles"
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-4" />}
                onClick={() => setCreating(true)}
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
              onClick={() => setCreating(true)}
              className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm text-muted transition-colors hover:border-accent/50 hover:text-fg"
            >
              <Plus className="size-5" />
              New profile
            </button>
          </div>
        </section>
      </PageBody>

      <NewProfileDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
