import { test, expect } from "@playwright/test";

test("homepage lists open mics and shows, and links through to a listing", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/Crowd Work/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Crowd Work" }),
  ).toBeVisible();

  const rows = page.locator("[data-listing-row]:not([hidden])");
  await expect(rows.first()).toBeVisible();

  const firstTitle = await rows.first().locator("h2").innerText();

  await rows.first().locator("h2 a").click();

  await expect(page).toHaveURL(/\/listings\/.+/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(firstTitle);
  await expect(
    page.getByRole("link", { name: /Back to listings/i }),
  ).toBeVisible();
});
