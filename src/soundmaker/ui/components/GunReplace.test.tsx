import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GunFile, GunSection } from "../../core/describe";
import type { ReplacePlan } from "../../core/gunReplace";
import { GunReplace } from "./GunReplace";

const file = (streamId: number, shared = false): GunFile => ({
  pack: "weapons_player",
  bank: "ptl_pistol.awc",
  streamId,
  text: "",
  heardBy: "you",
  alsoRoles: [],
  sharedWith: shared ? [{ gun: "SMG", parts: ["fire"] }] : [],
});
const sections: GunSection[] = [
  { role: "fire", label: "Gunshot", meaning: "", inferred: false, files: [file(1), file(9, true)] },
  { role: "report", label: "Distant report", meaning: "", inferred: false, files: [file(2)] },
];
const source = {
  info: { id: "s", fileName: "bang.wav", channels: 1, sampleRate: 32000, durationMs: 100 },
  bytes: new Uint8Array(),
  audio: { sampleRate: 32000, channels: [new Float32Array(3200)] },
};

describe("GunReplace", () => {
  it("lists each version and leaves shared files out unless ticked", () => {
    const onReplace = vi.fn<(plan: ReplacePlan) => void>();
    render(
      <GunReplace
        gun="Pistol"
        source={source}
        sections={sections}
        playing={null}
        onClose={() => {}}
        onReplace={onReplace}
      />,
    );
    expect(screen.getByText("Gunshot")).toBeTruthy();
    expect(screen.getByText("Distant report")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace 2 files" }));
    expect(onReplace.mock.calls[0][0].groups.flatMap((g) => g.refs.map((r) => r.streamId))).toEqual(
      [1, 2],
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Replace 3 files" }));
    expect(onReplace.mock.calls[1][0].groups[0].refs.map((r) => r.streamId)).toEqual([1, 9]);
  });
});
