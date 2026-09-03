---
name: run-crowd-work
description: Build, run, and drive crowd-work (an Astro SSR site backed by local Supabase). Use when asked to start crowd-work's dev server, run its unit or e2e tests, build it, take a screenshot of a page, or interact with the running app.
---

crowd-work is a server-rendered Astro site (open mic / comedy show listings for LA) reading from a local Supabase Postgres instance. For agent/automated use, drive it via the Playwright REPL at `.claude/skills/run-crowd-work/driver.mjs` — `chromium-cli` (the tool this generator normally points at) has no known public install path in this environment, so the driver reimplements its `nav`/`wait-for`/`click`/`screenshot`/`console` command surface directly on Playwright's `chromium`.

All paths below are relative to the repo root.

## Prerequisites

- Node >=22.12.0, pnpm (`packageManager` pin in `package.json`).
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`supabase` on PATH) and Docker Desktop running — local Postgres is where all listing data lives; without it the homepage's `getPublishedListings()`/`getAreas()` calls fail.
- Playwright's Chromium browser, installed once via:

```bash
pnpm exec playwright install chromium
```

## Setup

```bash
pnpm install
```

`.env` needs Supabase credentials pointed at the **local** stack (see `.env.example`): `PUBLIC_SUPABASE_URL` = the `API_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` = the `PUBLISHABLE_KEY` printed by `supabase start` below. `RESEND_API_KEY`/`VERCEL_OIDC_TOKEN` aren't needed to browse or drive the site.

## Run (agent path)

1. Start local Supabase (seeds `areas`/`venues`/`listings` from `supabase/seed.sql`):

```bash
supabase start
```

If this fails with a Docker connection error, Docker Desktop isn't running — `open -a Docker` and wait for `docker info` to succeed before retrying.

2. Start the Astro dev server as a background process and wait for it to actually serve (per this repo's `CLAUDE.md`, always use `--background`, never bare `astro dev` in the foreground):

```bash
pnpm exec astro dev --background
until curl -sf http://localhost:4321 >/dev/null; do sleep 1; done
```

`pnpm exec astro dev status` reports whether it's up; `pnpm exec astro dev stop` stops it. If it says "Dev server already running," that's a leftover from a prior session — reuse it or `stop` first.

3. Drive it — pipe a script of commands to the driver over stdin:

```bash
node .claude/skills/run-crowd-work/driver.mjs <<'EOF'
launch
nav /
wait-for [data-listing-row]
screenshot 01-homepage
click h2 a
wait-for text=Back to listings
screenshot 02-listing-detail
console --errors
quit
EOF
```

Screenshots land in `/tmp/shots/crowd-work/` (override with `SCREENSHOT_DIR`). Each invocation launches and closes its own browser — there's no session persistence across separate `driver.mjs` runs, so batch everything you need into one heredoc.

### Commands

| command | what it does |
|---|---|
| `launch` | launch headless Chromium |
| `nav <url>` | go to a URL (relative paths resolve against `http://localhost:4321`) |
| `wait-for <selector>` | wait up to 10s for a selector — supports Playwright's `text=...` selectors too |
| `click <selector>` | click an element |
| `fill <selector> <text...>` | fill an input (rest of the line is the value) |
| `type <text>` / `press <key>` | keyboard input |
| `screenshot [name]` / `ss [name]` | full-page screenshot -> `<SHOT_DIR>/<name>.png` |
| `screenshot-element <selector> [name]` | screenshot of one element |
| `text [selector]` | print `innerText` (body if no selector) |
| `eval <js>` | evaluate JS in the page, print JSON result |
| `url` / `title` | print current URL / page title |
| `console [--errors]` | print captured console messages, or just errors/pageerrors |
| `quit` | close the browser and exit |

For interactive, step-by-step driving instead of a batch heredoc, run `node .claude/skills/run-crowd-work/driver.mjs` under `tmux` and `send-keys` one command at a time — same commands, same driver. (Not verified in this environment: `tmux` isn't installed here, so only the heredoc form above has been exercised.)

## Run (human path)

```bash
pnpm dev   # foreground `astro dev` — same daemonizing behavior as --background, see Gotchas
```

Open `http://localhost:4321`. Stop with `pnpm exec astro dev stop`.

## Test

```bash
pnpm test       # vitest — 20 unit tests (date/format/recurrence utils)
pnpm test:e2e   # playwright — e2e/smoke.spec.ts, homepage -> listing detail
pnpm check      # astro check — 0 errors expected
```

## Gotchas

- **`astro dev` always daemonizes, even without `--background`.** The foreground CLI process hands off to a detached server process and exits immediately after printing a status line. This is why `playwright.config.ts` has no `webServer` entry — Playwright's own launcher treats that immediate exit as "Process from config.webServer exited early" and aborts, even though the real server comes up fine moments later. Start and stop the dev server yourself (as above) rather than letting a tool try to manage its lifecycle.
- **The homepage's listing window is relative to "today in LA," not UTC** (`getTodayInLA`), and only shows occurrences in the next 30 days. Seeded data (`supabase/seed.sql`) includes a weekly Tuesday mic, a monthly "last Thursday" mic, and a one-off show — if the homepage looks empty, check `supabase status` (data missing) before assuming a rendering bug.
- **No `chromium-cli` in this environment.** Searched PATH, global npm/pnpm, and the web — no install path was found for the tool the `run-skill-generator`'s own examples assume. The driver here is the documented fallback: Playwright `chromium.launch()` wearing the same command names.

## Troubleshooting

- **`supabase start` fails with `failed to connect to the docker API ... no such file or directory`**: Docker Desktop isn't running. `open -a Docker`, poll `docker info` until it succeeds, then retry.
- **`pnpm exec astro dev` prints "Dev server already running at ... (pid ...)" and exits**: a background server is already up from an earlier `--background` call. Check `pnpm exec astro dev status`; either reuse it or `pnpm exec astro dev stop` first.
