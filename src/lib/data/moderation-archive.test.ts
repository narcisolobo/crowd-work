import { describe, it, expect, afterEach } from "vitest";
import {
  approveCancellation,
  confirmRejection,
  getArchiveEntries,
  proposeRejection,
} from "./moderation";
import {
  createAdminClient,
  signInTestModerator,
} from "./moderation-test-helpers";

let insertedListingIds: string[] = [];
let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  if (insertedListingIds.length > 0) {
    await admin.from("listings").delete().in("id", insertedListingIds);
  }
  insertedListingIds = [];
  insertedEntryIds = [];
});

async function createPendingCancellation(listingId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("moderation_queue")
    .insert({
      change_type: "cancellation",
      listing_id: listingId,
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: "archive test entry",
      origin: "seed",
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedEntryIds.push(data.id);
  return data.id as string;
}

describe("getArchiveEntries", () => {
  it("returns only approved/rejected entries, most recently decided first, excluding pending/rejection_proposed", async () => {
    const admin = createAdminClient();
    const { data: listing, error: createError } = await admin
      .from("listings")
      .insert({
        type: "mic",
        title: "Temp Listing For Archive Test",
        venue_id: "c0000000-0000-0000-0000-000000000001",
        start_time: "19:00",
        one_off_date: "2026-09-15",
        status: "published",
      })
      .select("id")
      .single();
    if (createError) throw createError;
    insertedListingIds.push(listing.id);

    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);

    const approvedEntryId = await createPendingCancellation(listing.id);
    await approveCancellation(
      moderator1,
      approvedEntryId,
      listing.id,
      "2026-09-15",
      "archive test entry",
      "Accurate as submitted",
    );

    const rejectedEntryId = await createPendingCancellation(listing.id);
    await proposeRejection(moderator1, rejectedEntryId, "Duplicate report");
    await confirmRejection(moderator2, rejectedEntryId);

    const pendingEntryId = await createPendingCancellation(listing.id);

    const entries = await getArchiveEntries(moderator1);
    const entryIds = entries.map((entry) => entry.id);

    expect(entryIds).toContain(approvedEntryId);
    expect(entryIds).toContain(rejectedEntryId);
    expect(entryIds).not.toContain(pendingEntryId);

    const rejectedIndex = entryIds.indexOf(rejectedEntryId);
    const approvedIndex = entryIds.indexOf(approvedEntryId);
    // rejected was decided after approved in this test, so it sorts first.
    expect(rejectedIndex).toBeLessThan(approvedIndex);
  });
});
