import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "@/lib/relative-time";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("does not expose the previous UTC date after the local calendar crosses midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T20:30:00.000Z"));

    expect(
      formatRelativeTime("2026-07-16T12:30:00.000Z", "en", "just now"),
    ).toBe("8 hours ago");
  });

  it("uses localized just-now and day labels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:30.000Z"));

    expect(formatRelativeTime("2026-07-17T00:00:00.000Z", "en", "just now")).toBe(
      "just now",
    );
    expect(formatRelativeTime("2026-07-16T00:00:30.000Z", "en", "just now")).toBe(
      "yesterday",
    );
  });
});
