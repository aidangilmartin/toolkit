import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Toaster } from "sonner";

import { Sidebar } from "./components/Sidebar";
import { Button } from "./components/ui/button";
import { ConfirmDialog, TooltipProvider } from "./components/ui/overlay";
import { ApplyDialog } from "./features/apply/ApplyDialog";
import { BackupsPage } from "./features/backups/BackupsPage";
import { HomePage } from "./features/home/HomePage";
import { ProfileEditor } from "./features/profile/ProfileEditor";
import { SettingsPage } from "./features/settings/SettingsPage";
import { SetupWizard } from "./features/setup/SetupWizard";
import { useApp } from "./store/app";

export default function App() {
  const loaded = useApp((s) => s.loaded);
  const loadError = useApp((s) => s.loadError);
  const setupComplete = useApp((s) => s.config?.setupComplete ?? false);
  const view = useApp((s) => s.view);
  const pendingView = useApp((s) => s.pendingView);

  useEffect(() => {
    void useApp.getState().init();
    const poll = window.setInterval(() => void useApp.getState().pollRunning(), 2500);
    const onFocus = () => void useApp.getState().refresh("status");
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <TriangleAlert className="size-8 text-warn" />
        <div>
          <p className="font-medium">Loadout couldn't start</p>
          <p className="mt-1 max-w-md text-sm text-muted selectable">{loadError}</p>
        </div>
        <Button onClick={() => void useApp.getState().init()}>Try again</Button>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="size-6 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <TooltipProvider>
      {setupComplete ? (
        <div className="flex h-full">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-y-auto">
            {view.name === "home" && <HomePage />}
            {view.name === "profile" && <ProfileEditor key={view.id} profileId={view.id} />}
            {view.name === "backups" && <BackupsPage />}
            {view.name === "settings" && <SettingsPage />}
          </main>
        </div>
      ) : (
        <SetupWizard />
      )}
      <ApplyDialog />
      <ConfirmDialog
        open={pendingView !== null}
        onOpenChange={(open) => !open && useApp.getState().cancelNavigation()}
        title="Discard unsaved changes?"
        description="You've changed this profile without saving."
        confirmLabel="Discard"
        tone="danger"
        onConfirm={() => {
          const target = useApp.getState().pendingView;
          if (target) useApp.getState().navigate(target, { force: true });
        }}
      />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "!bg-surface-2 !border-line !text-fg !rounded-xl",
            description: "!text-muted",
          },
        }}
      />
    </TooltipProvider>
  );
}
