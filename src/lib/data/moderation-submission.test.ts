import { describe, it, expect, afterEach } from "vitest";
import { submitNewListingProposal } from "./moderation";
import { createAdminClient, createAnonClient } from "./moderation-test-helpers";

const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";
const EXISTING_NEIGHBORHOOD_ID = "b0000000-0000-0000-0000-000000000002";

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("submitNewListingProposal", () => {
  it("inserts a pending 'new' entry with an existing venue", async () => {
    const anon = createAnonClient();
    const formData = buildFormData({
      type: "mic",
      title: "Anon-Submitted Mic",
      venueId: EXISTING_VENUE_ID,
      startTime: "20:00",
    });

    await submitNewListingProposal(anon, formData);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, origin, status, listing_id, proposed_data")
      .eq("origin", "submission_form")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("new");
    expect(entry!.status).toBe("pending");
    expect(entry!.listing_id).toBeNull();
    expect((entry!.proposed_data as { title: string }).title).toBe(
      "Anon-Submitted Mic",
    );
  });

  it("accepts a proposed new venue instead of an existing one", async () => {
    const anon = createAnonClient();
    const formData = buildFormData({
      type: "show",
      title: "Anon-Submitted Show",
      venueId: "__new__",
      newVenueName: "The Back Room",
      newVenueAddress: "123 Fake St, Los Angeles, CA",
      newVenueNeighborhoodId: EXISTING_NEIGHBORHOOD_ID,
      startTime: "21:00",
    });

    await submitNewListingProposal(anon, formData);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, proposed_data")
      .eq("origin", "submission_form")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    const proposedData = entry!.proposed_data as {
      venueId: string | null;
      newVenue: { name: string } | null;
    };
    expect(proposedData.venueId).toBeNull();
    expect(proposedData.newVenue?.name).toBe("The Back Room");
  });
});

describe("submission_form RLS", () => {
  it("rejects an anonymous insert that pre-fills a decided status", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      change_type: "new",
      origin: "submission_form",
      status: "approved",
      proposed_data: { title: "Forged" },
    });
    expect(error).not.toBeNull();
  });

  it("rejects a 'new' change_type submitted under the report_form origin", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      change_type: "new",
      origin: "report_form",
      status: "pending",
      proposed_data: { title: "Wrong origin" },
    });
    expect(error).not.toBeNull();
  });
});
