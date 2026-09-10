import { describe, it, expect } from "vitest";
import { resolveOccurrences } from "./recurrence";

describe("resolveOccurrences", () => {
  it("generates weekly occurrences within the date range", () => {
    const listing = {
      id: "mic-1",
      venueId: "venue-1",
      startTime: "20:00",
      recurrenceRule: { frequency: "weekly" as const, dayOfWeek: 2 }, // Tuesday
    };
    const result = resolveOccurrences(listing, [], "2026-09-01", "2026-09-30");
    expect(result.map((o) => o.date)).toEqual([
      "2026-09-01",
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
      "2026-09-29",
    ]);
  });

  it('generates the correct date for "last Thursday of the month"', () => {
    const listing = {
      id: "mic-2",
      venueId: "venue-1",
      startTime: "19:30",
      recurrenceRule: {
        frequency: "monthly" as const,
        dayOfWeek: 4,
        weekOfMonth: -1,
      }, // Thursday
    };
    const result = resolveOccurrences(listing, [], "2026-09-01", "2026-09-30");
    expect(result.map((o) => o.date)).toEqual(["2026-09-24"]);
  });

  it("excludes a cancelled occurrence", () => {
    const listing = {
      id: "mic-1",
      venueId: "venue-1",
      startTime: "20:00",
      recurrenceRule: { frequency: "weekly" as const, dayOfWeek: 2 },
    };
    const exceptions = [
      { originalDate: "2026-09-08", type: "cancelled" as const },
    ];
    const result = resolveOccurrences(
      listing,
      exceptions,
      "2026-09-01",
      "2026-09-30",
    );
    expect(result.map((o) => o.date)).not.toContain("2026-09-08");
    expect(result).toHaveLength(4);
  });

  it("applies a modified occurrence (moved date and time)", () => {
    const listing = {
      id: "mic-3",
      venueId: "venue-1",
      startTime: "20:00",
      recurrenceRule: { frequency: "weekly" as const, dayOfWeek: 0 }, // Sunday
    };
    const exceptions = [
      {
        originalDate: "2026-09-06",
        type: "modified" as const,
        newDate: "2026-09-07",
        newStartTime: "19:00",
        note: "moved for Labor Day",
      },
    ];
    const result = resolveOccurrences(
      listing,
      exceptions,
      "2026-09-01",
      "2026-09-30",
    );
    const moved = result.find((o) => o.note === "moved for Labor Day");
    expect(moved).toEqual({
      listingId: "mic-3",
      date: "2026-09-07",
      startTime: "19:00",
      venueId: "venue-1",
      note: "moved for Labor Day",
    });
  });

  it("returns a one-off listing only on its specific date", () => {
    const listing = {
      id: "show-1",
      venueId: "venue-2",
      startTime: "21:00",
      oneOffDate: "2026-09-12",
    };
    const result = resolveOccurrences(listing, [], "2026-09-01", "2026-09-30");
    expect(result).toEqual([
      {
        listingId: "show-1",
        date: "2026-09-12",
        startTime: "21:00",
        venueId: "venue-2",
      },
    ]);
    const outOfRange = resolveOccurrences(
      listing,
      [],
      "2026-10-01",
      "2026-10-31",
    );
    expect(outOfRange).toEqual([]);
  });
  it("applies intervalWeeks to skip alternating weeks, anchored at anchorDate", () => {
    const listing = {
      id: "mic-4",
      venueId: "venue-1",
      startTime: "19:00",
      recurrenceRule: {
        frequency: "weekly" as const,
        dayOfWeek: 2, // Tuesday
        intervalWeeks: 2,
        anchorDate: "2026-09-01",
      },
    };
    const result = resolveOccurrences(listing, [], "2026-09-01", "2026-09-30");
    expect(result.map((o) => o.date)).toEqual([
      "2026-09-01",
      "2026-09-15",
      "2026-09-29",
    ]);
  });

  it("computes week parity correctly when the anchor is outside the query range", () => {
    const listing = {
      id: "mic-5",
      venueId: "venue-1",
      startTime: "19:00",
      recurrenceRule: {
        frequency: "weekly" as const,
        dayOfWeek: 2, // Tuesday
        intervalWeeks: 2,
        anchorDate: "2026-08-18", // two weeks before the query range starts
      },
    };
    const result = resolveOccurrences(listing, [], "2026-09-01", "2026-09-30");
    expect(result.map((o) => o.date)).toEqual([
      "2026-09-01",
      "2026-09-15",
      "2026-09-29",
    ]);
  });
});
