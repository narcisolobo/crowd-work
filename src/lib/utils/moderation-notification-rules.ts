import type { QueueChangeType, QueueStatus } from "../data/moderation";

export const URGENT_WINDOW_DAYS = 3;

interface UrgencyInput {
  status: QueueStatus;
  changeType: QueueChangeType;
  proposedData: { originalDate?: string | null } | null;
  notifiedAt: string | null;
}

interface DigestInput {
  status: QueueStatus;
  notifiedAt: string | null;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function daysUntil(dateStr: string, now: Date): number {
  const target = startOfUtcDay(new Date(`${dateStr}T00:00:00Z`));
  const today = startOfUtcDay(now);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function isUrgent(entry: UrgencyInput, now: Date): boolean {
  if (entry.status !== "pending") return false;
  if (
    entry.changeType !== "cancellation" &&
    entry.changeType !== "modification"
  ) {
    return false;
  }
  if (entry.notifiedAt !== null) return false;
  const originalDate = entry.proposedData?.originalDate;
  if (!originalDate) return false;
  return daysUntil(originalDate, now) <= URGENT_WINDOW_DAYS;
}

export function isDigestEligible(entry: DigestInput, now: Date): boolean {
  if (entry.status !== "pending") return false;
  if (entry.notifiedAt === null) return true;
  return (
    startOfUtcDay(new Date(entry.notifiedAt)).getTime() <
    startOfUtcDay(now).getTime()
  );
}
