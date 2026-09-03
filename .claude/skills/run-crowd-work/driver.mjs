// REPL driver for crowd-work, a server-rendered Astro site with a thin
// client-side filter script. `chromium-cli` (the tool the run-skill-generator
// skill points at) is not available in this environment and has no known
// public install path, so this adapts the same command surface directly on
// top of Playwright's `chromium`.
//
// Read one command per line from stdin (heredoc or tmux send-keys), run it
// against a persistent headless Chromium page, print a result line, repeat.
import { chromium } from "@playwright/test";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:4321";
const SHOT_DIR = process.env.SCREENSHOT_DIR || "/tmp/shots/crowd-work";
fs.mkdirSync(SHOT_DIR, { recursive: true });

let browser = null;
let page = null;
const consoleLog = [];

function resolveUrl(url) {
  return url.startsWith("http") ? url : new URL(url, BASE_URL).toString();
}

const COMMANDS = {
  async launch() {
    if (browser) return console.log("already launched");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    page = await (await browser.newContext()).newPage();
    page.on("console", (msg) =>
      consoleLog.push({ type: msg.type(), text: msg.text() }),
    );
    page.on("pageerror", (err) =>
      consoleLog.push({ type: "pageerror", text: err.message }),
    );
    console.log("launched");
  },

  async nav(url) {
    if (!page) return console.log("ERROR: launch first");
    await page.goto(resolveUrl(url), { waitUntil: "domcontentloaded" });
    console.log("nav", url, "->", page.url());
  },

  // `wait-for <selector>` or `wait-for text=Some text` - Playwright's CSS
  // engine understands the `text=` / `:has-text()` prefixes natively, so no
  // special-casing is needed here (this differs from the Electron driver,
  // which has to reach into the DOM by hand instead).
  async "wait-for"(sel) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.waitForSelector(sel, { timeout: 10_000 });
      console.log("found:", sel);
    } catch {
      console.log("TIMEOUT:", sel);
    }
  },

  async click(sel) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.click(sel, { timeout: 10_000 });
      console.log("click", sel, "-> OK");
    } catch (e) {
      console.log("click", sel, "-> ERROR:", e.message.split("\n")[0]);
    }
  },

  // `fill <selector> <text...>` - the rest of the line after the selector is
  // the value, so values can contain spaces without quoting.
  async fill(rest) {
    if (!page) return console.log("ERROR: launch first");
    const [sel, ...words] = rest.split(/\s+/);
    const value = words.join(" ");
    await page.fill(sel, value);
    console.log("fill", sel, JSON.stringify(value), "-> OK");
  },

  async type(text) {
    if (!page) return console.log("ERROR: launch first");
    await page.keyboard.type(text, { delay: 20 });
    console.log("type", JSON.stringify(text), "-> OK");
  },

  async press(key) {
    if (!page) return console.log("ERROR: launch first");
    await page.keyboard.press(key);
    console.log("press", key, "-> OK");
  },

  async screenshot(name) {
    if (!page) return console.log("ERROR: launch first");
    const file = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`);
    await page.screenshot({ path: file });
    console.log("screenshot:", file);
  },
  async ss(name) {
    await COMMANDS.screenshot(name);
  },

  async "screenshot-element"(rest) {
    if (!page) return console.log("ERROR: launch first");
    const [sel, name] = rest.split(/\s+/);
    const file = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`);
    await page.locator(sel).screenshot({ path: file });
    console.log("screenshot-element:", file);
  },

  async text(sel) {
    if (!page) return console.log("ERROR: launch first");
    const value = await page.evaluate(
      (s) =>
        (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)",
      sel || null,
    );
    console.log(value);
  },

  async eval(expr) {
    if (!page) return console.log("ERROR: launch first");
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  async url() {
    console.log(page ? page.url() : "(no page)");
  },

  async title() {
    console.log(page ? await page.title() : "(no page)");
  },

  // `console` prints everything captured so far; `console --errors` filters
  // to console.error + uncaught page errors.
  async console(args) {
    const onlyErrors = args?.trim() === "--errors";
    const rows = onlyErrors
      ? consoleLog.filter((m) => m.type === "error" || m.type === "pageerror")
      : consoleLog;
    if (rows.length === 0) return console.log("(none)");
    for (const m of rows) console.log(`[${m.type}] ${m.text}`);
  },

  async quit() {
    if (browser) await browser.close().catch(() => {});
    browser = null;
    page = null;
  },

  help() {
    console.log("commands:", Object.keys(COMMANDS).join(", "));
  },
};

// Plain Node process (not Electron, which grabs stdin for itself) - the
// default process.stdin is fine here.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "driver> ",
});

// A heredoc dumps every line into readline's buffer before the first
// `launch` finishes, so `line` events fire well ahead of each other's async
// work. Chain them into one queue instead of handling them concurrently -
// otherwise "launch" hasn't set `page` yet by the time "nav" runs.
let queue = Promise.resolve();

// With heredoc/piped input, stdin hits EOF (and readline auto-closes)
// almost immediately - well before the queued async commands finish - so
// `rl.prompt()` after a later command would throw ERR_USE_AFTER_CLOSE.
// The prompt is only cosmetic for interactive (tmux) use, so just skip it
// once the interface has closed itself.
function safePrompt() {
  if (!rl.closed) rl.prompt();
}

async function handleLine(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return safePrompt();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log("unknown:", cmd, "- try: help");
    return safePrompt();
  }
  try {
    await fn(rest.join(" "));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
  if (cmd === "quit") {
    process.exit(0);
  }
  safePrompt();
}

rl.on("line", (line) => {
  queue = queue.then(() => handleLine(line));
});
// Heredoc input closes stdin right after the last line is queued, which
// fires 'close' before that line's (possibly still-running) command
// finishes. Chain onto the same queue so a pending command completes
// before quitting instead of being killed mid-flight.
rl.on("close", () => {
  queue = queue.then(async () => {
    await COMMANDS.quit();
    process.exit(0);
  });
});

console.log('crowd-work driver - "help" for commands, "launch" to start');
rl.prompt();
