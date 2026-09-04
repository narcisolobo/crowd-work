import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../supabase/database.types";

export type QueueStatus =
  "pending" | "rejection_proposed" | "approved" | "rejected";
export type QueueChangeType = "new" | "update" | "cancellation";

export interface ProposedListingFields {
  type: "mic" | "show";
  title: string;
  host: string | null;
  description: string | null;
  venueId: string;
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

export async function approveNewListing(
  client: SupabaseClient<Database>,
  entryId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
  const { data: listing, error: listingError } = await client
    .from("listings")
    .insert({
      type: fields.type,
      title: fields.title,
      host: fields.host,
      description: fields.description,
      venue_id: fields.venueId,
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

  await markApproved(client, entryId, listing.id, fields, approvalNote);
}

export async function approveListingUpdate(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
  const { error: listingError } = await client
    .from("listings")
    .update({
      type: fields.type,
      title: fields.title,
      host: fields.host,
      description: fields.description,
      venue_id: fields.venueId,
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

  await markApproved(client, entryId, listingId, fields, approvalNote);
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
