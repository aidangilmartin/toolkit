import { describe, expect, it } from "vitest";

import { formatBytes, plural, timeAgo } from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1536, "1.5 KB"],
    [188_000_000, "179 MB"],
    [5 * 1024 ** 3, "5.0 GB"],
  ])("%d → %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  it.each([
    [null, "never"],
    ["2026-10-03T11:59:40Z", "just now"],
    ["2026-10-03T11:55:00Z", "5 min ago"],
    ["2026-10-03T09:00:00Z", "3 h ago"],
    ["2026-10-02T10:00:00Z", "yesterday"],
    ["2026-09-29T12:00:00Z", "4 days ago"],
    ["not a date", "unknown"],
  ])("%s → %s", (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected);
  });
});

describe("plural", () => {
  it("handles one and many", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "file")).toBe("3 files");
  });
});
