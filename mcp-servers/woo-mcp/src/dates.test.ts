import { describe, expect, it } from "vitest";
import { resolvePreset } from "./dates.js";

describe("resolvePreset", () => {
  it("resolves 'today' in the store's calendar, not UTC (Asia/Kolkata, UTC+5:30)", () => {
    // 2026-10-09 22:00 UTC is already 2026-10-10 03:30 in Kolkata.
    const range = resolvePreset("today", "Asia/Kolkata", new Date("2026-10-09T22:00:00Z"));
    expect(range.after).toBe("2026-10-09T18:30:00.000Z"); // 10 Oct 00:00 IST
    expect(range.before).toBe("2026-10-10T18:30:00.000Z");
    expect(range.label).toBe("2026-10-10 (Asia/Kolkata)");
  });

  it("resolves 'today' in UTC", () => {
    const range = resolvePreset("today", "UTC", new Date("2026-10-09T10:15:00Z"));
    expect(range).toMatchObject({ after: "2026-10-09T00:00:00.000Z", before: "2026-10-10T00:00:00.000Z" });
  });

  it("resolves yesterday and last_7_days relative to the store's today", () => {
    const now = new Date("2026-10-09T10:15:00Z");
    expect(resolvePreset("yesterday", "UTC", now)).toMatchObject({ after: "2026-10-08T00:00:00.000Z", before: "2026-10-09T00:00:00.000Z" });
    expect(resolvePreset("last_7_days", "UTC", now)).toMatchObject({ after: "2026-10-03T00:00:00.000Z", before: "2026-10-10T00:00:00.000Z" });
  });

  it("covers the whole month, including year rollover", () => {
    expect(resolvePreset("this_month", "UTC", new Date("2026-12-15T00:00:00Z"))).toMatchObject({
      after: "2026-12-01T00:00:00.000Z",
      before: "2027-01-01T00:00:00.000Z",
    });
  });

  it("handles a 23-hour DST day (America/New_York, spring forward 2026-03-08)", () => {
    const range = resolvePreset("today", "America/New_York", new Date("2026-03-08T17:00:00Z"));
    expect(range.after).toBe("2026-03-08T05:00:00.000Z"); // EST midnight
    expect(range.before).toBe("2026-03-09T04:00:00.000Z"); // EDT midnight
    const hours = (Date.parse(range.before) - Date.parse(range.after)) / 3_600_000;
    expect(hours).toBe(23);
  });
});
