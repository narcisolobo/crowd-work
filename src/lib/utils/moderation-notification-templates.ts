import {
  CHANGE_TYPE_LABEL,
  ORIGIN_LABEL,
  previewFor,
} from "./moderation-labels.ts";

// No import from "../data/moderation", even type-only — see the note in
// moderation-labels.ts. A single merged shape (rather than the real
// ProposedListingFields | ProposedCancellation | ProposedModification
// union) is enough here: every field this module reads is optional, and a
// real QueueEntry's proposedData is structurally assignable to it
// regardless of which union member it actually is.
type QueueChangeType =
  | "new"
  | "update"
  | "cancellation"
  | "modification"
  | "archive"
  | "restore";

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, system-ui';

interface TemplateEntry {
  id: string;
  changeType: QueueChangeType;
  origin: string;
  correctionNote: string | null;
  proposedData: { originalDate?: string | null; title?: string | null } | null;
  createdAt: string;
}

function originalDateOf(entry: TemplateEntry): string | null {
  return entry.proposedData?.originalDate ?? null;
}

function daysAway(dateStr: string, now: Date): number {
  const target = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function dateLabel(iso: string): string {
  return iso.slice(0, 10);
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function itemHtml(entry: TemplateEntry, secondLine: string): string {
  const headline = previewFor(entry);
  return `
    <li style="list-style:none;padding:12px 0;border-bottom:1px solid #ddd;">
      <span style="display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;border:1px solid #999;border-radius:2px;padding:1px 6px;margin-right:8px;">${CHANGE_TYPE_LABEL[entry.changeType]}</span>
      <a href="/admin/queue/${entry.id}" style="font-family:${FONT_STACK};font-size:15px;color:#111;text-decoration:underline;">${headline}</a>
      <div style="font-family:${FONT_STACK};font-size:13px;color:#666;margin-top:2px;">${secondLine}</div>
    </li>
  `;
}

function wrap(bodyHtml: string): string {
  return `<html><body style="font-family:${FONT_STACK};margin:0;padding:16px;">
    <ul style="margin:0;padding:0;">${bodyHtml}</ul>
  </body></html>`;
}

export function buildUrgentEmail(
  entries: TemplateEntry[],
  now: Date,
): { subject: string; html: string } {
  const items = entries
    .map((entry) => {
      const originalDate = originalDateOf(entry) ?? "";
      const secondLine = `${ORIGIN_LABEL[entry.origin] ?? entry.origin} · Occurs ${dateLabel(originalDate)} (in ${daysAway(originalDate, now)} days)`;
      return itemHtml(entry, secondLine);
    })
    .join("");

  return {
    subject: `Urgent: ${pluralize(entries.length, "moderation item")} need${entries.length === 1 ? "s" : ""} review`,
    html: wrap(items),
  };
}

export function buildDigestEmail(
  entries: TemplateEntry[],
  _now: Date,
): { subject: string; html: string } | null {
  if (entries.length === 0) return null;

  const grouped = new Map<QueueChangeType, TemplateEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.changeType) ?? [];
    group.push(entry);
    grouped.set(entry.changeType, group);
  }

  const items = [...grouped.values()]
    .flat()
    .map((entry) => {
      const secondLine = `${ORIGIN_LABEL[entry.origin] ?? entry.origin} · ${dateLabel(entry.createdAt)}`;
      return itemHtml(entry, secondLine);
    })
    .join("");

  return {
    subject: `Daily digest: ${pluralize(entries.length, "pending moderation item")}`,
    html: wrap(items),
  };
}
