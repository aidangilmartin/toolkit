/**
 * Drag and drop of files from Explorer. Tauri takes file drops itself (that's how it can tell us
 * their paths), so the page never sees an HTML drop. This turns each Tauri drop back into a DOM
 * `drop` event on the element under the cursor, carrying placeholder Files with their paths, so
 * the editor's ordinary onDrop handlers work unchanged.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";

const paths = new WeakMap<File, string>();

/** The full path of a dropped file. */
export function filePath(file: File): string {
  return paths.get(file) ?? file.name;
}

/** Starts forwarding drops; returns a function that stops it. */
export async function forwardFileDrops(): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    const scale = window.devicePixelRatio || 1;
    const x = event.payload.position.x / scale;
    const y = event.payload.position.y / scale;
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    const data = new DataTransfer();
    for (const path of event.payload.paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      const file = new File([], name);
      paths.set(file, path);
      data.items.add(file);
    }
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        dataTransfer: data,
      }),
    );
  });
}
