import { supabase } from '../supabase/supabase';
import {
  type Listing as RecurrenceListing,
  type OccurrenceException,
} from '../utils/recurrence';

export interface Area {
  id: string;
  name: string;
}

export interface ListingWithVenue {
  id: string;
  type: 'mic' | 'show';
  title: string;
  host: string | null;
  description: string | null;
  startTime: string;
  signUpMethod: string | null;
  costToPerform: string | null;
  ticketPrice: string | null;
  ticketUrl: string | null;
  venue: {
    id: string;
    name: string;
    address: string;
    googleMapsUrl: string | null;
    neighborhoodId: string;
    areaId: string;
  };
  recurrenceRule: {
    frequency: 'weekly' | 'monthly';
    dayOfWeek: number;
    weekOfMonth: number | null;
  } | null;
  oneOffDate: string | null;
}

export async function getAreas(): Promise<Area[]> {
  const { data, error } = await supabase
    .from('areas')
    .select('id, name')
    .order('name');
  if (error) throw new Error(`Failed to load areas: ${error.message}`);
  return data ?? [];
}

export async function getPublishedListings(): Promise<ListingWithVenue[]> {
  const { data, error } = await supabase
    .from('listings')
    .select(
      `
      id, type, title, host, description, start_time, one_off_date,
      sign_up_method, cost_to_perform, ticket_price, ticket_url,
      venue:venues (
        id, name, address, google_maps_url,
        neighborhood:neighborhoods ( id, area_id )
      ),
      recurrence_rules ( frequency, day_of_week, week_of_month )
    `,
    )
    .eq('status', 'published');

  if (error) throw new Error(`Failed to load listings: ${error.message}`);

  return (data ?? []).map((row: any) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    host: row.host,
    description: row.description,
    startTime: row.start_time,
    signUpMethod: row.sign_up_method,
    costToPerform: row.cost_to_perform,
    ticketPrice: row.ticket_price,
    ticketUrl: row.ticket_url,
    venue: {
      id: row.venue.id,
      name: row.venue.name,
      address: row.venue.address,
      googleMapsUrl: row.venue.google_maps_url,
      neighborhoodId: row.venue.neighborhood.id,
      areaId: row.venue.neighborhood.area_id,
    },
    recurrenceRule: row.recurrence_rules
      ? {
          frequency: row.recurrence_rules.frequency,
          dayOfWeek: row.recurrence_rules.day_of_week,
          weekOfMonth: row.recurrence_rules.week_of_month,
        }
      : null,
    oneOffDate: row.one_off_date,
  }));
}

export async function getExceptionsForListings(
  listingIds: string[],
): Promise<Map<string, OccurrenceException[]>> {
  if (listingIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('occurrence_exceptions')
    .select(
      'listing_id, original_date, type, new_date, new_start_time, new_venue_id, note',
    )
    .in('listing_id', listingIds);

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
