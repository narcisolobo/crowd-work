import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

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
  createdAt: string;
}

export const QUEUE_ENTRY_SELECT =
  "id, listing_id, change_type, proposed_data, correction_note, origin, status, proposed_by, proposed_reason, confirmed_by, created_at";

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
