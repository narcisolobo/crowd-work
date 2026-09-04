import type { SupabaseClient } from "@supabase/supabase-js";
import { getListingById } from "./listings";
import type { Database, Json } from "../supabase/database.types";

export type QueueStatus =
  "pending" | "rejection_proposed" | "approved" | "rejected";
export type QueueChangeType = "new" | "update" | "cancellation";

export interface ProposedVenue {
  name: string;
  address: string;
  neighborhoodId: string;
  googleMapsUrl: string | null;
}

export interface ProposedListingFields {
  type: "mic" | "show";
  title: string;
  host: string | null;
  description: string | null;
  venueId: string | null;
  newVenue: ProposedVenue | null;
  startTime: string;
  signUpMethod: string | null;
  costToPerform: string | null;
  ticketPrice: string | null;
  ticketUrl: string | null;
  recurrence: {
    frequency: "weekly" | "monthly";
    dayOfWeek: number;
    weekOfMonth: number | null;
  } | null;
  oneOffDate: string | null;
}

export interface ProposedCancellation {
  originalDate: string;
  note?: string | null;
}

export interface QueueEntry {
  id: string;
  listingId: string | null;
  changeType: QueueChangeType;
  proposedData: ProposedListingFields | ProposedCancellation | null;
  correctionNote: string | null;
  origin: string;
  status: QueueStatus;
  proposedBy: string | null;
  proposedReason: string | null;
  confirmedBy: string | null;
  approvedBy: string | null;
  approvedData: ProposedListingFields | ProposedCancellation | null;
  approvalNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export const QUEUE_ENTRY_SELECT =
  "id, listing_id, change_type, proposed_data, correction_note, origin, status, proposed_by, proposed_reason, confirmed_by, approved_by, approved_data, approval_note, decided_at, created_at";

export function mapQueueEntryRow(row: any): QueueEntry {
  return {
    id: row.id,
    listingId: row.listing_id,
    changeType: row.change_type,
    proposedData: row.proposed_data,
    correctionNote: row.correction_note,
    origin: row.origin,
    status: row.status,
    proposedBy: row.proposed_by,
    proposedReason: row.proposed_reason,
    confirmedBy: row.confirmed_by,
    approvedBy: row.approved_by,
    approvedData: row.approved_data,
    approvalNote: row.approval_note,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export async function getReviewableQueueEntries(
  client: SupabaseClient<Database>,
): Promise<QueueEntry[]> {
  const { data, error } = await client
    .from("moderation_queue")
    .select(QUEUE_ENTRY_SELECT)
    .in("status", ["pending", "rejection_proposed"])
    .order("created_at", { ascending: true });

  if (error)
    throw new Error(`Failed to load moderation queue: ${error.message}`);

  return (data ?? []).map(mapQueueEntryRow);
}

export async function getQueueEntryById(
  client: SupabaseClient<Database>,
  id: string,
): Promise<QueueEntry | null> {
  const { data, error } = await client
    .from("moderation_queue")
    .select(QUEUE_ENTRY_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`Failed to load queue entry ${id}: ${error.message}`);
  }
  if (!data) return null;

  return mapQueueEntryRow(data);
}

export async function proposeRejection(
  client: SupabaseClient<Database>,
  entryId: string,
  reason: string,
): Promise<QueueEntry> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await client
    .from("moderation_queue")
    .update({
      status: "rejection_proposed",
      proposed_by: user.id,
      proposed_reason: reason,
    })
    .eq("id", entryId)
    .eq("status", "pending")
    .select(QUEUE_ENTRY_SELECT)
    .maybeSingle();

  if (error) throw new Error(`Failed to propose rejection: ${error.message}`);
  if (!data)
    throw new Error(
      "Could not propose rejection — the entry is no longer pending.",
    );

  return mapQueueEntryRow(data);
}

export async function confirmRejection(
  client: SupabaseClient<Database>,
  entryId: string,
): Promise<QueueEntry> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await client
    .from("moderation_queue")
    .update({
      status: "rejected",
      confirmed_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq("id", entryId)
    .eq("status", "rejection_proposed")
    .select(QUEUE_ENTRY_SELECT)
    .maybeSingle();

  if (error) throw new Error(`Failed to confirm rejection: ${error.message}`);
  if (!data)
    throw new Error(
      "Rejection was not confirmed — the entry may not be in rejection_proposed, or you proposed this rejection yourself and cannot confirm it.",
    );

  return mapQueueEntryRow(data);
}

export async function sendBackToPending(
  client: SupabaseClient<Database>,
  entryId: string,
): Promise<QueueEntry> {
  const { data, error } = await client
    .from("moderation_queue")
    .update({ status: "pending", proposed_by: null, proposed_reason: null })
    .eq("id", entryId)
    .eq("status", "rejection_proposed")
    .select(QUEUE_ENTRY_SELECT)
    .maybeSingle();

  if (error)
    throw new Error(`Failed to return entry to pending: ${error.message}`);
  if (!data)
    throw new Error(
      "Could not return this entry to pending — it may not be in rejection_proposed, or you proposed this rejection yourself.",
    );

  return mapQueueEntryRow(data);
}

export async function submitNewListingProposal(
  client: SupabaseClient<Database>,
  formData: FormData,
): Promise<void> {
  const fields = parseProposedListingFields(formData);

  const { error } = await client.from("moderation_queue").insert({
    change_type: "new",
    listing_id: null,
    proposed_data: fields as unknown as Json,
    correction_note: null,
    origin: "submission_form",
    status: "pending",
  });

  if (error) throw new Error(`Failed to submit listing: ${error.message}`);
}

async function resolveVenueId(
  client: SupabaseClient<Database>,
  fields: Pick<ProposedListingFields, "venueId" | "newVenue">,
): Promise<string> {
  if (fields.newVenue) {
    const { data: venue, error } = await client
      .from("venues")
      .insert({
        name: fields.newVenue.name,
        address: fields.newVenue.address,
        neighborhood_id: fields.newVenue.neighborhoodId,
        google_maps_url: fields.newVenue.googleMapsUrl,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to create venue: ${error.message}`);
    return venue.id;
  }
  if (!fields.venueId)
    throw new Error("A venue is required to create or update a listing.");
  return fields.venueId;
}

export async function createListingFromFields(
  client: SupabaseClient<Database>,
  fields: ProposedListingFields,
): Promise<{ listingId: string; venueId: string }> {
  const venueId = await resolveVenueId(client, fields);

  const { data: listing, error: listingError } = await client
    .from("listings")
    .insert({
      type: fields.type,
      title: fields.title,
      host: fields.host,
      description: fields.description,
      venue_id: venueId,
      start_time: fields.startTime,
      one_off_date: fields.oneOffDate,
      sign_up_method: fields.signUpMethod,
      cost_to_perform: fields.costToPerform,
      ticket_price: fields.ticketPrice,
      ticket_url: fields.ticketUrl,
      status: "published",
    })
    .select("id")
    .single();

  if (listingError)
    throw new Error(`Failed to create listing: ${listingError.message}`);

  if (fields.recurrence) {
    const { error: recurrenceError } = await client
      .from("recurrence_rules")
      .insert({
        listing_id: listing.id,
        frequency: fields.recurrence.frequency,
        day_of_week: fields.recurrence.dayOfWeek,
        week_of_month: fields.recurrence.weekOfMonth,
      });
    if (recurrenceError)
      throw new Error(
        `Failed to create recurrence rule: ${recurrenceError.message}`,
      );
  }

  return { listingId: listing.id, venueId };
}

export async function approveNewListing(
  client: SupabaseClient<Database>,
  entryId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
  const { listingId, venueId } = await createListingFromFields(client, fields);
  const approvedData: ProposedListingFields = {
    ...fields,
    venueId,
    newVenue: null,
  };
  await markApproved(client, entryId, listingId, approvedData, approvalNote);
}

export async function approveListingUpdate(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
  const venueId = await resolveVenueId(client, fields);

  const { error: listingError } = await client
    .from("listings")
    .update({
      type: fields.type,
      title: fields.title,
      host: fields.host,
      description: fields.description,
      venue_id: venueId,
      start_time: fields.startTime,
      one_off_date: fields.oneOffDate,
      sign_up_method: fields.signUpMethod,
      cost_to_perform: fields.costToPerform,
      ticket_price: fields.ticketPrice,
      ticket_url: fields.ticketUrl,
    })
    .eq("id", listingId);

  if (listingError)
    throw new Error(`Failed to update listing: ${listingError.message}`);

  if (fields.recurrence) {
    const { error: recurrenceError } = await client
      .from("recurrence_rules")
      .upsert(
        {
          listing_id: listingId,
          frequency: fields.recurrence.frequency,
          day_of_week: fields.recurrence.dayOfWeek,
          week_of_month: fields.recurrence.weekOfMonth,
        },
        { onConflict: "listing_id" },
      );
    if (recurrenceError)
      throw new Error(
        `Failed to update recurrence rule: ${recurrenceError.message}`,
      );
  }

  const approvedData: ProposedListingFields = {
    ...fields,
    venueId,
    newVenue: null,
  };
  await markApproved(client, entryId, listingId, approvedData, approvalNote);
}

export async function approveCancellation(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  originalDate: string,
  note: string | null,
  approvalNote: string | null = null,
): Promise<void> {
  const { error: exceptionError } = await client
    .from("occurrence_exceptions")
    .insert({
      listing_id: listingId,
      original_date: originalDate,
      type: "cancelled",
      note,
    });

  if (exceptionError)
    throw new Error(`Failed to record cancellation: ${exceptionError.message}`);

  await markApproved(
    client,
    entryId,
    listingId,
    { originalDate, note },
    approvalNote,
  );
}

async function markApproved(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  approvedData: ProposedListingFields | ProposedCancellation,
  approvalNote: string | null,
): Promise<void> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await client
    .from("moderation_queue")
    .update({
      status: "approved",
      listing_id: listingId,
      approved_by: user.id,
      approved_data: approvedData as unknown as Json,
      approval_note: approvalNote,
      decided_at: new Date().toISOString(),
    })
    .eq("id", entryId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error)
    throw new Error(`Failed to mark queue entry approved: ${error.message}`);
  if (!data)
    throw new Error(
      "Could not mark this entry approved — it is no longer pending.",
    );
}

function parseVenueSelection(formData: FormData): {
  venueId: string | null;
  newVenue: ProposedVenue | null;
} {
  const venueId = formData.get("venueId")?.toString() ?? "";
  if (venueId !== "__new__") {
    return { venueId: venueId || null, newVenue: null };
  }
  return {
    venueId: null,
    newVenue: {
      name: formData.get("newVenueName")?.toString() ?? "",
      address: formData.get("newVenueAddress")?.toString() ?? "",
      neighborhoodId: formData.get("newVenueNeighborhoodId")?.toString() ?? "",
      googleMapsUrl: formData.get("newVenueGoogleMapsUrl")?.toString() || null,
    },
  };
}

export function parseProposedListingFields(
  formData: FormData,
): ProposedListingFields {
  const frequency = formData.get("frequency")?.toString();
  return {
    type: formData.get("type")?.toString() === "show" ? "show" : "mic",
    title: formData.get("title")?.toString() ?? "",
    host: formData.get("host")?.toString() || null,
    description: formData.get("description")?.toString() || null,
    ...parseVenueSelection(formData),
    startTime: formData.get("startTime")?.toString() ?? "",
    signUpMethod: formData.get("signUpMethod")?.toString() || null,
    costToPerform: formData.get("costToPerform")?.toString() || null,
    ticketPrice: formData.get("ticketPrice")?.toString() || null,
    ticketUrl: formData.get("ticketUrl")?.toString() || null,
    recurrence:
      frequency === "weekly" || frequency === "monthly"
        ? {
            frequency,
            dayOfWeek: Number(formData.get("dayOfWeek")),
            weekOfMonth: formData.get("weekOfMonth")
              ? Number(formData.get("weekOfMonth"))
              : null,
          }
        : null,
    oneOffDate: formData.get("oneOffDate")?.toString() || null,
  };
}

function parseApprovalNote(formData: FormData): string | null {
  const reason = formData.get("reason")?.toString() ?? "";
  const otherReason = formData.get("otherReason")?.toString().trim() || null;
  return reason === "other" ? otherReason : reason || null;
}

export type QueueActionResult =
  { type: "redirect" } | { type: "validation_error"; message: string };

/** Applies a moderator's form submission for a queue entry. Returns null if
 * the form's `action` doesn't match any known review action. */
export async function handleQueueReviewAction(
  client: SupabaseClient<Database>,
  entry: QueueEntry,
  formData: FormData,
): Promise<QueueActionResult | null> {
  const action = formData.get("action")?.toString();

  if (action === "approve") {
    const fields = parseProposedListingFields(formData);
    const approvalNote = parseApprovalNote(formData);

    if (entry.changeType === "new") {
      await approveNewListing(client, entry.id, fields, approvalNote);
    } else if (entry.changeType === "update") {
      await approveListingUpdate(
        client,
        entry.id,
        entry.listingId!,
        fields,
        approvalNote,
      );
    }
    return { type: "redirect" };
  }

  if (action === "approve_cancellation") {
    const originalDate = formData.get("originalDate")?.toString() ?? "";
    const note = formData.get("note")?.toString() || null;
    const approvalNote = parseApprovalNote(formData);
    await approveCancellation(
      client,
      entry.id,
      entry.listingId!,
      originalDate,
      note,
      approvalNote,
    );
    return { type: "redirect" };
  }

  if (action === "propose_reject") {
    const reason = formData.get("reason")?.toString();
    if (!reason) {
      return {
        type: "validation_error",
        message: "A reason is required to propose rejection.",
      };
    }
    await proposeRejection(client, entry.id, reason);
    return { type: "redirect" };
  }

  if (action === "confirm_reject") {
    await confirmRejection(client, entry.id);
    return { type: "redirect" };
  }

  if (action === "send_back") {
    await sendBackToPending(client, entry.id);
    return { type: "redirect" };
  }

  return null;
}

// Pre-fill the edit form from proposed_data when there is a structured
// proposal (new listings, and updates simulating a future sourcing-agent
// proposal). A report-form 'update' has no proposed_data — pre-fill from
// the listing's current values instead, since the moderator is translating
// free text into field edits, not reviewing a structured diff.
export async function getPrefillForEntry(
  entry: QueueEntry,
): Promise<ProposedListingFields | null> {
  if (entry.changeType === "new") {
    return entry.proposedData as ProposedListingFields;
  }

  if (entry.changeType !== "update") return null;

  if (entry.proposedData) {
    return entry.proposedData as ProposedListingFields;
  }

  const current = await getListingById(entry.listingId!);
  if (!current) return null;

  return {
    type: current.type,
    title: current.title,
    host: current.host,
    description: current.description,
    venueId: current.venue.id,
    newVenue: null,
    startTime: current.startTime,
    signUpMethod: current.signUpMethod,
    costToPerform: current.costToPerform,
    ticketPrice: current.ticketPrice,
    ticketUrl: current.ticketUrl,
    recurrence: current.recurrenceRule,
    oneOffDate: current.oneOffDate,
  };
}

export async function getArchiveEntries(
  client: SupabaseClient<Database>,
): Promise<QueueEntry[]> {
  const { data, error } = await client
    .from("moderation_queue")
    .select(QUEUE_ENTRY_SELECT)
    .in("status", ["approved", "rejected"])
    .order("decided_at", { ascending: false });

  if (error)
    throw new Error(`Failed to load moderation archive: ${error.message}`);

  return (data ?? []).map(mapQueueEntryRow);
}
