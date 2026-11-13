import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer as portServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const playwrightPath = "/Users/esoefildine/Documents/Dev/gerertales/node_modules/playwright-core/index.mjs";
const { chromium, _electron } = await import(pathToFileURL(playwrightPath).href);

const temp = mkdtempSync(join(tmpdir(), "gbs-z-qa-"));
const data = join(temp, "data");
const profile = join(temp, "electron-profile");
const project = join(temp, "project");
const screenshotsDir = join(root, "docs/design/screenshots");
mkdirSync(data, { recursive: true });
mkdirSync(profile, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(screenshotsDir, { recursive: true });

// Seed disposable test data
const config = {
  profile: { name: "QA Tester", email: "" },
  instances: {
    ghost: {
      driver: "not-a-real-driver",
      displayName: "Claude 3.5 Sonnet",
    },
  },
};
writeFileSync(join(data, "config.json"), JSON.stringify(config, null, 2));

const bots = [
  {
    id: "bot-long-name",
    name: "Senior UI/UX Designer & Motion Specialist Z",
    title: "UI/UX Designer",
    description: "Bot with a long name for layout QA",
    color: "purple",
    threadId: "thread-bot-long",
    modelSelection: {
      instanceId: "ghost",
      model: "claude-3-5-sonnet-20241022",
      label: "Claude 3.5 Sonnet",
    },
    createdAt: 1700000000000,
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `bot-member-${i + 1}`,
    name: `Bot Member ${i + 1}`,
    title: `Specialist ${i + 1}`,
    description: `Member ${i + 1}`,
    color: ["green", "blue", "red", "orange", "cyan", "pink"][i],
    threadId: `thread-bot-${i + 1}`,
    modelSelection: {
      instanceId: "ghost",
      model: "claude-3-5-sonnet-20241022",
      label: "Claude 3.5 Sonnet",
    },
    createdAt: 1700000000000 + i * 1000,
  })),
];
writeFileSync(join(data, "bots.json"), JSON.stringify(bots, null, 2));

const groups = [
  {
    id: "group-six-members",
    name: "Product Expansion Design Review",
    topic: "Room for six members layout QA",
    threadId: "thread-group-six",
    memberIds: Array.from({ length: 6 }, (_, i) => `bot-member-${i + 1}`),
    createdAt: 1700000000000,
  },
];
writeFileSync(join(data, "groups.json"), JSON.stringify(groups, null, 2));

writeFileSync(join(project, "index.html"), "<!doctype html><html><body><h1>Project Preview</h1></body></html>");

async function freePort() {
  const s = portServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

const apiPort = await freePort();
const uiPort = await freePort();
const api = `http://127.0.0.1:${apiPort}`;
const ui = `http://127.0.0.1:${uiPort}`;

console.log(`Starting isolated test harness on apiPort=${apiPort}, uiPort=${uiPort}...`);

const children = [];
let logs = "";
const env = {
  ...process.env,
  HOME: temp,
  USERPROFILE: temp,
  GBS_DATA_DIR: data,
  GBS_PROJECTS_FILE: join(data, "projects.json"),
  GBS_PORT: String(apiPort),
};

function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stderr.on("data", (b) => {
    logs = (logs + b).slice(-10000);
  });
}

async function until(read, valid, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (valid(value)) return value;
    if (Date.now() > end) throw new Error(logs || "Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((r) => {
    const t = setTimeout(() => child.kill("SIGKILL"), 3000);
    t.unref();
    child.once("close", () => {
      clearTimeout(t);
      r();
    });
    child.kill("SIGTERM");
  });
}

let browser;
let electronApp;

