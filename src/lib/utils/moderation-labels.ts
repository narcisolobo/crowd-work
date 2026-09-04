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

export function previewFor(
  entry: Pick<QueueEntry, "correctionNote" | "proposedData" | "changeType">,
): string {
  if (entry.correctionNote) {
    return entry.correctionNote.length > 90
      ? `${entry.correctionNote.slice(0, 90)}…`
      : entry.correctionNote;
  }
  const data = entry.proposedData as ProposedListingFields | null;
  if (data?.title) {
    return entry.changeType === "new"
      ? `New listing: ${data.title}`
      : `Update: ${data.title}`;
  }
  return "Cancellation";
}
