import { describe, it, expect, afterEach } from "vitest";
import {
  approveNewListing,
  approveListingUpdate,
  approveCancellation,
  type ProposedListingFields,
} from "./moderation";
import {
  createAdminClient,
  signInTestModerator,
} from "./moderation-test-helpers";
import type { Database } from "../supabase/database.types";

const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";

type ModerationQueueInsert =
  Database["public"]["Tables"]["moderation_queue"]["Insert"];

let insertedListingIds: string[] = [];
let insertedEntryIds: string[] = [];
let insertedVenueIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  if (insertedListingIds.length > 0) {
    await admin.from("listings").delete().in("id", insertedListingIds);
  }
  if (insertedVenueIds.length > 0) {
    await admin.from("venues").delete().in("id", insertedVenueIds);
  }
  insertedListingIds = [];
  insertedEntryIds = [];
  insertedVenueIds = [];
});

async function createPendingEntry(
  overrides: Omit<ModerationQueueInsert, "origin" | "status">,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("moderation_queue")
    .insert({ origin: "seed", status: "pending", ...overrides })
    .select("id")
    .single();
  if (error) throw error;
  insertedEntryIds.push(data.id);
  return data.id as string;
}

describe("approveNewListing", () => {
  it("inserts a listing and recurrence rule using the moderator-edited values, not the original proposal", async () => {
    const entryId = await createPendingEntry({
      change_type: "new",
      listing_id: null,
      proposed_data: {
        type: "mic",
        title: "Original Proposed Title",
        host: null,
        description: null,
        venueId: EXISTING_VENUE_ID,
        newVenue: null,
        startTime: "19:00",
        signUpMethod: null,
        costToPerform: null,
        ticketPrice: null,
        ticketUrl: null,
        recurrence: { frequency: "weekly", dayOfWeek: 1, weekOfMonth: null },
        oneOffDate: null,
      },
    });

    const moderator1 = await signInTestModerator(1);
    const edited: ProposedListingFields = {
      type: "mic",
      title: "Moderator-Corrected Title",
      host: "Corrected Host",
      description: null,
      venueId: EXISTING_VENUE_ID,
      newVenue: null,
      startTime: "19:30",
      signUpMethod: "text to sign up",
      costToPerform: "free",
      ticketPrice: null,
      ticketUrl: null,
      recurrence: { frequency: "weekly", dayOfWeek: 1, weekOfMonth: null },
      oneOffDate: null,
    };

    await approveNewListing(
      moderator1,
      entryId,
      edited,
      "Verified independently",
    );

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("id, title, host, start_time")
      .eq("title", "Moderator-Corrected Title")
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);
    expect(listing!.host).toBe("Corrected Host");
    expect(listing!.start_time).toBe("19:30:00");

    const { data: rule } = await admin
      .from("recurrence_rules")
      .select("day_of_week")
      .eq("listing_id", listing!.id)
      .single();
    expect(rule!.day_of_week).toBe(1);

    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "status, listing_id, approved_by, approved_data, approval_note, decided_at",
      )
      .eq("id", entryId)
      .single();
    expect(entry!.status).toBe("approved");
    expect(entry!.listing_id).toBe(listing!.id);
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approval_note).toBe("Verified independently");
    expect(entry!.decided_at).not.toBeNull();
    // approved_data is a snapshot of the moderator-edited values, not the
    // original proposal — matches `edited`, not `proposed_data` above.
    expect((entry!.approved_data as { title: string }).title).toBe(
      "Moderator-Corrected Title",
    );
  });

  it("creates a new venue when the proposal includes one, and records the resolved venue id in approved_data", async () => {
    const entryId = await createPendingEntry({
      change_type: "new",
      listing_id: null,
      proposed_data: {
        type: "mic",
        title: "Listing At A New Venue",
        host: null,
        description: null,
        venueId: null,
        newVenue: {
          name: "The Back Room",
          address: "123 Fake St, Los Angeles, CA",
          neighborhoodId: "b0000000-0000-0000-0000-000000000002",
          googleMapsUrl: null,
        },
        startTime: "20:00",
        signUpMethod: null,
        costToPerform: null,
        ticketPrice: null,
        ticketUrl: null,
        recurrence: null,
        oneOffDate: "2026-10-01",
      },
    });

    const moderator1 = await signInTestModerator(1);
    const fields: ProposedListingFields = {
      type: "mic",
      title: "Listing At A New Venue",
      host: null,
      description: null,
      venueId: null,
      newVenue: {
        name: "The Back Room",
        address: "123 Fake St, Los Angeles, CA",
        neighborhoodId: "b0000000-0000-0000-0000-000000000002",
        googleMapsUrl: null,
      },
      startTime: "20:00",
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      recurrence: null,
      oneOffDate: "2026-10-01",
    };

    await approveNewListing(
      moderator1,
      entryId,
      fields,
      "Accurate as submitted",
    );

    const admin = createAdminClient();
    const { data: venue } = await admin
      .from("venues")
      .select("id, name")
      .eq("name", "The Back Room")
      .single();
    expect(venue).not.toBeNull();
    insertedVenueIds.push(venue!.id);

    const { data: listing } = await admin
      .from("listings")
      .select("id, venue_id")
      .eq("title", "Listing At A New Venue")
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);
    expect(listing!.venue_id).toBe(venue!.id);

    const { data: entry } = await admin
      .from("moderation_queue")
      .select("approved_data")
      .eq("id", entryId)
      .single();
    const approvedData = entry!.approved_data as {
      venueId: string;
      newVenue: unknown;
    };
    expect(approvedData.venueId).toBe(venue!.id);
    expect(approvedData.newVenue).toBeNull();
  });
});

