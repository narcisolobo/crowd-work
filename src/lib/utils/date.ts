const LISTINGS_TIME_ZONE = 'America/Los_Angeles';

/**
 * Returns the current calendar date (YYYY-MM-DD) in the timezone Crowd Work's
 * listings are anchored to, not the server's timezone. A plain `new Date()`
 * formatted with `timeZone: 'UTC'` reads as tomorrow for roughly a third of
 * every day, since LA is 7-8 hours behind UTC.
 */
export function getTodayInLA(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LISTINGS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Adds `days` to a YYYY-MM-DD calendar date, treating it the same
 * UTC-midnight way recurrence.ts does, so results stay compatible with
 * the recurrence resolver's date range arguments.
 */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
