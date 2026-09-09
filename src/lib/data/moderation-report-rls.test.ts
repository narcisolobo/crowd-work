import { describe, it, expect, afterEach } from "vitest";
import { createAdminClient, createAnonClient } from "./moderation-test-helpers";

const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

describe("report_form RLS", () => {
  it("accepts a 'modification' report with a date", async () => {
    const anon = createAnonClient();
    const correctionNote = "Moved to the back room this week";
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "modification",
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: correctionNote,
      origin: "report_form",
      status: "pending",
    });
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data } = await admin
      .from("moderation_queue")
      .select("id")
      .eq("correction_note", correctionNote)
      .single();
    if (data) insertedEntryIds.push(data.id);
  });

  it("rejects a 'modification' report with no date", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "modification",
      proposed_data: { originalDate: null },
      correction_note: "Moved to the back room this week",
      origin: "report_form",
      status: "pending",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a 'cancellation' report with no date", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "cancellation",
      proposed_data: { originalDate: null },
      correction_note: "Not happening anymore",
      origin: "report_form",
      status: "pending",
    });
    expect(error).not.toBeNull();
  });

  it("still accepts a 'cancellation' report with a date", async () => {
    const anon = createAnonClient();
    const correctionNote = "Not happening anymore";
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "cancellation",
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: correctionNote,
      origin: "report_form",
      status: "pending",
    });
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data } = await admin
      .from("moderation_queue")
      .select("id")
      .eq("correction_note", correctionNote)
      .single();
    if (data) insertedEntryIds.push(data.id);
  });

  it("still accepts an 'update' report with no proposed_data", async () => {
    const anon = createAnonClient();
    const correctionNote = "Wrong sign-up method listed";
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "update",
      proposed_data: null,
      correction_note: correctionNote,
      origin: "report_form",
      status: "pending",
    });
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data } = await admin
      .from("moderation_queue")
      .select("id")
      .eq("correction_note", correctionNote)
      .single();
    if (data) insertedEntryIds.push(data.id);
  });
});
