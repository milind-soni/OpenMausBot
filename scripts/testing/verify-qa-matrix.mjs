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
