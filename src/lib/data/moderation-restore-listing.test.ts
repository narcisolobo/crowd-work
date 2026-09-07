import { describe, it, expect, afterEach } from "vitest";
import { archiveListing, restoreListing } from "./moderation";
import {
  createAdminClient,
  signInTestModerator,
} from "./moderation-test-helpers";

const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";

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

async function createTempListing(title: string, status: "published" | "archived" = "archived") {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("listings")
    .insert({
      type: "mic",
      title,
      venue_id: EXISTING_VENUE_ID,
      start_time: "19:00",
      one_off_date: "2026-09-15",
      status,
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedListingIds.push(data.id);
  return data.id as string;
}

describe("restoreListing", () => {
  it("restores an archived listing to published and records an approved 'restore' queue entry", async () => {
    const listingId = await createTempListing(
      "Temp Listing For restoreListing Test",
    );
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    await restoreListing(moderator1, listingId, "Archived in error");

    const admin = createAdminClient();
    const { data: updatedListing } = await admin
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect(updatedListing?.status).toBe("published");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "id, change_type, origin, status, listing_id, approved_by, approved_data, approval_note, decided_at",
      )
      .eq("listing_id", listingId)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("restore");
    expect(entry!.origin).toBe("moderator_restore");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approved_data).toBeNull();
    expect(entry!.approval_note).toBe("Archived in error");
    expect(entry!.decided_at).not.toBeNull();
  });

  it("round-trips: a listing archived and then restored ends up published with both entries on record", async () => {
    const listingId = await createTempListing(
      "Temp Listing For Archive-Restore Round Trip",
      "published",
    );
    const moderator1 = await signInTestModerator(1);

    await archiveListing(moderator1, listingId, "Permanently closed");
    await restoreListing(moderator1, listingId, "Archived in error");

    const admin = createAdminClient();
    const { data: finalListing } = await admin
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect(finalListing?.status).toBe("published");

    const { data: entries } = await admin
      .from("moderation_queue")
      .select("id, change_type")
      .eq("listing_id", listingId)
      .order("decided_at", { ascending: true });
    expect(entries).not.toBeNull();
    for (const e of entries!) insertedEntryIds.push(e.id);
    expect(entries!.map((e) => e.change_type)).toEqual(["archive", "restore"]);
  });
});
