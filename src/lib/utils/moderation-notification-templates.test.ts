import { describe, it, expect } from "vitest";
import {
  buildUrgentEmail,
  buildDigestEmail,
} from "./moderation-notification-templates";
import type { ProposedListingFields } from "../data/moderation";

const NOW = new Date("2026-09-10T12:00:00Z");

const CANCELLATION_ENTRY = {
  id: "11111111-1111-1111-1111-111111111111",
  changeType: "cancellation" as const,
  origin: "report_form",
  correctionNote: "Venue closed early this week",
  proposedData: { originalDate: "2026-09-12" },
  createdAt: "2026-09-08T10:00:00Z",
};

const NEW_LISTING_ENTRY = {
  id: "22222222-2222-2222-2222-222222222222",
  changeType: "new" as const,
  origin: "source_check",
  correctionNote: "Detected via automated check",
  // Only `title` matters to previewFor's 'new'/'update' branch — the rest
  // of ProposedListingFields is irrelevant to this test, so it's cast
  // rather than fully populated.
  proposedData: { title: "Brand New Open Mic" } as ProposedListingFields,
  createdAt: "2026-09-09T08:00:00Z",
};

describe("buildUrgentEmail", () => {
  it("includes the change type badge, headline, origin, and days-away", () => {
    const { subject, html } = buildUrgentEmail([CANCELLATION_ENTRY], NOW);
    expect(subject).toBe("Urgent: 1 moderation item needs review");
    expect(html).toContain("Cancellation");
    expect(html).toContain("Venue closed early this week");
    expect(html).toContain("/admin/queue/11111111-1111-1111-1111-111111111111");
    expect(html).toContain("Public report");
    expect(html).toContain("Occurs 2026-09-12 (in 2 days)");
    expect(html).toContain("system-ui");
  });

  it("pluralizes the subject for multiple entries", () => {
    const { subject } = buildUrgentEmail(
      [CANCELLATION_ENTRY, CANCELLATION_ENTRY],
      NOW,
    );
    expect(subject).toBe("Urgent: 2 moderation items need review");
  });
});

describe("buildDigestEmail", () => {
  it("returns null for an empty list", () => {
    expect(buildDigestEmail([], NOW)).toBeNull();
  });

  it("groups by change type and uses the origin/created-date line", () => {
    const result = buildDigestEmail(
      [CANCELLATION_ENTRY, NEW_LISTING_ENTRY],
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.subject).toBe("Daily digest: 2 pending moderation items");
    expect(result!.html).toContain("Cancellation");
    expect(result!.html).toContain("New");
    // previewFor prefers correctionNote over proposedData.title when both
    // are present (matches the admin dashboard's own headline logic), so
    // this is what actually renders — not the title.
    expect(result!.html).toContain("Detected via automated check");
    expect(result!.html).toContain("Automated source check");
    expect(result!.html).toContain("2026-09-08");
  });
});
