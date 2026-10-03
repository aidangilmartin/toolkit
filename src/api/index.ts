import type { Api } from "./client";
import { tauriApi } from "./tauri";
import { mockApi } from "../mock/mockApi";

export { errorMessage } from "./client";
export type { Api } from "./client";

/** Running inside the Tauri shell? Otherwise we're in a plain browser (dev/screenshots). */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api: Api = inTauri ? tauriApi : mockApi;

if (!inTauri && typeof window !== "undefined") {
  // Handy in the browser console: __loadoutMock.setRunning(["FiveM.exe"])
  (window as unknown as { __loadoutMock: typeof mockApi }).__loadoutMock = mockApi;
}
