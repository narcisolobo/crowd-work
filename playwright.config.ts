import { defineConfig, devices } from "@playwright/test";

// Astro's `astro dev` always daemonizes (even without --background: the
// foreground CLI process hands off to a detached server process and exits
// immediately), so Playwright's own `webServer` launcher sees that exit and
// aborts with "Process from config.webServer exited early" even though the
// real server comes up fine a moment later. Managing the server ourselves
// (`astro dev --background` / `astro dev stop`, per this repo's CLAUDE.md)
// and pointing tests at it sidesteps that mismatch.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4321",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
