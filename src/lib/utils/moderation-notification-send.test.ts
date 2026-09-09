import { describe, it, expect, afterEach, vi } from "vitest";
import { runNotificationCycle } from "./moderation-notification-send";
import {
  createAdminClient,
  signInNotificationAgent,
} from "../data/moderation-test-helpers";

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

async function insertPendingCancellation(
  originalDate: string,
): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("moderation_queue")
    .insert({
      change_type: "cancellation",
      origin: "report_form",
      status: "pending",
      listing_id: "d0000000-0000-0000-0000-000000000001",
      proposed_data: { originalDate },
      correction_note: "Orchestration cycle test fixture",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedEntryIds.push(data.id);
  return data.id;
}

describe("runNotificationCycle", () => {
  it("sends an urgent email for a newly-urgent entry and marks it notified", async () => {
    const agent = await signInNotificationAgent();
    const now = new Date("2026-09-10T12:00:00Z");
    await insertPendingCancellation("2026-09-11");

    const sendEmail = vi.fn().mockResolvedValue(true);
    const result = await runNotificationCycle(agent, "urgent", now, sendEmail);

    expect(result.sent).toBe(true);
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = sendEmail.mock.calls[0][0];
    expect(call.subject).toMatch(/^Urgent:/);
    expect(call.html).toContain("Orchestration cycle test fixture");
    expect(call.to.length).toBeGreaterThan(0);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("notified_at")
      .eq("id", insertedEntryIds[0])
      .single();
    expect(entry!.notified_at).not.toBeNull();
  });

  it("does not re-send or duplicate-count an already-urgent-notified entry the same day", async () => {
    const agent = await signInNotificationAgent();
    const now = new Date("2026-09-10T12:00:00Z");
    const id = await insertPendingCancellation("2026-09-11");

    const firstSend = vi.fn().mockResolvedValue(true);
    await runNotificationCycle(agent, "urgent", now, firstSend);

    const secondSend = vi.fn().mockResolvedValue(true);
    const secondResult = await runNotificationCycle(
      agent,
      "urgent",
      now,
      secondSend,
    );
    expect(secondSend).not.toHaveBeenCalled();
    expect(secondResult.sent).toBe(false);

    // Same-day digest also excludes it (already surfaced today)...
    const digestSameDay = vi.fn().mockResolvedValue(true);
    await runNotificationCycle(agent, "digest", now, digestSameDay);
    if (digestSameDay.mock.calls.length > 0) {
      expect(digestSameDay.mock.calls[0][0].html).not.toContain(id);
    }

    // ...but reappears in tomorrow's digest, since it's still pending.
    const tomorrow = new Date("2026-09-11T12:00:00Z");
    const digestNextDay = vi.fn().mockResolvedValue(true);
    await runNotificationCycle(agent, "digest", tomorrow, digestNextDay);
    expect(digestNextDay).toHaveBeenCalledTimes(1);
    expect(digestNextDay.mock.calls[0][0].html).toContain(
      "Orchestration cycle test fixture",
    );
  });

  it("does not mark notified_at when sendEmail reports failure", async () => {
    const agent = await signInNotificationAgent();
    const now = new Date("2026-09-10T12:00:00Z");
    await insertPendingCancellation("2026-09-11");

    const failingSend = vi.fn().mockResolvedValue(false);
    const result = await runNotificationCycle(
      agent,
      "urgent",
      now,
      failingSend,
    );
    expect(result.sent).toBe(false);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("notified_at")
      .eq("id", insertedEntryIds[0])
      .single();
    expect(entry!.notified_at).toBeNull();
  });
});
