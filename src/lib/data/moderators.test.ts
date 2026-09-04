import { describe, it, expect } from "vitest";
import { getModeratorEmails } from "./moderators";
import { signInTestModerator } from "./moderation-test-helpers";

describe("getModeratorEmails", () => {
  it("resolves moderator ids to their emails", async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    const {
      data: { user: user1 },
    } = await moderator1.auth.getUser();
    const {
      data: { user: user2 },
    } = await moderator2.auth.getUser();

    const emails = await getModeratorEmails(moderator1, [user1!.id, user2!.id]);

    expect(emails[user1!.id]).toBe(process.env.TEST_MODERATOR_1_EMAIL);
    expect(emails[user2!.id]).toBe(process.env.TEST_MODERATOR_2_EMAIL);
  });

  it("returns an empty object for an empty id list", async () => {
    const moderator1 = await signInTestModerator(1);
    const emails = await getModeratorEmails(moderator1, []);
    expect(emails).toEqual({});
  });
});
