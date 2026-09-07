import { describe, it, expect, afterEach } from "vitest";
import { submitSourceCheckFinding } from "./moderation";
import {
  createAdminClient,
  signInSourceCheckAgent,
} from "./moderation-test-helpers";

const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";

const SAMPLE_FIELDS = {
  type: "mic" as const,
  title: "Tuesday Night Mic",
  host: "Jamie Rivera",
  description: null,
  venueId: "c0000000-0000-0000-0000-000000000001",
  newVenue: null,
  startTime: "20:00",
  signUpMethod: "sign-up list at the door, 7:30pm",
  costToPerform: "free",
  ticketPrice: null,
  ticketUrl: null,
  recurrence: { frequency: "weekly" as const, dayOfWeek: 2, weekOfMonth: null },
  oneOffDate: null,
};

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

describe("submitSourceCheckFinding", () => {
  it("inserts a pending 'new' finding with no listing_id", async () => {
    const agent = await signInSourceCheckAgent();

    await submitSourceCheckFinding(agent, {
      sourceId: "any-source-id",
      changeType: "new",
      listingId: null,
      fields: { ...SAMPLE_FIELDS, title: "Brand New Open Mic" },
      note: "Detected via automated check of The Fixture Room's website.",
    });

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, origin, status, listing_id, proposed_data")
      .eq("origin", "source_check")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("new");
    expect(entry!.status).toBe("pending");
    expect(entry!.listing_id).toBeNull();
    expect((entry!.proposed_data as { title: string }).title).toBe(
      "Brand New Open Mic",
    );
  });

  it("inserts a pending 'update' finding tied to an existing listing", async () => {
    const agent = await signInSourceCheckAgent();

    await submitSourceCheckFinding(agent, {
      sourceId: "any-source-id",
      changeType: "update",
      listingId: EXISTING_LISTING_ID,
      fields: { ...SAMPLE_FIELDS, startTime: "20:30" },
      note: "Start time now reads 8:30pm on the venue's site.",
    });

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, status, listing_id, correction_note")
      .eq("origin", "source_check")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("update");
    expect(entry!.status).toBe("pending");
    expect(entry!.listing_id).toBe(EXISTING_LISTING_ID);
    expect(entry!.correction_note).toBe(
      "Start time now reads 8:30pm on the venue's site.",
    );
  });
});

describe("source_check RLS shape", () => {
  it("rejects an insert that pre-fills a decided status", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "approved",
      proposed_data: { title: "Forged" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a 'new' finding that includes a listing_id", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "pending",
      listing_id: EXISTING_LISTING_ID,
      proposed_data: { title: "Shape mismatch" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("rejects an 'update' finding with no listing_id", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "update",
      origin: "source_check",
      status: "pending",
      listing_id: null,
      proposed_data: { title: "Shape mismatch" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("rejects an insert missing a correction_note", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "pending",
      proposed_data: { title: "No note" },
      correction_note: null,
    });
    expect(error).not.toBeNull();
  });
});

const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";
const EXISTING_NEIGHBORHOOD_ID = "b0000000-0000-0000-0000-000000000002";
// Seeded as status 'pending' in supabase/seed.sql.
const EXISTING_PENDING_ENTRY_ID = "e0000000-0000-0000-0000-000000000001";

describe("source-check agent lockdown", () => {
  it("cannot insert a listing directly", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("listings").insert({
      type: "mic",
      title: "Sneaked-In Listing",
      venue_id: EXISTING_VENUE_ID,
      start_time: "20:00",
      status: "published",
    });
    expect(error).not.toBeNull();
  });

  it("cannot update an existing listing", async () => {
    // An UPDATE blocked by a restrictive policy simply excludes the row
    // from the update set (like a WHERE filter) rather than throwing —
    // Postgres only raises an explicit error when a row passes USING but
    // then fails WITH CHECK. So the real assertion is that the row is
    // unchanged afterward, not that `error` is non-null.
    const agent = await signInSourceCheckAgent();
    await agent
      .from("listings")
      .update({ title: "Tampered Title" })
      .eq("id", EXISTING_LISTING_ID);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("title")
      .eq("id", EXISTING_LISTING_ID)
      .single();
    expect(listing!.title).toBe("Tuesday Night Mic");
  });

  it("cannot archive a listing", async () => {
    // Same reasoning as "cannot update an existing listing" above: a
    // restrictive policy silently excludes the row from the update rather
    // than throwing, so the assertion is that status is unchanged.
    const agent = await signInSourceCheckAgent();
    await agent
      .from("listings")
      .update({ status: "archived" })
      .eq("id", EXISTING_LISTING_ID);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("status")
      .eq("id", EXISTING_LISTING_ID)
      .single();
    expect(listing!.status).toBe("published");
  });

  it("cannot insert a recurrence rule", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("recurrence_rules").insert({
      listing_id: EXISTING_LISTING_ID,
      frequency: "weekly",
      day_of_week: 3,
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert an occurrence exception", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("occurrence_exceptions").insert({
      listing_id: EXISTING_LISTING_ID,
      original_date: "2026-10-01",
      type: "cancelled",
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert a venue", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("venues").insert({
      name: "Sneaked-In Venue",
      address: "1 Fake St, Los Angeles, CA",
      neighborhood_id: EXISTING_NEIGHBORHOOD_ID,
    });
    expect(error).not.toBeNull();
  });

  it("cannot self-approve a moderator_direct_add listing", async () => {
    const agent = await signInSourceCheckAgent();
    const {
      data: { user },
    } = await agent.auth.getUser();

    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "moderator_direct_add",
      status: "approved",
      approved_by: user!.id,
      decided_at: new Date().toISOString(),
      approved_data: { title: "Self-approved by the agent" },
    });
    expect(error).not.toBeNull();
  });

  it("cannot update any moderation_queue entry", async () => {
    // Same reasoning as the listings-update test above: assert the row is
    // unchanged, not that an error was thrown.
    const agent = await signInSourceCheckAgent();
    await agent
      .from("moderation_queue")
      .update({ status: "approved" })
      .eq("id", EXISTING_PENDING_ENTRY_ID);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("status")
      .eq("id", EXISTING_PENDING_ENTRY_ID)
      .single();
    expect(entry!.status).toBe("pending");
  });
});
