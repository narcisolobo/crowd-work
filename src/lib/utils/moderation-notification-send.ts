import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isUrgent,
  isDigestEligible,
} from "./moderation-notification-rules.ts";
import {
  buildUrgentEmail,
  buildDigestEmail,
} from "./moderation-notification-templates.ts";

export type SendEmail = (args: {
  subject: string;
  html: string;
  to: string[];
}) => Promise<boolean>;

export async function runNotificationCycle(
  client: SupabaseClient,
  mode: "urgent" | "digest",
  now: Date,
  sendEmail: SendEmail,
): Promise<{ sent: boolean; matched: number }> {
  const { data: rows, error } = await client
    .from("moderation_queue")
    .select(
      "id, change_type, origin, correction_note, proposed_data, created_at, notified_at",
    )
    .eq("status", "pending");
  if (error)
    throw new Error(`Failed to fetch pending entries: ${error.message}`);

  const pending = (rows ?? []) as any[];
  const matched =
    mode === "urgent"
      ? pending.filter((row) =>
          isUrgent(
            {
              status: "pending",
              changeType: row.change_type,
              proposedData: row.proposed_data,
              notifiedAt: row.notified_at,
            },
            now,
          ),
        )
      : pending.filter((row) =>
          isDigestEligible(
            { status: "pending", notifiedAt: row.notified_at },
            now,
          ),
        );

  if (matched.length === 0) return { sent: false, matched: 0 };

  const templateEntries = matched.map((row) => ({
    id: row.id,
    changeType: row.change_type,
    origin: row.origin,
    correctionNote: row.correction_note,
    proposedData: row.proposed_data,
    createdAt: row.created_at,
  }));

  const email =
    mode === "urgent"
      ? buildUrgentEmail(templateEntries, now)
      : buildDigestEmail(templateEntries, now);
  if (!email) return { sent: false, matched: 0 };

  const { data: moderators, error: moderatorsError } = await client
    .from("moderators")
    .select("email");
  if (moderatorsError)
    throw new Error(`Failed to fetch moderators: ${moderatorsError.message}`);

  const ok = await sendEmail({
    subject: email.subject,
    html: email.html,
    to: (moderators ?? []).map((m: any) => m.email),
  });
  if (!ok) return { sent: false, matched: matched.length };

  const { error: updateError } = await client
    .from("moderation_queue")
    .update({ notified_at: now.toISOString() })
    .in(
      "id",
      matched.map((row) => row.id),
    );
  if (updateError)
    throw new Error(
      `Sent email but failed to mark notified_at: ${updateError.message}`,
    );

  return { sent: true, matched: matched.length };
}
