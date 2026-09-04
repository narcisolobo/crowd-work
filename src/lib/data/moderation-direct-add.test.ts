import { describe, it, expect, afterEach } from "vitest";
import { directAddListing } from "./moderation";
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

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("directAddListing", () => {
  it("creates a listing and a self-approved queue entry in one step", async () => {
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    const formData = buildFormData({
      type: "mic",
      title: "Direct-Added Mic",
      venueId: EXISTING_VENUE_ID,
      startTime: "19:00",
      reason: "Verified independently",
    });

    await directAddListing(moderator1, formData);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("id")
      .eq("title", "Direct-Added Mic")
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);

    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "id, change_type, origin, status, listing_id, approved_by, approval_note, decided_at",
      )
      .eq("listing_id", listing!.id)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("new");
    expect(entry!.origin).toBe("moderator_direct_add");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approval_note).toBe("Verified independently");
    expect(entry!.decided_at).not.toBeNull();
  });
});

describe("moderator_direct_add RLS", () => {
  it("rejects an authenticated insert that isn't already approved", async () => {
    const moderator1 = await signInTestModerator(1);
    const { error } = await moderator1.from("moderation_queue").insert({
      change_type: "new",
      origin: "moderator_direct_add",
      status: "pending",
      proposed_data: { title: "Sneaking in as pending" },
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
      change_type: "new",
      origin: "moderator_direct_add",
      status: "approved",
      approved_by: moderator2User!.id,
      decided_at: new Date().toISOString(),
      approved_data: { title: "Forged approver" },
    });
    expect(error).not.toBeNull();
  });
});
