// Deliberately no import from "../data/moderation" here, even type-only:
// `supabase functions serve` resolves type-only imports too (unlike
// Vitest/esbuild, which strip them before ever resolving), and moderation.ts
// has a real transitive dependency on ../supabase/supabase.ts, which reads
// import.meta.env — a Vite-only mechanism Deno's edge runtime doesn't have.
// This local QueueChangeType is structurally identical to the one in
// moderation.ts, so every real QueueEntry still satisfies it.
type QueueChangeType =
  | "new"
  | "update"
  | "cancellation"
  | "modification"
  | "archive"
  | "restore";

export const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New",
  update: "Update",
  cancellation: "Cancellation",
  modification: "Modification",
  archive: "Archive",
  restore: "Restore",
};

export const ORIGIN_LABEL: Record<string, string> = {
  seed: "Seed data",
  report_form: "Public report",
  submission_form: "Public submission",
  moderator_direct_add: "Direct add",
  source_check: "Automated source check",
  moderator_archive: "Archived by moderator",
  system_recovery: "Automatic (recovery)",
  moderator_direct_edit: "Direct edit",
  moderator_restore: "Restored by moderator",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  rejection_proposed: "Rejection proposed",
  approved: "Approved",
  rejected: "Rejected",
};

export const TYPE_OPTIONS = [
  { value: "mic", label: "Mic" },
  { value: "show", label: "Show" },
];

export const FREQUENCY_OPTIONS = [
  { value: "", label: "One-time" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

export const DAY_OF_WEEK_OPTIONS = [
  { value: "", label: "Choose a day" },
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

export const WEEK_OF_MONTH_OPTIONS = [
  { value: "", label: "Every week" },
  { value: "1", label: "1st" },
  { value: "2", label: "2nd" },
  { value: "3", label: "3rd" },
  { value: "4", label: "4th" },
  { value: "-1", label: "Last" },
];

export const APPROVAL_REASON_OPTIONS = [
  { value: "", label: "Choose a reason" },
  { value: "Accurate as submitted", label: "Accurate as submitted" },
  { value: "Accurate after minor edits", label: "Accurate after minor edits" },
  { value: "Verified independently", label: "Verified independently" },
  { value: "other", label: "Other…" },
];

export const APPROVAL_REASON_HINT =
  '"Minor edits" covers small fixes to what was submitted. "Verified independently" means you confirmed it yourself against another source, like the venue\'s own site.';

// For direct-add and direct-edit: the moderator IS the source, not a
// reviewer of someone else's submission, so "accurate as submitted" and
// "verified independently" (both phrased around judging external input)
// don't parse. These name why the moderator believes the listing is
// accurate, which still feeds the same approval_note audit trail.
export const DIRECT_ENTRY_REASON_OPTIONS = [
  { value: "", label: "Choose a reason" },
  { value: "Personal knowledge", label: "Personal knowledge" },
  { value: "Confirmed with venue", label: "Confirmed with venue" },
  { value: "other", label: "Other…" },
];

export const DIRECT_ENTRY_REASON_HINT =
  '"Personal knowledge" means you know this firsthand — you run, host, or regularly attend it. "Confirmed with venue" means you checked it against the venue\'s own site or social.';

// For archiving a published listing: this isn't approving content, it's
// removing it, so "accurate as submitted"/"verified independently" (both
// about judging whether data was right) don't apply — the question here is
// why the listing no longer belongs on the public site.
export const ARCHIVE_REASON_OPTIONS = [
  { value: "", label: "Choose a reason" },
  { value: "Permanently closed", label: "Permanently closed" },
  { value: "Duplicate listing", label: "Duplicate listing" },
  { value: "Requested by venue or host", label: "Requested by venue or host" },
  {
    value: "Should not have been published",
    label: "Should not have been published",
  },
  { value: "other", label: "Other…" },
];

export const ARCHIVE_REASON_HINT =
  '"Permanently closed" covers a mic or show that no longer runs. "Should not have been published" covers a listing that was wrong from the start — bad data, not something that\'s simply gone out of date.';

// For restoring an archived listing back to the public site: the mirror of
// ARCHIVE_REASON_OPTIONS, phrased around why the earlier archive no longer
// holds rather than why the listing was accurate — restoring isn't a fresh
// approval of the listing's content.
export const RESTORE_REASON_OPTIONS = [
  { value: "", label: "Choose a reason" },
  { value: "Archived in error", label: "Archived in error" },
  { value: "Venue or host resumed", label: "Venue or host resumed" },
  { value: "other", label: "Other…" },
];

export const RESTORE_REASON_HINT =
  '"Archived in error" covers a listing that should never have been removed. "Venue or host resumed" covers a mic or show that stopped and has since started running again.';

const PREVIEW_LENGTH = 90;

export function truncate(text: string, length = PREVIEW_LENGTH): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export interface PreviewableQueueEntry {
  correctionNote: string | null;
  // Loosened to the two fields real proposedData shapes actually carry,
  // rather than importing the full ProposedListingFields |
  // ProposedCancellation | ProposedModification union. previewFor only
  // ever reads `title`; `originalDate` is included purely so every real
  // shape shares at least one property with this type — TS's "weak type"
  // check (all-optional-properties) otherwise rejects assigning a
  // ProposedCancellation/ProposedModification value here, since neither
  // has a `title` field at all.
  proposedData: { title?: string | null; originalDate?: string | null } | null;
  changeType: QueueChangeType;
}

export function previewFor(
  entry: PreviewableQueueEntry,
  listingTitle?: string | null,
): string {
  if (entry.changeType === "archive") {
    return listingTitle ? `Archived: ${listingTitle}` : "Archived listing";
  }
  if (entry.changeType === "restore") {
    return listingTitle ? `Restored: ${listingTitle}` : "Restored listing";
  }
  if (entry.correctionNote) {
    return truncate(entry.correctionNote);
  }
  if (entry.proposedData?.title) {
    return entry.changeType === "new"
      ? `New listing: ${entry.proposedData.title}`
      : `Update: ${entry.proposedData.title}`;
  }
  return entry.changeType === "modification" ? "Modification" : "Cancellation";
}