try {
  start(["server/index.ts"]);
  start(["node_modules/vite/bin/vite.js", "--port", String(uiPort), "--strictPort"]);

  await until(() => fetch(api + "/api/health"), (r) => r?.ok);
  await until(() => fetch(ui), (r) => r?.ok);

  console.log("Isolated test harness and Vite UI are UP!");

  // Register the test project
  await fetch(api + "/api/projects/add-existing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath: project }),
  });

  // Create tasks assigned to bot-long-name
  await fetch(api + "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Implement Header Reflow",
      assigneeBotId: "bot-long-name",
      priority: "high",
    }),
  });
  await fetch(api + "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Second task for badge count",
      assigneeBotId: "bot-long-name",
      priority: "normal",
    }),
  });

  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    executablePath: existsSync(chromePath) ? chromePath : undefined,
    headless: true,
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // Set initial localStorage
  await page.goto(ui);
  await page.evaluate(() => {
    localStorage.setItem("gbs-email-gate", "skipped");
  });

  console.log("\n========================================================");
  console.log("TEST CASE (cb76884d): Quick preview More menu at 1024px & Close button position");
  console.log("========================================================");
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("chat-mobile-preview-open", "true");
    localStorage.setItem("chat-tasks-open", "false");
  });
  await page.goto(ui);
  await page.waitForSelector("main");
  await page.locator('button[data-conversation-id="bot-long-name"]').click();
  await page.waitForTimeout(500);

  // Measure Close quick preview button at 1024
  const close1024 = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Close quick preview"]');
    const panel = document.querySelector('aside[aria-label="Quick preview panel"]');
    if (!btn || !panel) return null;
    const bRect = btn.getBoundingClientRect();
    const pRect = panel.getBoundingClientRect();
    const center = bRect.left + bRect.width / 2;
    const hit = document.elementFromPoint(center, bRect.top + bRect.height / 2);
    return {
      btnRect: { left: bRect.left, right: bRect.right, width: bRect.width },
      panelRect: { left: pRect.left, right: pRect.right },
      center,
      fullyInside: bRect.right <= 1024 && bRect.right <= pRect.right,
      hitTestPass: btn.contains(hit),
    };
  });
  console.log("Close button at 1024px measurements:", close1024);
  assert.ok(close1024?.fullyInside, "Close button must be fully inside panel and viewport at 1024px");
  assert.ok(close1024?.hitTestPass, "Close button center must pass elementFromPoint at 1024px");

  // Open "More preview options" at 1024
  const morePreviewBtn = page.getByRole("button", { name: "More preview options" });
  await morePreviewBtn.click();
  await page.waitForTimeout(200);

  // Verify More menu items via elementFromPoint at 1024
  const moreMenu1024 = await page.evaluate(() => {
    const menu = document.querySelector('div[role="menu"][aria-label="More preview options"]');
    if (!menu) return null;
    const mRect = menu.getBoundingClientRect();
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        text: el.textContent?.trim(),
        rect: { top: rect.top, bottom: rect.bottom },
        hitTestPass: el.contains(hit),
      };
    });
    return {
      menuRect: { top: mRect.top, bottom: mRect.bottom, right: mRect.right },
      items,
      allItemsPass: items.length > 0 && items.every((i) => i.hitTestPass),
    };
  });
  console.log("Quick preview More menu at 1024px:", moreMenu1024);
  assert.ok(moreMenu1024?.allItemsPass, "All Quick preview More menu items must be hit-testable via elementFromPoint at 1024px");

  const screenshotMore1024 = join(screenshotsDir, "quick_preview_more_menu_open_1024.png");
  await page.screenshot({ path: screenshotMore1024 });
  console.log(`Saved screenshot to ${screenshotMore1024}`);

  // Test Escape closes More menu and restores focus
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const moreClosed1024 = await page.evaluate(() => {
    const menu = document.querySelector('div[role="menu"][aria-label="More preview options"]');
    const active = document.activeElement;
    const btn = document.querySelector('button[aria-label="More preview options"]');
    return { menuClosed: !menu, focusRestored: active === btn };
  });
  console.log("Escape on More menu at 1024px:", moreClosed1024);
  assert.ok(moreClosed1024.menuClosed, "Escape must close Quick preview More menu");
  assert.ok(moreClosed1024.focusRestored, "Escape must restore focus to More preview options button");

  console.log("\n========================================================");
  console.log("TEST CASE (cb76884d): Outside dismissal on rendered page (y=750) & blur");
  console.log("========================================================");
  // Open More menu
  await page.getByRole("button", { name: "More preview options" }).click();
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => Boolean(document.querySelector('div[role="menu"][aria-label="More preview options"]'))), "More menu must be open");

  // Click panel horizontal center at y=750 (rendered page area)
  const panelCenter = await page.evaluate(() => {
    const p = document.querySelector('aside[aria-label="Quick preview panel"]');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  await page.mouse.click(panelCenter, 750);
  await page.waitForTimeout(300);

  const moreAfterPageClick = await page.evaluate(() => ({
    menuOpen: Boolean(document.querySelector('div[role="menu"][aria-label="More preview options"]')),
    panelOpen: Boolean(document.querySelector('aside[aria-label="Quick preview panel"]')),
  }));
  console.log("After clicking page at y=750 with More menu open:", moreAfterPageClick);
  assert.ok(!moreAfterPageClick.menuOpen, "Clicking rendered page at y=750 must dismiss More menu");
  assert.ok(moreAfterPageClick.panelOpen, "Quick preview panel must remain open");

  // Open Size menu
  await page.getByRole("button", { name: "Choose preview size" }).click();
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => Boolean(document.querySelector('div[role="menu"][aria-label="Choose preview size"]'))), "Size menu must be open");

  // Click panel horizontal center at y=750
  await page.mouse.click(panelCenter, 750);
  await page.waitForTimeout(300);

  const sizeAfterPageClick = await page.evaluate(() => ({
    menuOpen: Boolean(document.querySelector('div[role="menu"][aria-label="Choose preview size"]')),
    panelOpen: Boolean(document.querySelector('aside[aria-label="Quick preview panel"]')),
  }));
  console.log("After clicking page at y=750 with Size menu open:", sizeAfterPageClick);
  assert.ok(!sizeAfterPageClick.menuOpen, "Clicking rendered page at y=750 must dismiss Size menu");
  assert.ok(sizeAfterPageClick.panelOpen, "Quick preview panel must remain open");

  console.log("\n========================================================");
  console.log("TEST CASE (cb76884d): Size selector keyboard navigation");
  console.log("========================================================");
  // Focus trigger button
  await page.locator('button[aria-label="Choose preview size"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);

  // Verify menu is open and focused element is a menuitem
  const initialFocus = await page.evaluate(() => {
    const menu = document.querySelector('div[role="menu"][aria-label="Choose preview size"]');
    const active = document.activeElement;
    return {
      menuOpen: Boolean(menu),
      activeIsMenuItem: active?.getAttribute("role") === "menuitem",
      activeText: active?.textContent?.trim().slice(0, 30),
      activeSelected: active?.getAttribute("aria-selected") === "true",
    };
  });
  console.log("Initial focus after Enter on Choose preview size:", initialFocus);
  assert.ok(initialFocus.menuOpen, "Size menu must open on Enter");
  assert.ok(initialFocus.activeIsMenuItem, "Focus must move to a role='menuitem' option");

  // ArrowDown moves focus
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const afterDown = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      activeIsMenuItem: active?.getAttribute("role") === "menuitem",
      activeText: active?.textContent?.trim().slice(0, 30),
    };
  });
  console.log("After ArrowDown:", afterDown);
  assert.ok(afterDown.activeIsMenuItem, "ArrowDown must keep focus on role='menuitem'");

  // ArrowUp moves focus back
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(100);
  const afterUp = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      activeIsMenuItem: active?.getAttribute("role") === "menuitem",
      activeText: active?.textContent?.trim().slice(0, 30),
    };
  });
  console.log("After ArrowUp:", afterUp);
  assert.ok(afterUp.activeIsMenuItem, "ArrowUp must move focus");

  // Escape closes menu and restores focus to trigger
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const afterEscape = await page.evaluate(() => {
    const menu = document.querySelector('div[role="menu"][aria-label="Choose preview size"]');
    const active = document.activeElement;
    const btn = document.querySelector('button[aria-label="Choose preview size"]');
    return {
      menuClosed: !menu,
      focusRestored: active === btn,
    };
  });
  console.log("After Escape on Size menu:", afterEscape);
  assert.ok(afterEscape.menuClosed, "Escape must close size menu");
  assert.ok(afterEscape.focusRestored, "Escape must restore focus to trigger button");

  console.log("\n========================================================");
  console.log("TEST CASE (cb76884d): Quick preview More menu at 1440px & Close button with Tasks closed");
  console.log("========================================================");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  // Measure Close button at 1440 with Tasks closed
  const close1440 = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Close quick preview"]');
    const panel = document.querySelector('aside[aria-label="Quick preview panel"]');
    if (!btn || !panel) return null;
    const bRect = btn.getBoundingClientRect();
    const pRect = panel.getBoundingClientRect();
    const center = bRect.left + bRect.width / 2;
    const hit = document.elementFromPoint(center, bRect.top + bRect.height / 2);
    return {
      btnRect: { left: bRect.left, right: bRect.right, width: bRect.width },
      panelRect: { left: pRect.left, right: pRect.right },
      center,
      fullyInside: bRect.right <= 1440 && bRect.right <= pRect.right,
      hitTestPass: btn.contains(hit),
    };
  });
  console.log("Close button at 1440px measurements:", close1440);
  assert.ok(close1440?.fullyInside, "Close button must be fully inside panel and viewport at 1440px");
  assert.ok(close1440?.hitTestPass, "Close button center must pass elementFromPoint at 1440px");

  // Open More menu at 1440
  await page.getByRole("button", { name: "More preview options" }).click();
  await page.waitForTimeout(200);

  const moreMenu1440 = await page.evaluate(() => {
    const menu = document.querySelector('div[role="menu"][aria-label="More preview options"]');
    if (!menu) return null;
    const mRect = menu.getBoundingClientRect();
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        text: el.textContent?.trim(),
        hitTestPass: el.contains(hit),
      };
    });
    return {
      menuRect: { top: mRect.top, bottom: mRect.bottom, right: mRect.right },
      allItemsPass: items.length > 0 && items.every((i) => i.hitTestPass),
    };
  });
  console.log("Quick preview More menu at 1440px:", moreMenu1440);
  assert.ok(moreMenu1440?.allItemsPass, "All Quick preview More menu items must be hit-testable via elementFromPoint at 1440px");

  const screenshotMore1440 = join(screenshotsDir, "quick_preview_more_menu_open_1440.png");
  await page.screenshot({ path: screenshotMore1440 });
  console.log(`Saved screenshot to ${screenshotMore1440}`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  console.log("\n========================================================");
  console.log("TEST CASE (0d25eafe): Bot Settings open at 1440px with Preview + Tasks");
  console.log("========================================================");
  // Ensure Preview and Tasks are both open at 1440
  await page.evaluate(() => {
    localStorage.setItem("chat-mobile-preview-open", "true");
    localStorage.setItem("chat-tasks-open", "true");
  });
  await page.goto(ui);
  await page.waitForSelector("main");
  await page.locator('button[data-conversation-id="bot-long-name"]').click();
  await page.waitForTimeout(500);

  // Click bot settings trigger (name button in header)
  const botSettingsTrigger = page.locator('main button[title="Bot settings"]');
  await botSettingsTrigger.click();
  console.log("Waiting 900ms for settings animation...");
  await page.waitForTimeout(1000);

  // Verify SettingsPanel layout & controls
  const settingsMeasurements = await page.evaluate(() => {
    const settingsAside = Array.from(document.querySelectorAll("aside")).find(
      (a) =>
        a.querySelector('button[aria-label="Use idle expression"]') ||
        (a.textContent?.includes("Settings") && a.textContent?.includes("Expression")),
    );
    if (!settingsAside) return { found: false };
    const sRect = settingsAside.getBoundingClientRect();

    // Find "Use idle expression" button
    const idleToggle = settingsAside.querySelector('button[aria-label="Use idle expression"]');
    const idleRect = idleToggle?.getBoundingClientRect();
    const idleHit = idleRect
      ? document.elementFromPoint(idleRect.left + idleRect.width / 2, idleRect.top + idleRect.height / 2)
      : null;

    // Check expression / color buttons in the visible portion of Settings
    const buttons = Array.from(
      settingsAside.querySelectorAll('button[aria-label*="expression"], button[aria-label*="color"], button[aria-label="Close settings"]'),
    ).map((b) => {
      const rect = b.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        label: b.getAttribute("aria-label") || b.textContent?.trim(),
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        hitPass: b.contains(hit),
      };
    });

    const tasksPanel = document.querySelector('aside[aria-label="Tasks"]');
    const previewPanel = document.querySelector('aside[aria-label="Quick preview panel"]');
    const tRect = tasksPanel?.getBoundingClientRect();
    const pRect = previewPanel?.getBoundingClientRect();

    return {
      found: true,
      settingsRect: { left: sRect.left, right: sRect.right, width: sRect.width },
      idleRect: idleRect ? { left: idleRect.left, top: idleRect.top } : null,
      idleHitPass: idleToggle && idleHit ? settingsAside.contains(idleHit) : false,
      buttons,
      allButtonsPass: buttons.every((b) => b.hitPass),
      tasksRect: tRect ? { left: tRect.left, right: tRect.right } : null,
      previewRect: pRect ? { left: pRect.left, right: pRect.right } : null,
      noOverlap: (!tRect || tRect.right <= sRect.left + 1) && (!pRect || pRect.right <= sRect.left + 1),
    };
  });
  console.log("Settings panel at 1440px measurements:", settingsMeasurements);
  assert.ok(settingsMeasurements.found, "Settings panel must be open");
  assert.ok(settingsMeasurements.idleHitPass, "'Use idle expression' must hit-test to Settings, NOT Tasks!");
  assert.ok(settingsMeasurements.allButtonsPass, "All Settings panel expression and color buttons must be hit-testable");
  assert.ok(settingsMeasurements.noOverlap, "Neither Preview nor Tasks may overlap Settings panel");

  const screenshotSettings = join(screenshotsDir, "bot_settings_open_1440_preview_tasks.png");
  await page.screenshot({ path: screenshotSettings });
  console.log(`Saved screenshot to ${screenshotSettings}`);

  // Close settings panel
  await page.locator('aside button[aria-label="Close settings"]').click();
  await page.waitForTimeout(400);

  console.log("\n========================================================");
  console.log("TEST CASE (8fa5a743 remaining): 1024px drawer chaining on Close & backdrop");
  console.log("========================================================");
  // Open Preview + Tasks at 1440, then resize to 1024
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.setItem("chat-mobile-preview-open", "true");
    localStorage.setItem("chat-tasks-open", "true");
  });
  await page.goto(ui);
  await page.waitForSelector("main");
  await page.locator('button[data-conversation-id="bot-long-name"]').click();
  await page.waitForTimeout(400);

  // Resize to 1024
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(300);

  // Preview is visible. Click "Close quick preview" button
  const closeBtn1024 = page.locator('button[aria-label="Close quick preview"]');
  await closeBtn1024.click();
  await page.waitForTimeout(300);

  // Verify Tasks does NOT pop open!
  const afterClosePreview = await page.evaluate(() => ({
    previewOpen: Boolean(document.querySelector('aside[aria-label="Quick preview panel"]')),
    tasksOpen: Boolean(document.querySelector('aside[aria-label="Tasks"]')),
  }));
  console.log("After clicking Close preview at 1024:", afterClosePreview);
  assert.ok(!afterClosePreview.previewOpen, "Preview must be closed");
  assert.ok(!afterClosePreview.tasksOpen, "Tasks drawer must NOT pop open after closing Preview!");

  // Test backdrop click: re-open both, resize to 1024
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Show mobile preview" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Show tasks" }).click();
  await page.waitForTimeout(200);

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(300);

  // Click the backdrop (e.g. at x=340, y=300)
  const backdrop = page.locator('button.bg-black\\/55');
  await backdrop.click({ position: { x: 50, y: 50 } });
  await page.waitForTimeout(300);

  const afterBackdropClick = await page.evaluate(() => ({
    previewOpen: Boolean(document.querySelector('aside[aria-label="Quick preview panel"]')),
    tasksOpen: Boolean(document.querySelector('aside[aria-label="Tasks"]')),
  }));
  console.log("After clicking backdrop at 1024:", afterBackdropClick);
  assert.ok(!afterBackdropClick.previewOpen && !afterBackdropClick.tasksOpen, "Backdrop click must close drawers back to chat!");

  console.log("\n========================================================");
  console.log("TEST CASE (0d25eafe): 1024px with Settings open & Composer # menu open (Screenshot a)");
  console.log("========================================================");
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("chat-mobile-preview-open", "false");
    localStorage.setItem("chat-tasks-open", "false");
  });
  await page.goto(ui);
  await page.waitForSelector("main");
  await page.locator('button[data-conversation-id="bot-long-name"]').click();
  await page.waitForTimeout(500);

  // Open Settings via bot name button in header
  await page.locator('main button[title="Bot settings"]').click();
  await page.waitForTimeout(1000);

  // Type '#' in composer textarea
  const composerInput = page.locator('main textarea');
  await composerInput.click();
  await composerInput.fill("#");
  await page.waitForTimeout(400);

  // Verify Project suggestion menu is visible and inside main (< 624)
  const hashMenuMeasurements = await page.evaluate(() => {
    const list = document.querySelector('div[role="listbox"][aria-label="Reference a project"]');
    const settingsAside = document.querySelector('aside:has(button[aria-label="Close settings"])');
    if (!list || !settingsAside) return { found: false };
    const lRect = list.getBoundingClientRect();
    const sRect = settingsAside.getBoundingClientRect();

    // elementFromPoint on right edge of list
    const rightHit = document.elementFromPoint(lRect.right - 5, lRect.top + lRect.height / 2);
    const leftHit = document.elementFromPoint(lRect.left + 5, lRect.top + lRect.height / 2);

    return {
      found: true,
      listRect: { left: lRect.left, right: lRect.right, width: lRect.width },
      settingsRect: { left: sRect.left, right: sRect.right, width: sRect.width },
      fitsInMain: lRect.right <= sRect.left + 1,
      rightHitInsideList: list.contains(rightHit),
      leftHitInsideList: list.contains(leftHit),
    };
  });
  console.log("1024px Settings + Composer # menu measurements:", hashMenuMeasurements);
  assert.ok(hashMenuMeasurements.found, "Project suggestion list and Settings panel must both be open");
  assert.ok(hashMenuMeasurements.fitsInMain, "Project suggestion list must fit inside main without clipping");
  assert.ok(hashMenuMeasurements.rightHitInsideList, "Right edge of Project suggestion list must pass elementFromPoint");

  const screenshotA = join(screenshotsDir, "bot_settings_open_1024_composer_hash_menu.png");
  await page.screenshot({ path: screenshotA });
  console.log(`Saved screenshot (a) to ${screenshotA}`);

  // Clear composer text and close Settings via Escape
  await composerInput.fill("");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert.ok(await page.evaluate(() => !document.querySelector('aside:has(button[aria-label="Close settings"])')), "Escape must close Settings panel");

  console.log("\n========================================================");
  console.log("TEST CASE (0d25eafe): 1024px with Computer open & Show tasks visible in header (Screenshot b)");
  console.log("========================================================");
  // Open Computer panel: click HeaderMoreMenu ("More actions"), then "Bot's computer"
  const moreActionsBtn = page.getByRole("button", { name: "More actions" });
  if (await moreActionsBtn.isVisible()) {
    await moreActionsBtn.click();
    await page.waitForTimeout(200);
    await page.getByRole("menuitem", { name: "Bot's computer" }).click();
  } else {
    await page.locator('main button[title="Bot\'s computer"]').click();
  }
  await page.waitForTimeout(800);

  // Measure Computer panel and Show tasks button
  const computerMeasurements = await page.evaluate(() => {
    const computerAside = Array.from(document.querySelectorAll("aside")).find((a) =>
      a.textContent?.includes("Computer") && a.querySelector('button[aria-label="Close computer panel"]'),
    );
    const tasksBtn = document.querySelector('main button[aria-label="Show tasks"], main button[title="Show tasks"]');
    if (!computerAside || !tasksBtn) return { found: false };
    const cRect = computerAside.getBoundingClientRect();
    const tRect = tasksBtn.getBoundingClientRect();
    const center = tRect.left + tRect.width / 2;
    const hit = document.elementFromPoint(center, tRect.top + tRect.height / 2);

    return {
      found: true,
      computerRect: { left: cRect.left, right: cRect.right, width: cRect.width },
      tasksBtnRect: { left: tRect.left, right: tRect.right, width: tRect.width },
      fitsInMain: tRect.right <= cRect.left + 1,
      hitTestPass: tasksBtn.contains(hit),
    };
  });
  console.log("1024px Computer + Show tasks measurements:", computerMeasurements);
  assert.ok(computerMeasurements.found, "Computer panel and Show tasks button must both be open/present");
  assert.ok(computerMeasurements.fitsInMain, "Show tasks button must sit inside main without clipping");
  assert.ok(computerMeasurements.hitTestPass, "Show tasks center must pass elementFromPoint");

  const screenshotB = join(screenshotsDir, "bot_chat_long_name_1024_computer_show_tasks.png");
  await page.screenshot({ path: screenshotB });
  console.log(`Saved screenshot (b) to ${screenshotB}`);

  // Test Escape closes Computer panel and restores focus
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert.ok(await page.evaluate(() => !document.querySelector('aside:has(button[aria-label="Close computer panel"])')), "Escape must close Computer panel");

  console.log("\n========================================================");
  console.log("TEST CASE (0d25eafe): 1024px Preview drawer constrained to max-w-full without left clip");
  console.log("========================================================");
  // Open Preview and Settings at 1024px (using keyboard/dispatch per Dell's note)
  await page.getByRole("button", { name: "Show mobile preview" }).click();
  await page.waitForTimeout(300);
  await page.locator('main button[title="Bot settings"]').dispatchEvent("click");
  await page.waitForTimeout(800);

  const drawer1024Measurements = await page.evaluate(() => {
    const previewDrawer = document.querySelector('aside[aria-label="Quick preview panel"]');
    const mainEl = document.querySelector('main');
    if (!previewDrawer || !mainEl) return { found: false };
    const pRect = previewDrawer.getBoundingClientRect();
    const mRect = mainEl.getBoundingClientRect();
    return {
      found: true,
      mainLeft: mRect.left,
      mainRight: mRect.right,
      mainWidth: mRect.width,
      previewLeft: pRect.left,
      previewRight: pRect.right,
      previewWidth: pRect.width,
      leftNotClipped: pRect.left >= mRect.left - 1,
    };
  });
  console.log("1024px Preview drawer with Settings open measurements:", drawer1024Measurements);
  assert.ok(drawer1024Measurements.found, "Preview drawer and main must exist");
  assert.ok(drawer1024Measurements.leftNotClipped, "Preview drawer left edge must not extend beyond main left edge");

  // Close Settings via Escape
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  console.log("\n========================================================");
  console.log("DESKTOP CHECK: Isolated second Electron instance");
  console.log("========================================================");
  const electronExecutable =
    "/Users/esoefildine/Documents/Dev/GererBuildStudio/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";

  electronApp = await _electron.launch({
    executablePath: electronExecutable,
    args: ["electron/main.mjs", `--user-data-dir=${profile}`],
    env: {
      ...env,
      ELECTRON_START_URL: ui,
      GBS_DATA_DIR: data,
      GBS_PORT: String(apiPort),
    },
  });

  const electronWindow = await electronApp.firstWindow();
  await electronWindow.waitForLoadState("domcontentloaded");
  await electronWindow.evaluate(() => {
    localStorage.setItem("gbs-email-gate", "skipped");
    localStorage.setItem("chat-mobile-preview-open", "true");
    localStorage.setItem("chat-tasks-open", "true");
  });
  await electronWindow.setViewportSize({ width: 1440, height: 900 });
  await electronWindow.goto(ui);
  await electronWindow.waitForSelector("main");

  // Select bot with long name in Electron
  await electronWindow.locator('button[data-conversation-id="bot-long-name"]').click();
  await electronWindow.waitForTimeout(500);

  // Verify More menu in Electron at 1440
  await electronWindow.getByRole("button", { name: "More preview options" }).click();
  await electronWindow.waitForTimeout(300);

  const electronMoreMenu = await electronWindow.evaluate(() => {
    const menu = document.querySelector('div[role="menu"][aria-label="More preview options"]');
    if (!menu) return null;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        text: el.textContent?.trim(),
        hitTestPass: el.contains(hit),
      };
    });
    return {
      allItemsPass: items.length > 0 && items.every((i) => i.hitTestPass),
    };
  });
  console.log("Electron Quick preview More menu:", electronMoreMenu);
  assert.ok(electronMoreMenu?.allItemsPass, "In Electron, Quick preview More menu items must be hit-testable");

  // In Electron: outside dismissal on webview at y=750
  const electronPanelCenter = await electronWindow.evaluate(() => {
    const p = document.querySelector('aside[aria-label="Quick preview panel"]');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  await electronWindow.mouse.click(electronPanelCenter, 750);
  await electronWindow.waitForTimeout(300);
  const electronMoreAfterClick = await electronWindow.evaluate(() => Boolean(document.querySelector('div[role="menu"][aria-label="More preview options"]')));
  assert.ok(!electronMoreAfterClick, "In Electron, clicking webview at y=750 must dismiss More menu");

  // In Electron: Size menu keyboard navigation
  await electronWindow.locator('button[aria-label="Choose preview size"]').focus();
  await electronWindow.keyboard.press("Enter");
  await electronWindow.waitForTimeout(200);
  const electronSizeActive = await electronWindow.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute("role") === "menuitem";
  });
  assert.ok(electronSizeActive, "In Electron, Enter on Choose preview size must focus role='menuitem'");
  await electronWindow.keyboard.press("Escape");
  await electronWindow.waitForTimeout(200);

  // Open Settings in Electron at 1440 with Preview + Tasks open
  const electronBotSettingsTrigger = electronWindow.locator('main button[title="Bot settings"]');
  await electronBotSettingsTrigger.click();
  await electronWindow.waitForTimeout(1000);

  const electronSettings = await electronWindow.evaluate(() => {
    const settingsAside = Array.from(document.querySelectorAll("aside")).find(
      (a) =>
        a.querySelector('button[aria-label="Use idle expression"]') ||
        (a.textContent?.includes("Settings") && a.textContent?.includes("Expression")),
    );
    if (!settingsAside) return { found: false };
    const idleToggle = settingsAside.querySelector('button[aria-label="Use idle expression"]');
    const idleRect = idleToggle?.getBoundingClientRect();
    const idleHit = idleRect
      ? document.elementFromPoint(idleRect.left + idleRect.width / 2, idleRect.top + idleRect.height / 2)
      : null;
    return {
      found: true,
      idleHitPass: idleToggle && idleHit ? settingsAside.contains(idleHit) : false,
    };
  });
  console.log("Electron Settings measurements:", electronSettings);
  assert.ok(electronSettings.found, "Settings must be open in Electron");
  assert.ok(electronSettings.idleHitPass, "In Electron, 'Use idle expression' must hit-test to Settings, NOT Tasks!");

  console.log("PASS: Isolated Electron verification succeeded!");

  console.log("\n========================================================");
  console.log("ALL NEW QA MATRIX VERIFICATIONS COMPLETED SUCCESSFULLY!");
  console.log("========================================================");
} finally {
  if (browser) await browser.close();
  if (electronApp) await electronApp.close();
  for (const child of children) {
    await stop(child);
  }
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch {}
}
