import type {
  ProposedListingFields,
  QueueChangeType,
  QueueEntry,
} from "../data/moderation";

export const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New",
  update: "Update",
  cancellation: "Cancellation",
};

export const ORIGIN_LABEL: Record<string, string> = {
  seed: "Seed data",
  report_form: "Public report",
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
  { value: "", label: "No reason provided" },
  { value: "Accurate as submitted", label: "Accurate as submitted" },
  { value: "Accurate after minor edits", label: "Accurate after minor edits" },
  { value: "Verified independently", label: "Verified independently" },
  { value: "other", label: "Other…" },
];

const PREVIEW_LENGTH = 90;

export function truncate(text: string, length = PREVIEW_LENGTH): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function previewFor(
  entry: Pick<QueueEntry, "correctionNote" | "proposedData" | "changeType">,
): string {
  if (entry.correctionNote) {
    return truncate(entry.correctionNote);
  }
  const data = entry.proposedData as ProposedListingFields | null;
  if (data?.title) {
    return entry.changeType === "new"
      ? `New listing: ${data.title}`
      : `Update: ${data.title}`;
  }
  return "Cancellation";
}
