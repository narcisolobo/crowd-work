import { describe, it, expect, afterEach } from "vitest";
import { archiveListing, createListingFromFields } from "./moderation";
import type { ProposedListingFields } from "./moderation";
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

async function createTempListing(title: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("listings")
    .insert({
      type: "mic",
      title,
      venue_id: EXISTING_VENUE_ID,
      start_time: "19:00",
      one_off_date: "2026-09-15",
      status: "published",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedListingIds.push(data.id);
  return data.id as string;
}

describe("listings RLS: archived listings are visible to moderators", () => {
  it("lets a moderator archive a listing and read it back afterward", async () => {
    const listingId = await createTempListing(
      "Temp Listing For Archive RLS Test",
    );
    const moderator1 = await signInTestModerator(1);

    // The exact repro from notes/archive-status-rls-gap.md: before Task 1's
    // migration, this update was rejected with 42501 because Postgres
    // checks the resulting row against the table's SELECT policy, and the
    // only one that existed required status = 'published'.
    const { error: updateError } = await moderator1
      .from("listings")
      .update({ status: "archived" })
      .eq("id", listingId);
    expect(updateError).toBeNull();

    const { data: archived, error: selectError } = await moderator1
      .from("listings")
      .select("id, status")
      .eq("id", listingId)
      .single();
    expect(selectError).toBeNull();
    expect(archived?.status).toBe("archived");
  });
});

describe("archiveListing", () => {
  it("archives a listing and records an approved 'archive' queue entry", async () => {
    const listingId = await createTempListing(
      "Temp Listing For archiveListing Test",
    );
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    await archiveListing(moderator1, listingId, "Venue permanently closed");

    const admin = createAdminClient();
    const { data: updatedListing } = await admin
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect(updatedListing?.status).toBe("archived");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "id, change_type, origin, status, listing_id, approved_by, approved_data, approval_note, decided_at",
      )
      .eq("listing_id", listingId)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("archive");
    expect(entry!.origin).toBe("moderator_archive");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approved_data).toBeNull();
    expect(entry!.approval_note).toBe("Venue permanently closed");
    expect(entry!.decided_at).not.toBeNull();
  });
});

describe("createListingFromFields recovery fallback", () => {
  it("archives the listing and records a system_recovery queue entry when the recurrence insert fails", async () => {
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    const fields: ProposedListingFields = {
      type: "mic",
      title: "Recovery Fallback Test Listing",
      host: null,
      description: null,
      venueId: EXISTING_VENUE_ID,
      newVenue: null,
      startTime: "19:00",
      signUpOpensAt: null,
      signUpMethod: null,
      signUpUrl: null,
      signUpOtherNote: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      // day_of_week 9 violates recurrence_rules' `check (day_of_week
      // between 0 and 6)` constraint — a real, deterministic Postgres
      // failure, not a mock, so this exercises the actual insert path.
      recurrence: { frequency: "weekly", dayOfWeek: 9, weekOfMonth: null },
      oneOffDate: null,
    };

    await expect(createListingFromFields(moderator1, fields)).rejects.toThrow(
      "Failed to save the recurrence schedule, so the listing was archived",
    );

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("id, status")
      .eq("title", "Recovery Fallback Test Listing")
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);
    expect(listing!.status).toBe("archived");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, origin, status, approved_by, approval_note")
      .eq("listing_id", listing!.id)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("archive");
    expect(entry!.origin).toBe("system_recovery");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approval_note).toBe(
      "Recurrence schedule failed to save during creation",
    );
  });
});
