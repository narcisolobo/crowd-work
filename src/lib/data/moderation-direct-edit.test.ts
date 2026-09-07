import { describe, it, expect, afterEach } from "vitest";
import { directUpdateListing, MissingRequiredFieldsError } from "./moderation";
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
      start_time: "18:00",
      one_off_date: "2026-09-15",
      status: "published",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedListingIds.push(data.id);
  return data.id as string;
}

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("directUpdateListing", () => {
  it("updates the listing and records a self-approved 'update' queue entry", async () => {
    const listingId = await createTempListing(
      "Temp Listing For directUpdateListing Test",
    );
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    const formData = buildFormData({
      type: "mic",
      title: "Temp Listing For directUpdateListing Test",
      venueId: EXISTING_VENUE_ID,
      startTime: "20:30",
      reason: "Time corrected after a call with the venue",
    });

    await directUpdateListing(moderator1, listingId, formData);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("start_time")
      .eq("id", listingId)
      .single();
    expect(listing!.start_time).toBe("20:30:00");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "id, change_type, origin, status, listing_id, approved_by, proposed_data, approved_data, approval_note, decided_at",
      )
      .eq("listing_id", listingId)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("update");
    expect(entry!.origin).toBe("moderator_direct_edit");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.proposed_data).toBeNull();
    expect((entry!.approved_data as { startTime: string }).startTime).toBe(
      "20:30",
    );
    expect(entry!.approval_note).toBe(
      "Time corrected after a call with the venue",
    );
    expect(entry!.decided_at).not.toBeNull();
  });

  it("throws MissingRequiredFieldsError when a required field is missing", async () => {
    const listingId = await createTempListing(
      "Temp Listing For Missing Field Test",
    );
    const moderator1 = await signInTestModerator(1);

    const formData = buildFormData({
      type: "mic",
      title: "",
      venueId: EXISTING_VENUE_ID,
      startTime: "20:30",
      reason: "Fixing a typo",
    });

    await expect(
      directUpdateListing(moderator1, listingId, formData),
    ).rejects.toBeInstanceOf(MissingRequiredFieldsError);
  });
});

describe("moderator_direct_edit RLS", () => {
  it("rejects an authenticated insert that isn't already approved", async () => {
    const moderator1 = await signInTestModerator(1);
    const { error } = await moderator1.from("moderation_queue").insert({
      change_type: "update",
      origin: "moderator_direct_edit",
      status: "pending",
      approved_data: { title: "Sneaking in as pending" },
    });
    expect(error).not.toBeNull();
  });

  it("rejects attributing the approval to a different moderator", async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    const {
      data: { user: moderator2User },
    } = await moderator2.auth.getUser();

    const { error } = await moderator1.from("moderation_queue").insert({
      change_type: "update",
      origin: "moderator_direct_edit",
      status: "approved",
      approved_by: moderator2User!.id,
      decided_at: new Date().toISOString(),
      approved_data: { title: "Forged approver" },
    });
    expect(error).not.toBeNull();
  });
});
