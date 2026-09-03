import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  proposeRejection,
  confirmRejection,
  sendBackToPending,
} from "./moderation";
import {
  createAdminClient,
  signInTestModerator,
} from "./moderation-test-helpers";

let entryId: string;

beforeEach(async () => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("moderation_queue")
    .insert({
      change_type: "cancellation",
      listing_id: "d0000000-0000-0000-0000-000000000001",
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: "test entry",
      origin: "seed",
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  entryId = data.id;
});

afterEach(async () => {
  const admin = createAdminClient();
  await admin.from("moderation_queue").delete().eq("id", entryId);
});

describe("rejection state machine", () => {
  it("lets a moderator propose rejection on a pending entry", async () => {
    const moderator1 = await signInTestModerator(1);
    const result = await proposeRejection(
      moderator1,
      entryId,
      "Duplicate of another entry",
    );
    expect(result.status).toBe("rejection_proposed");
    expect(result.proposedReason).toBe("Duplicate of another entry");
  });

  it("blocks the proposing moderator from confirming their own rejection", async () => {
    const moderator1 = await signInTestModerator(1);
    await proposeRejection(moderator1, entryId, "Duplicate of another entry");

    await expect(confirmRejection(moderator1, entryId)).rejects.toThrow();
  });

  it("lets a different moderator confirm the rejection", async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    await proposeRejection(moderator1, entryId, "Duplicate of another entry");

    const result = await confirmRejection(moderator2, entryId);
    expect(result.status).toBe("rejected");
  });

  it("lets a different moderator send the entry back to pending", async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    await proposeRejection(moderator1, entryId, "Duplicate of another entry");

    const result = await sendBackToPending(moderator2, entryId);
    expect(result.status).toBe("pending");
    expect(result.proposedBy).toBeNull();
    expect(result.proposedReason).toBeNull();
  });
});
