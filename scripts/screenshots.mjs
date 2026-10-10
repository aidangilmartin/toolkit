// Renders every screen against the in-memory mock backend and saves PNGs.
// Usage: pnpm build && node scripts/screenshots.mjs [outDir]
// Needs a Chromium: set CHROMIUM_PATH, or it uses Playwright's pre-installed one.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const outDir = process.argv[2] ?? "docs/screenshots";
const port = 4173;
const base = `http://localhost:${port}`;

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  const dir = existsSync(root)
    ? readdirSync(root).find((d) => /^chromium-\d+$/.test(d))
    : undefined;
  if (!dir) throw new Error("No Chromium found; set CHROMIUM_PATH");
  return join(root, dir, "chrome-linux", "chrome");
}

async function waitForServer(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} didn't start`);
}

const server = spawn("pnpm", ["exec", "vite", "preview", "--port", String(port), "--strictPort"], {
  stdio: "ignore",
});

try {
  await waitForServer(base);
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChromium() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  const shot = async (name) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    console.log(`  ${name}.png`);
  };
  const open = async (query = "") => {
    await page.goto(`${base}/${query}`);
    await page
      .getByRole("heading", { name: /Play|Welcome/ })
      .first()
      .waitFor();
  };
  const nav = (label) => page.locator("aside nav").getByRole("button", { name: label }).click();

  await open("?drift=1");
  await shot("play");

  await page.getByRole("button", { name: "Play · Los Santos Life RP" }).click();
  await page.getByRole("dialog").getByText("Sounds & mods").waitFor();
  await shot("apply-preview");
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: /^Arena – Max FPS/ })
    .first()
    .click();
  await page.getByRole("tab", { name: /Graphics/ }).waitFor();
  await shot("profile-graphics");
  await page.getByRole("tab", { name: /Sounds & mods/ }).click();
  await shot("profile-files");
  await page.getByRole("tab", { name: /In-game/ }).click();
  await shot("profile-ingame");
  await page.getByRole("button", { name: "Back", exact: true }).click();

  await nav("Backups");
  await shot("backups");
  await nav("Settings");
  await shot("settings");

  // A new profile: search the server list and pick a server, then upload sounds and mods.
  await open();
  await page.getByRole("button", { name: "New profile" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Most popular servers").waitFor();
  await dialog.getByLabel("Search servers").fill("roleplay");
  await dialog.getByText(/servers match/).waitFor();
  await shot("new-profile");
  await dialog.getByRole("option", { name: /Vinewood Roleplay/ }).click();
  await dialog.getByText("Play joins this server after applying the profile.").waitFor();
  await shot("new-profile-picked");
  await dialog.getByRole("button", { name: "Upload" }).first().click();
  await dialog.getByText("WEAPONS_PLAYER.rpf ·").waitFor();
  await dialog.getByRole("button", { name: "Add mods" }).click();
  await dialog.getByText("tracer_rounds", { exact: true }).waitFor();
  await shot("new-profile-files");
  await dialog.getByRole("button", { name: "Create profile" }).click();
  await page.getByText(/is ready$/).waitFor();
  await shot("play-new-profile");

  await open("?running=1");
  await page.getByRole("button", { name: "Play · Los Santos Life RP" }).click();
  await page.getByText("Close the game first").waitFor();
  await shot("game-running");

  await page.goto(`${base}/?setup=1`);
  await page.getByRole("heading", { name: /Welcome/ }).waitFor();
  await shot("setup");

  await browser.close();
  if (errors.length) {
    console.error("Errors in the page:\n" + errors.join("\n"));
    process.exitCode = 1;
  }
} finally {
  server.kill();
}
