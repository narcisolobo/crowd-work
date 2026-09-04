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