describe("approveListingUpdate", () => {
  it("updates the existing listing with the moderator-edited values", async () => {
    const admin = createAdminClient();
    const { data: original, error: createError } = await admin
      .from("listings")
      .insert({
        type: "mic",
        title: "Temp Listing For Update Test",
        venue_id: EXISTING_VENUE_ID,
        start_time: "18:00",
        status: "published",
      })
      .select("id")
      .single();
    if (createError) throw createError;
    insertedListingIds.push(original.id);

    const entryId = await createPendingEntry({
      change_type: "update",
      listing_id: original.id,
      proposed_data: null,
      correction_note: "Start time changed",
    });

    const moderator1 = await signInTestModerator(1);
    const edited: ProposedListingFields = {
      type: "mic",
      title: "Temp Listing For Update Test",
      host: null,
      description: null,
      venueId: EXISTING_VENUE_ID,
      newVenue: null,
      startTime: "20:30",
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      recurrence: null,
      oneOffDate: "2026-10-01",
    };

    await approveListingUpdate(
      moderator1,
      entryId,
      original.id,
      edited,
      "Accurate after minor edits",
    );

    const { data: updated } = await admin
      .from("listings")
      .select("start_time")
      .eq("id", original.id)
      .single();
    expect(updated!.start_time).toBe("20:30:00");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select("approved_data, approval_note")
      .eq("id", entryId)
      .single();
    expect(entry!.approval_note).toBe("Accurate after minor edits");
    expect((entry!.approved_data as { startTime: string }).startTime).toBe(
      "20:30",
    );
  });

  it("creates and switches to a new venue when the update proposes one", async () => {
    const admin = createAdminClient();
    const { data: original, error: createError } = await admin
      .from("listings")
      .insert({
        type: "mic",
        title: "Listing Moving Venues",
        venue_id: EXISTING_VENUE_ID,
        start_time: "18:00",
        status: "published",
      })
      .select("id")
      .single();
    if (createError) throw createError;
    insertedListingIds.push(original.id);

    const entryId = await createPendingEntry({
      change_type: "update",
      listing_id: original.id,
      proposed_data: null,
      correction_note: "Venue changed",
    });

    const moderator1 = await signInTestModerator(1);
    const edited: ProposedListingFields = {
      type: "mic",
      title: "Listing Moving Venues",
      host: null,
      description: null,
      venueId: null,
      newVenue: {
        name: "The New Spot",
        address: "456 Fake Ave, Los Angeles, CA",
        neighborhoodId: "b0000000-0000-0000-0000-000000000001",
        googleMapsUrl: null,
      },
      startTime: "18:00",
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      recurrence: null,
      oneOffDate: null,
    };

    await approveListingUpdate(moderator1, entryId, original.id, edited, null);

    const { data: venue } = await admin
      .from("venues")
      .select("id")
      .eq("name", "The New Spot")
      .single();
    expect(venue).not.toBeNull();
    insertedVenueIds.push(venue!.id);

    const { data: updated } = await admin
      .from("listings")
      .select("venue_id")
      .eq("id", original.id)
      .single();
    expect(updated!.venue_id).toBe(venue!.id);
  });
});

describe("approveCancellation", () => {
  it("records an occurrence exception", async () => {
    const admin = createAdminClient();
    const { data: listing, error: createError } = await admin
      .from("listings")
      .insert({
        type: "mic",
        title: "Temp Listing For Cancellation Test",
        venue_id: EXISTING_VENUE_ID,
        start_time: "19:00",
        one_off_date: "2026-09-15",
        status: "published",
      })
      .select("id")
      .single();
    if (createError) throw createError;
    insertedListingIds.push(listing.id);

    const entryId = await createPendingEntry({
      change_type: "cancellation",
      listing_id: listing.id,
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: "Venue closed that night",
    });

    const moderator1 = await signInTestModerator(1);
    await approveCancellation(
      moderator1,
      entryId,
      listing.id,
      "2026-09-15",
      "Venue closed that night",
      "Accurate as submitted",
    );

    const { data: exception } = await admin
      .from("occurrence_exceptions")
      .select("type, original_date")
      .eq("listing_id", listing.id)
      .eq("original_date", "2026-09-15")
      .single();
    expect(exception!.type).toBe("cancelled");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select("approved_data, approval_note")
      .eq("id", entryId)
      .single();
    expect(entry!.approval_note).toBe("Accurate as submitted");
    expect(entry!.approved_data).toEqual({
      originalDate: "2026-09-15",
      note: "Venue closed that night",
    });
  });
});

describe("approval RLS", () => {
  it("blocks a moderator from forging another moderator's id into approved_by", async () => {
    const entryId = await createPendingEntry({
      change_type: "cancellation",
      listing_id: "d0000000-0000-0000-0000-000000000001",
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: "test entry",
    });

    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    const {
      data: { user: moderator2User },
    } = await moderator2.auth.getUser();

    const { data, error } = await moderator1
      .from("moderation_queue")
      .update({
        status: "approved",
        approved_by: moderator2User!.id,
        decided_at: new Date().toISOString(),
      })
      .eq("id", entryId)
      .eq("status", "pending")
      .select("id");

    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});
