export interface RecurrenceRule {
  frequency: 'weekly' | 'monthly';
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday
  weekOfMonth?: number; // 1-4, or -1 for "last" — required when frequency is 'monthly'
}

export interface OccurrenceException {
  originalDate: string; // YYYY-MM-DD, the date being overridden
  type: 'cancelled' | 'modified';
  newDate?: string;
  newStartTime?: string;
  newVenueId?: string;
  note?: string;
}

export interface RecurringListing {
  id: string;
  venueId: string;
  startTime: string; // HH:MM
  recurrenceRule: RecurrenceRule;
  oneOffDate?: undefined;
}

export interface OneOffListing {
  id: string;
  venueId: string;
  startTime: string;
  recurrenceRule?: undefined;
  oneOffDate: string; // YYYY-MM-DD
}

export type Listing = RecurringListing | OneOffListing;

export interface Occurrence {
  listingId: string;
  date: string;
  startTime: string;
  venueId: string;
  note?: string;
}

export function resolveOccurrences(
  listing: Listing,
  exceptions: OccurrenceException[],
  rangeStart: string,
  rangeEnd: string,
): Occurrence[] {
  const baseDates = listing.recurrenceRule
    ? resolveRecurringDates(listing.recurrenceRule, rangeStart, rangeEnd)
    : listing.oneOffDate >= rangeStart && listing.oneOffDate <= rangeEnd
      ? [listing.oneOffDate]
      : [];

  const exceptionsByDate = new Map(exceptions.map((e) => [e.originalDate, e]));

  const occurrences: Occurrence[] = [];
  for (const date of baseDates) {
    const exception = exceptionsByDate.get(date);

    if (exception?.type === 'cancelled') {
      continue;
    }

    if (exception?.type === 'modified') {
      occurrences.push({
        listingId: listing.id,
        date: exception.newDate ?? date,
        startTime: exception.newStartTime ?? listing.startTime,
        venueId: exception.newVenueId ?? listing.venueId,
        note: exception.note,
      });
      continue;
    }

    occurrences.push({
      listingId: listing.id,
      date,
      startTime: listing.startTime,
      venueId: listing.venueId,
    });
  }

  return occurrences;
}

function resolveRecurringDates(
  rule: RecurrenceRule,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  if (rule.frequency === 'weekly') {
    return weeklyDatesInRange(rule.dayOfWeek, rangeStart, rangeEnd);
  }
  return monthlyDatesInRange(
    rule.dayOfWeek,
    rule.weekOfMonth!,
    rangeStart,
    rangeEnd,
  );
}

function weeklyDatesInRange(
  dayOfWeek: number,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  const dates: string[] = [];
  let current = toUTCDate(rangeStart);
  const end = toUTCDate(rangeEnd);
  while (current <= end) {
    if (current.getUTCDay() === dayOfWeek) {
      dates.push(toDateStr(current));
    }
    current = addDays(current, 1);
  }
  return dates;
}

function monthlyDatesInRange(
  dayOfWeek: number,
  weekOfMonth: number,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  const dates: string[] = [];
  const start = toUTCDate(rangeStart);
  const end = toUTCDate(rangeEnd);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();

  while (
    year < end.getUTCFullYear() ||
    (year === end.getUTCFullYear() && month <= end.getUTCMonth())
  ) {
    const occurrence = nthWeekdayOfMonth(year, month, dayOfWeek, weekOfMonth);
    const dateStr = toDateStr(occurrence);
    if (dateStr >= rangeStart && dateStr <= rangeEnd) {
      dates.push(dateStr);
    }
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }
  return dates;
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  dayOfWeek: number,
  nth: number,
): Date {
  if (nth === -1) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    const diff = (lastDay.getUTCDay() - dayOfWeek + 7) % 7;
    return addDays(lastDay, -diff);
  }
  const firstDay = new Date(Date.UTC(year, month, 1));
  const diff = (dayOfWeek - firstDay.getUTCDay() + 7) % 7;
  const firstOccurrence = addDays(firstDay, diff);
  return addDays(firstOccurrence, (nth - 1) * 7);
}

function toUTCDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
