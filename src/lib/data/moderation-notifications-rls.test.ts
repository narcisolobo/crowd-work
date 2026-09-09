import { describe, it, expect } from "vitest";
import {
  createAdminClient,
  signInNotificationAgent,
} from "./moderation-test-helpers";

const EXISTING_PENDING_ENTRY_ID = "e0000000-0000-0000-0000-000000000001";
const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";
const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";
const EXISTING_NEIGHBORHOOD_ID = "b0000000-0000-0000-0000-000000000002";

describe("notification agent permitted update", () => {
  it("can set notified_at on a pending entry", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent
      .from("moderation_queue")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", EXISTING_PENDING_ENTRY_ID);
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("notified_at, status")
      .eq("id", EXISTING_PENDING_ENTRY_ID)
      .single();
    expect(entry!.notified_at).not.toBeNull();
    expect(entry!.status).toBe("pending");

    // Reset for other tests/runs.
    await admin
      .from("moderation_queue")
      .update({ notified_at: null })
      .eq("id", EXISTING_PENDING_ENTRY_ID);
  });
});

describe("notification agent lockdown", () => {
  it("cannot approve a pending entry through the same update", async () => {
    // A restrictive policy silently excludes the row from the update set
    // (like a WHERE filter) rather than throwing, so the assertion is
    // that the row is unchanged afterward, not that `error` is non-null.
    const agent = await signInNotificationAgent();
    const {
      data: { user },
    } = await agent.auth.getUser();

    await agent
      .from("moderation_queue")
      .update({
        status: "approved",
        approved_by: user!.id,
        decided_at: new Date().toISOString(),
        notified_at: new Date().toISOString(),
      })
      .eq("id", EXISTING_PENDING_ENTRY_ID);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("status, approved_by, decided_at")
      .eq("id", EXISTING_PENDING_ENTRY_ID)
      .single();
    expect(entry!.status).toBe("pending");
    expect(entry!.approved_by).toBeNull();
    expect(entry!.decided_at).toBeNull();
  });

  it("cannot insert into the moderation queue", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "pending",
      proposed_data: { title: "Sneaked in" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert a listing directly", async () => {
    const agent = await signInNotificationAgent();
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
    const agent = await signInNotificationAgent();
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

  it("cannot insert a recurrence rule", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("recurrence_rules").insert({
      listing_id: EXISTING_LISTING_ID,
      frequency: "weekly",
      day_of_week: 3,
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert an occurrence exception", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("occurrence_exceptions").insert({
      listing_id: EXISTING_LISTING_ID,
      original_date: "2026-10-01",
      type: "cancelled",
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert a venue", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("venues").insert({
      name: "Sneaked-In Venue",
      address: "1 Fake St, Los Angeles, CA",
      neighborhood_id: EXISTING_NEIGHBORHOOD_ID,
    });
    expect(error).not.toBeNull();
  });
});
