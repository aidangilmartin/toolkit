import type { Api } from "../ipc";

let current: Api | null = null;

/** Set once by the Sound maker page before the editor mounts. */
export function setSoundApi(api: Api): void {
  current = api;
}

/** The sound maker's back end (host/service.ts), as the editor's components use it. */
export const soundApi: Api = new Proxy({} as Api, {
  get(_target, key) {
    if (!current) throw new Error("The sound maker is still starting.");
    return current[key as keyof Api];
  },
});
