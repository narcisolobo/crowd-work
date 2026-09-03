import { test, expect } from "@playwright/test";

const email = process.env.TEST_MODERATOR_1_EMAIL;
const password = process.env.TEST_MODERATOR_1_PASSWORD;

test.skip(
  !email || !password,
  "TEST_MODERATOR_1_EMAIL/PASSWORD not set in .env",
);

test("a moderator can log in and see the moderation queue", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);

  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "Moderation queue" }),
  ).toBeVisible();
});

test("reporting a problem submits a correction into the moderation queue", async ({
  page,
}) => {
  await page.goto("/");
  const firstLink = page
    .locator("[data-listing-row]:not([hidden]) h2 a")
    .first();
  await firstLink.click();

  await page.getByRole("link", { name: /Report a problem/i }).click();
  await expect(page).toHaveURL(/\/report$/);

  await page.getByLabel(/Something else is wrong/i).check();
  await page.getByLabel("Details").fill("The sign-up sheet was gone by 7pm.");
  await page.getByRole("button", { name: "Submit report" }).click();

  await expect(
    page.getByText("Thanks — a moderator will review this shortly."),
  ).toBeVisible();
});
