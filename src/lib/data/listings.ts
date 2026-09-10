import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase/supabase";
import type { Database } from "../supabase/database.types";
import {
  type Listing as RecurrenceListing,
  type OccurrenceException,
} from "../utils/recurrence";

export interface Area {
  id: string;
  name: string;
}

export interface ListingWithVenue {
  id: string;
  type: "mic" | "show";
  title: string;
  host: string | null;
  description: string | null;
  startTime: string;
  signUpOpensAt: string | null;
  signUpMethod:
    | "bucket_lotto"
    | "first_come"
    | "curated"
    | "slotted_online"
    | "hybrid_other"
    | null;
  signUpUrl: string | null;
  signUpOtherNote: string | null;
  costToPerform: string | null;
  ticketPrice: string | null;
  ticketUrl: string | null;
  venue: {
    id: string;
    name: string;
    address: string;
    googleMapsUrl: string | null;
    neighborhoodId: string;
    areaIds: string[];
  };
  recurrenceRule: {
    frequency: "weekly" | "monthly";
    dayOfWeek: number;
    weekOfMonth: number | null;
    intervalWeeks: number;
    anchorDate: string | null;
  } | null;
  oneOffDate: string | null;
}
export interface Neighborhood {
  id: string;
  name: string;
  areaIds: string[];
}

export async function getNeighborhoods(): Promise<Neighborhood[]> {
  const { data, error } = await supabase
    .from("neighborhoods")
    .select("id, name, neighborhood_areas ( area_id )")
    .order("name");
  if (error) throw new Error(`Failed to load neighborhoods: ${error.message}`);
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    areaIds: (row.neighborhood_areas ?? []).map(
      (na: { area_id: string }) => na.area_id,
    ),
  }));
}

export async function getAreas(): Promise<Area[]> {
  const { data, error } = await supabase
    .from("areas")
    .select("id, name")
    .order("name");
  if (error) throw new Error(`Failed to load areas: ${error.message}`);
  return data ?? [];
}

const LISTING_WITH_VENUE_SELECT = `
  id, type, title, host, description, start_time, one_off_date,
  sign_up_method, sign_up_url, sign_up_other_note, sign_up_opens_at,
  cost_to_perform, ticket_price, ticket_url,
  venue:venues (
    id, name, address, google_maps_url,
    neighborhood:neighborhoods ( id, neighborhood_areas ( area_id ) )
  ),
  recurrence_rules ( frequency, day_of_week, week_of_month, interval_weeks, anchor_date )
`;

function mapListingRow(row: any): ListingWithVenue {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    host: row.host,
    description: row.description,
    startTime: row.start_time,
    signUpMethod: row.sign_up_method,
    signUpUrl: row.sign_up_url,
    signUpOtherNote: row.sign_up_other_note,
    signUpOpensAt: row.sign_up_opens_at,
    costToPerform: row.cost_to_perform,
    ticketPrice: row.ticket_price,
    ticketUrl: row.ticket_url,
    venue: {
      id: row.venue.id,
      name: row.venue.name,
      address: row.venue.address,
      googleMapsUrl: row.venue.google_maps_url,
      neighborhoodId: row.venue.neighborhood.id,
      areaIds: (row.venue.neighborhood.neighborhood_areas ?? []).map(
        (na: { area_id: string }) => na.area_id,
      ),
    },
    recurrenceRule: row.recurrence_rules
      ? {
          frequency: row.recurrence_rules.frequency,
          dayOfWeek: row.recurrence_rules.day_of_week,
          weekOfMonth: row.recurrence_rules.week_of_month,
          intervalWeeks: row.recurrence_rules.interval_weeks,
          anchorDate: row.recurrence_rules.anchor_date,
        }
      : null,
    oneOffDate: row.one_off_date,
  };
}

export async function getPublishedListings(): Promise<ListingWithVenue[]> {
  const { data, error } = await supabase
    .from("listings")
    .select(LISTING_WITH_VENUE_SELECT)
    .eq("status", "published");

  if (error) throw new Error(`Failed to load listings: ${error.message}`);

  return (data ?? []).map(mapListingRow);
}

export async function getListingById(
  id: string,
): Promise<ListingWithVenue | null> {
  const { data, error } = await supabase
    .from("listings")
    .select(LISTING_WITH_VENUE_SELECT)
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();

  if (error) {
    // Postgres' invalid_text_representation — id isn't even a well-formed
    // UUID (e.g. a stray/typo'd URL). Same "not found" outcome as a real
    // miss, not a server error.
    if (error.code === "22P02") return null;
    throw new Error(`Failed to load listing ${id}: ${error.message}`);
  }
  if (!data) return null;

  return mapListingRow(data);
}

export async function getListingTitles(
  client: SupabaseClient<Database>,
  ids: string[],
): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await client
    .from("listings")
    .select("id, title")
    .in("id", uniqueIds);

  if (error) throw new Error(`Failed to load listing titles: ${error.message}`);

  return Object.fromEntries((data ?? []).map((row) => [row.id, row.title]));
}

export async function getListingStatuses(
  client: SupabaseClient<Database>,
  ids: string[],
): Promise<Record<string, "published" | "archived">> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await client
    .from("listings")
    .select("id, status")
    .in("id", uniqueIds);

  if (error)
    throw new Error(`Failed to load listing statuses: ${error.message}`);

  return Object.fromEntries((data ?? []).map((row) => [row.id, row.status]));
}

export async function getExceptionsForListings(
  listingIds: string[],
): Promise<Map<string, OccurrenceException[]>> {
  if (listingIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("occurrence_exceptions")
    .select(
      "listing_id, original_date, type, new_date, new_start_time, new_venue_id, note",
    )
    .in("listing_id", listingIds);

  if (error)
    throw new Error(`Failed to load occurrence exceptions: ${error.message}`);

  const map = new Map<string, OccurrenceException[]>();
  for (const row of data ?? []) {
    const list = map.get(row.listing_id) ?? [];
    list.push({
      originalDate: row.original_date,
      type: row.type,
      newDate: row.new_date ?? undefined,
      newStartTime: row.new_start_time ?? undefined,
      newVenueId: row.new_venue_id ?? undefined,
      note: row.note ?? undefined,
    });
    map.set(row.listing_id, list);
  }
  return map;
}

export function toRecurrenceListing(
  listing: ListingWithVenue,
): RecurrenceListing {
  if (listing.recurrenceRule) {
    return {
      id: listing.id,
      venueId: listing.venue.id,
      startTime: listing.startTime,
      recurrenceRule: {
        frequency: listing.recurrenceRule.frequency,
        dayOfWeek: listing.recurrenceRule.dayOfWeek,
        weekOfMonth: listing.recurrenceRule.weekOfMonth ?? undefined,
        intervalWeeks: listing.recurrenceRule.intervalWeeks,
        anchorDate: listing.recurrenceRule.anchorDate ?? undefined,
      },
    };
  }
  return {
    id: listing.id,
    venueId: listing.venue.id,
    startTime: listing.startTime,
    oneOffDate: listing.oneOffDate!,
  };
}

export interface Venue {
  id: string;
  name: string;
}

export async function getVenues(): Promise<Venue[]> {
  const { data, error } = await supabase
    .from("venues")
    .select("id, name")
    .order("name");
  if (error) throw new Error(`Failed to load venues: ${error.message}`);
  return data ?? [];
}
