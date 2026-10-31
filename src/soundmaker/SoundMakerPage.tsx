import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { useApp } from "../store/app";
import { memoryHost, previewShell } from "./host/memoryHost";
import { createService } from "./host/service";
import { createTauriHost, createTauriShell } from "./host/tauriHost";
import { setSoundApi } from "./ui/api";
import { App as Editor } from "./ui/App";
import { forwardFileDrops } from "./ui/drop";
import "./ui/styles.css";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The GTA V folder Loadout found, which the sound maker starts from. */
async function loadoutGtaFolder(): Promise<string | null> {
  const paths = useApp.getState().status?.paths ?? [];
  return paths.find((p) => p.key === "gtaInstall" && p.exists)?.path ?? null;
}

let started: Promise<void> | null = null;

/** Sets up the sound maker's back end once per run of the app. */
function start(): Promise<void> {
  started ??= (async () => {
    if (!inTauri) {
      // a plain browser (pnpm dev, screenshots): a preview with nothing on disk
      setSoundApi(createService(memoryHost(), previewShell()));
      return;
    }
    const host = await createTauriHost();
    setSoundApi(createService(host, createTauriShell(loadoutGtaFolder)));
    await forwardFileDrops();
  })();
  return started;
}

/**
 * The sound maker: make your own gun sounds from GTA V's originals, then add them to a profile.
 * It stays mounted once opened (see App.tsx), so switching pages keeps an unsaved project.
 */
export default function SoundMakerPage() {
  const [state, setState] = useState<"starting" | "ready" | { error: string }>("starting");

  useEffect(() => {
    start().then(
      () => setState("ready"),
      (e: unknown) => setState({ error: e instanceof Error ? e.message : String(e) }),
    );
  }, []);

  if (state === "starting") {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="size-6 animate-spin text-muted" />
      </div>
    );
  }
  if (state !== "ready") {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
        {state.error}
      </div>
    );
  }
  return (
    <div className="soundmaker">
      <Editor />
    </div>
  );
}
