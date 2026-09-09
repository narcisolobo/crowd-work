import { describe, it, expect } from "vitest";
import {
  isUrgent,
  isDigestEligible,
  URGENT_WINDOW_DAYS,
} from "./moderation-notification-rules";

const NOW = new Date("2026-09-10T12:00:00Z");

function dateOffset(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("isUrgent", () => {
  it("is true for a pending cancellation exactly 3 days out", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(URGENT_WINDOW_DAYS) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for a pending cancellation 4 days out", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(4) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is true for a pending modification within the window", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "modification",
          proposedData: { originalDate: dateOffset(1) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for an 'update' entry regardless of date", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "update",
          proposedData: { originalDate: dateOffset(0) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false once already notified", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(0) },
          notifiedAt: "2026-09-10T00:00:00Z",
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when not pending", () => {
    expect(
      isUrgent(
        {
          status: "approved",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(0) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when proposedData has no originalDate", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "cancellation",
          proposedData: null,
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("isDigestEligible", () => {
  it("is true for a pending entry never notified", () => {
    expect(isDigestEligible({ status: "pending", notifiedAt: null }, NOW)).toBe(
      true,
    );
  });

  it("is true for a pending entry notified yesterday", () => {
    expect(
      isDigestEligible(
        { status: "pending", notifiedAt: "2026-09-09T23:00:00Z" },
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for a pending entry already notified today", () => {
    expect(
      isDigestEligible(
        { status: "pending", notifiedAt: "2026-09-10T01:00:00Z" },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when not pending", () => {
    expect(
      isDigestEligible({ status: "approved", notifiedAt: null }, NOW),
    ).toBe(false);
  });
});
