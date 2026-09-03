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
