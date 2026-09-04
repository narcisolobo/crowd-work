import { test, expect } from "@playwright/test";
import {
  approveCancellation,
  confirmRejection,
  proposeRejection,
} from "../src/lib/data/moderation";
import {
  createAdminClient,
  signInTestModerator,
} from "../src/lib/data/moderation-test-helpers";

const email1 = process.env.TEST_MODERATOR_1_EMAIL;
const password1 = process.env.TEST_MODERATOR_1_PASSWORD;
const email2 = process.env.TEST_MODERATOR_2_EMAIL;
const password2 = process.env.TEST_MODERATOR_2_PASSWORD;

test.skip(
  !email1 || !password1 || !email2 || !password2,
  "TEST_MODERATOR_1/2_EMAIL/PASSWORD not set in .env",
);

// Seeded from supabase/seed.sql — a real published listing, so approving a
// cancellation against it can write a real occurrence_exceptions row.
const SEED_LISTING_ID = "d0000000-0000-0000-0000-000000000001";

async function createPendingCancellation(
  correctionNote: string,
  originalDate: string,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("moderation_queue")
    .insert({
      change_type: "cancellation",
      listing_id: SEED_LISTING_ID,
      proposed_data: { originalDate },
      correction_note: correctionNote,
      origin: "seed",
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

async function deleteEntry(id: string) {
  const admin = createAdminClient();
  await admin.from("moderation_queue").delete().eq("id", id);
}

async function deleteOccurrenceException(originalDate: string) {
  const admin = createAdminClient();
  await admin
    .from("occurrence_exceptions")
    .delete()
    .eq("listing_id", SEED_LISTING_ID)
    .eq("original_date", originalDate);
}

function randomFutureDate(): string {
  const date = new Date("2028-01-01T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + Math.floor(Math.random() * 3000));
  return date.toISOString().slice(0, 10);
}

async function login(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("approving a cancellation with a canned reason records the approver and shows up in the archive", async ({
  page,
}) => {
  const note = `E2E approve test ${Date.now()}`;
  const originalDate = randomFutureDate();
  const entryId = await createPendingCancellation(note, originalDate);

  try {
    await login(page, email1!, password1!);

    await page.goto(`/admin/queue/${entryId}`);
    await page
      .locator('select[name="reason"]')
      .selectOption("Verified independently");
    await page.getByRole("button", { name: "Approve cancellation" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto("/admin/archive");
    const row = page.locator("[data-archive-row]", { hasText: note });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Approved");
    await expect(row).toContainText(email1!);
    await expect(row).toContainText("Verified independently");
  } finally {
    await deleteEntry(entryId);
    await deleteOccurrenceException(originalDate);
  }
});

test("a rejection proposed by one moderator and confirmed by another records both in the archive", async ({
  page,
}) => {
  const note = `E2E reject test ${Date.now()}`;
  const rejectionReason = "Duplicate report";
  const entryId = await createPendingCancellation(note, randomFutureDate());

  try {
    await login(page, email1!, password1!);
    await page.goto(`/admin/queue/${entryId}`);
    await page.getByLabel("Reason for rejection").fill(rejectionReason);
    await page.getByRole("button", { name: "Propose rejection" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto("/admin/logout");
    await expect(page).toHaveURL(/\/admin\/login$/);

    await login(page, email2!, password2!);
    await page.goto(`/admin/queue/${entryId}`);
    await page.getByRole("button", { name: "Confirm rejection" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto("/admin/archive");
    const row = page.locator("[data-archive-row]", { hasText: note });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Rejected");
    await expect(row).toContainText(`Proposed by ${email1}`);
    await expect(row).toContainText(`confirmed by ${email2}`);
    await expect(row).toContainText(rejectionReason);
  } finally {
    await deleteEntry(entryId);
  }
});

test("the archive's status tabs and its no-JS query-param fallback each show exactly one status", async ({
  page,
  browser,
}) => {
  const moderator1 = await signInTestModerator(1);
  const moderator2 = await signInTestModerator(2);

  const approvedNote = `E2E filter approved ${Date.now()}`;
  const rejectedNote = `E2E filter rejected ${Date.now()}`;
  const approvedOriginalDate = randomFutureDate();
  const approvedEntryId = await createPendingCancellation(
    approvedNote,
    approvedOriginalDate,
  );
  const rejectedEntryId = await createPendingCancellation(
    rejectedNote,
    randomFutureDate(),
  );

  await approveCancellation(
    moderator1,
    approvedEntryId,
    SEED_LISTING_ID,
    approvedOriginalDate,
    approvedNote,
    "Accurate as submitted",
  );
  await proposeRejection(moderator1, rejectedEntryId, "Duplicate report");
  await confirmRejection(moderator2, rejectedEntryId);

  try {
    await login(page, email1!, password1!);
    await page.goto("/admin/archive");

    const approvedRow = page.locator("[data-archive-row]", {
      hasText: approvedNote,
    });
    const rejectedRow = page.locator("[data-archive-row]", {
      hasText: rejectedNote,
    });
    await expect(approvedRow).toBeVisible();
    await expect(rejectedRow).toBeVisible();

    await page.getByRole("button", { name: "Approved", exact: true }).click();
    await expect(approvedRow).toBeVisible();
    await expect(rejectedRow).toBeHidden();

    await page.getByRole("button", { name: "Rejected", exact: true }).click();
    await expect(rejectedRow).toBeVisible();
    await expect(approvedRow).toBeHidden();

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(approvedRow).toBeVisible();
    await expect(rejectedRow).toBeVisible();

    const noJsContext = await browser.newContext({
      javaScriptEnabled: false,
    });
    try {
      const noJsPage = await noJsContext.newPage();
      await login(noJsPage, email1!, password1!);
      await noJsPage.goto("/admin/archive?status=approved");
      await expect(
        noJsPage.locator("[data-archive-row]", { hasText: approvedNote }),
      ).toBeVisible();
      await expect(
        noJsPage.locator("[data-archive-row]", { hasText: rejectedNote }),
      ).toBeHidden();
    } finally {
      await noJsContext.close();
    }
  } finally {
    await deleteEntry(approvedEntryId);
    await deleteEntry(rejectedEntryId);
    await deleteOccurrenceException(approvedOriginalDate);
  }
});
