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
  console.log("TEST CASE (a): Bot chat with LONG name at 1440, Preview + Tasks open");
  console.log("========================================================");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.setItem("chat-mobile-preview-open", "true");
    localStorage.setItem("chat-tasks-open", "true");
  });
  await page.goto(ui);
  await page.waitForSelector("main");

  // Select the bot with long name
  await page.locator('button[data-conversation-id="bot-long-name"]').click();
  await page.waitForTimeout(500);

  // Verify header rect & Hide tasks button rect
  const caseAMeasurements = await page.evaluate(() => {
    const header = document.querySelector("main section > div:first-child");
    const hideTasksBtn = Array.from(header.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Hide tasks" || b.getAttribute("title") === "Hide tasks",
    );
    const hRect = header.getBoundingClientRect();
    const tRect = hideTasksBtn.getBoundingClientRect();
    const scrollWidth = document.documentElement.scrollWidth;
    const innerWidth = window.innerWidth;

    // elementFromPoint check
    const ptLeft = document.elementFromPoint(tRect.left + 5, tRect.top + tRect.height / 2);
    const ptRight = document.elementFromPoint(tRect.right - 5, tRect.top + tRect.height / 2);

    return {
      header: { left: hRect.left, right: hRect.right, width: hRect.width },
      hideTasks: { left: tRect.left, right: tRect.right, width: tRect.width },
      uncut: tRect.right <= hRect.right + 0.5,
      marginRemaining: hRect.right - tRect.right,
      scrollWidthMatches: scrollWidth === innerWidth,
      scrollWidth,
      innerWidth,
      ptLeftTag: ptLeft?.tagName,
      ptRightTag: ptRight?.tagName,
      hitTestPass: hideTasksBtn.contains(ptLeft) && hideTasksBtn.contains(ptRight),
    };
  });

  console.log("Case (a) measurements:", caseAMeasurements);
  assert.ok(caseAMeasurements.uncut, `Hide tasks right (${caseAMeasurements.hideTasks.right}) exceeds header right (${caseAMeasurements.header.right})`);
  assert.ok(caseAMeasurements.hitTestPass, "elementFromPoint hit test failed on Hide tasks button");
  assert.ok(caseAMeasurements.scrollWidthMatches, "Horizontal document overflow detected");

  const screenshotPathA = join(screenshotsDir, "bot_chat_long_name_1440_preview_tasks.png");
  await page.screenshot({ path: screenshotPathA });
  console.log(`Saved screenshot (a) to ${screenshotPathA}`);

  console.log("\n========================================================");
  console.log("TEST CASE (b): Same layout with More actions menu OPEN");
  console.log("========================================================");
  const moreBtn = page.getByRole("button", { name: "More actions" });
  await moreBtn.click();
  await page.waitForTimeout(200);

  const caseBMeasurements = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"][aria-label="More actions"]');
    const items = menu ? Array.from(menu.querySelectorAll('[role="menuitem"]')) : [];
    const header = document.querySelector("main section > div:first-child");
    const mRect = menu.getBoundingClientRect();

    const itemHits = items.map((it) => {
      const rect = it.getBoundingClientRect();
      const pt = document.elementFromPoint(rect.left + 10, rect.top + rect.height / 2);
      return {
        text: it.textContent?.trim(),
        rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
        hit: it.contains(pt),
      };
    });

    return {
      menuCount: items.length,
      menuRect: { top: mRect.top, bottom: mRect.bottom, right: mRect.right },
      headerScrollTop: header.scrollTop,
      itemHits,
      allHitPass: itemHits.length === 2 && itemHits.every((h) => h.hit),
    };
  });

  console.log("Case (b) measurements:", caseBMeasurements);
  assert.equal(caseBMeasurements.menuCount, 2, "Expected 2 items in More menu");
  assert.ok(caseBMeasurements.allHitPass, "More menu items must be fully visible and hit-testable via elementFromPoint");
  assert.equal(caseBMeasurements.headerScrollTop, 0, "Header scrollTop must stay 0");

  const screenshotPathB = join(screenshotsDir, "bot_chat_long_name_1440_more_menu_open.png");
  await page.screenshot({ path: screenshotPathB });
  console.log(`Saved screenshot (b) to ${screenshotPathB}`);

  // Test keyboard navigation for More menu (Item 3: e425564e)
  console.log("Verifying More menu keyboard accessibility (e425564e)...");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);

  // Focus trigger and press Enter
  await moreBtn.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);

  const focusedFirst = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute("role") === "menuitem" && active?.textContent?.includes("Schedule run");
  });
  assert.ok(focusedFirst, "Opening menu via keyboard must focus the first menuitem");

  // ArrowDown to second item
  await page.keyboard.press("ArrowDown");
  const focusedSecond = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute("role") === "menuitem" && active?.textContent?.includes("Bot's computer");
  });
  assert.ok(focusedSecond, "ArrowDown must move focus to second menuitem");

  // ArrowUp back to first
  await page.keyboard.press("ArrowUp");
  const focusedBackFirst = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute("role") === "menuitem" && active?.textContent?.includes("Schedule run");
  });
  assert.ok(focusedBackFirst, "ArrowUp must move focus back to first menuitem");

  // Escape closes and restores focus to More actions button
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const returnedFocus = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute("aria-label") === "More actions";
  });
  assert.ok(returnedFocus, "Escape must close menu and return focus to More actions trigger");

  console.log("PASS: More menu keyboard accessibility verified 100%!");

  console.log("\n========================================================");
  console.log("TEST CASE (c): Model picker open at 1280 + Tasks");
  console.log("========================================================");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    localStorage.setItem("chat-mobile-preview-open", "false");
    localStorage.setItem("chat-tasks-open", "true");
  });
  await page.goto(ui);
  await page.waitForSelector("main");
  await page.locator('button[data-conversation-id="bot-long-name"]').click();
  await page.waitForTimeout(500);

  // Open model picker
  const modelPickerBtn = page.getByRole("button", { name: /^Model:/i });
  await modelPickerBtn.click();
  await page.waitForTimeout(300);

  const caseCMeasurements = await page.evaluate(() => {
    const header = document.querySelector("main section > div:first-child");
    const hideTasksBtn = Array.from(header.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Hide tasks" || b.getAttribute("title") === "Hide tasks",
    );
    const hRect = header.getBoundingClientRect();
    const tRect = hideTasksBtn.getBoundingClientRect();

    const popup = document.querySelector("[data-model-picker-content]");
    const pRect = popup?.getBoundingClientRect();

    // Check hit test on items inside model picker popup
    const buttonOnRail = popup?.querySelector("button");
    const bRect = buttonOnRail?.getBoundingClientRect();
    const pt = bRect ? document.elementFromPoint(bRect.left + 10, bRect.top + bRect.height / 2) : null;

    return {
      header: { left: hRect.left, right: hRect.right, width: hRect.width },
      hideTasks: { left: tRect.left, right: tRect.right },
      uncut: tRect.right <= hRect.right + 0.5,
      popupRect: pRect ? { top: pRect.top, bottom: pRect.bottom, width: pRect.width, height: pRect.height } : null,
      popupHTML: popup?.innerHTML,
      buttonOnRailHit: buttonOnRail ? buttonOnRail.contains(pt) : false,
      ptTag: pt?.tagName,
    };
  });

  console.log("Case (c) measurements:", caseCMeasurements);
  assert.ok(caseCMeasurements.uncut, "Hide tasks button must not be cut off at 1280 + Tasks");
  assert.ok(caseCMeasurements.buttonOnRailHit, "Model picker buttons must be hit-testable via elementFromPoint");

  const screenshotPathC = join(screenshotsDir, "model_picker_open_1280_tasks.png");
  await page.screenshot({ path: screenshotPathC });
  console.log(`Saved screenshot (c) to ${screenshotPathC}`);

  // Close model picker
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);

  console.log("\n========================================================");
  console.log("TEST CASE (d): Six-member room at 1280 + Tasks");
  console.log("========================================================");
  await page.locator('button[data-conversation-id="group-six-members"]').click();
  await page.waitForTimeout(500);

  const caseDMeasurements = await page.evaluate(() => {
    const header = document.querySelector("main section > div:first-child");
    const allButtons = Array.from(header.querySelectorAll("button")).map((b) => ({
      ariaLabel: b.getAttribute("aria-label"),
      title: b.getAttribute("title"),
      text: b.textContent?.trim(),
    }));
    const hideTasksBtn = Array.from(header.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label")?.includes("tasks") || b.getAttribute("title")?.includes("tasks"),
    );
    const hRect = header.getBoundingClientRect();
    const tRect = hideTasksBtn?.getBoundingClientRect();

    const pt = tRect ? document.elementFromPoint(tRect.left + 5, tRect.top + tRect.height / 2) : null;

    return {
      allButtons,
      header: { left: hRect.left, right: hRect.right, width: hRect.width },
      hideTasks: tRect ? { left: tRect.left, right: tRect.right } : null,
      uncut: tRect ? tRect.right <= hRect.right + 0.5 : false,
      hitTestPass: hideTasksBtn && pt ? hideTasksBtn.contains(pt) : false,
    };
  });

  console.log("Case (d) measurements:", caseDMeasurements);
  assert.ok(caseDMeasurements.uncut, "Hide tasks button must not be cut off in six-member room at 1280 + Tasks");
  assert.ok(caseDMeasurements.hitTestPass, "elementFromPoint hit test failed on Hide tasks in room");

  const screenshotPathD = join(screenshotsDir, "room_six_members_1280_tasks.png");
  await page.screenshot({ path: screenshotPathD });
  console.log(`Saved screenshot (d) to ${screenshotPathD}`);

  console.log("\n========================================================");
  console.log("VERIFYING ITEM 4 (8fa5a743): Tasks divider & 1024 drawer Escape");
  console.log("========================================================");

  // Switch back to bot chat
  await page.locator('button[data-conversation-id="bot-long-name"]').click();
  await page.waitForTimeout(300);

  // Open tasks panel to inspect header divider
  const showTasksBtn = page.locator('button[aria-label="Show tasks"]');
  if ((await showTasksBtn.count()) > 0) {
    await showTasksBtn.click();
    await page.waitForTimeout(300);
  }

  // Check Tasks divider bottom at 60px
  const dividerY = await page.evaluate(() => {
    const tasksHeader = document.querySelector('aside[aria-label="Tasks"] > div > div:first-child');
    return tasksHeader?.getBoundingClientRect().bottom;
  });
  console.log("Tasks 60px header bottom Y:", dividerY);
  assert.equal(Math.round(dividerY), 60, "Tasks header divider bottom must be at y=60");

  // Test 1024 drawer Escape & chaining in bot chat
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(300);

  // At 1024px, Tasks is currently open as a drawer
  const tasksDrawerOpen = await page.evaluate(() => Boolean(document.querySelector('aside[aria-label="Tasks"]')));
  assert.ok(tasksDrawerOpen, "Tasks drawer must be open at 1024px");

  // Press Escape -> Tasks drawer closes back to chat
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const afterTasksEscape = await page.evaluate(() => ({
    tasksOpen: Boolean(document.querySelector('aside[aria-label="Tasks"]')),
    previewOpen: Boolean(document.querySelector('aside[aria-label="Mobile preview"]')),
  }));
  console.log("After Escape on Tasks drawer at 1024px:", afterTasksEscape);
  assert.ok(!afterTasksEscape.tasksOpen && !afterTasksEscape.previewOpen, "Escape must close Tasks drawer back to chat");

  // Now open Preview drawer
  await page.getByRole("button", { name: "Show mobile preview" }).click();
  await page.waitForTimeout(300);

  const previewDrawerOpen = await page.evaluate(() => Boolean(document.querySelector('aside[aria-label="Quick preview panel"]')));
  assert.ok(previewDrawerOpen, "Preview drawer must open at 1024px");

  // Press Escape -> Preview drawer closes back to chat
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const afterPreviewEscape = await page.evaluate(() => ({
    previewOpen: Boolean(document.querySelector('aside[aria-label="Quick preview panel"]')),
    tasksOpen: Boolean(document.querySelector('aside[aria-label="Tasks"]')),
  }));
  console.log("After Escape on Preview drawer at 1024px:", afterPreviewEscape);
  assert.ok(!afterPreviewEscape.previewOpen && !afterPreviewEscape.tasksOpen, "Escape must close Preview drawer back to chat");

  console.log("PASS: All browser test cases verified!");

  // Now test in an isolated Electron instance!
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

  const electronCaseA = await electronWindow.evaluate(() => {
    const header = document.querySelector("main section > div:first-child");
    const hideTasksBtn = Array.from(header.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Hide tasks" || b.getAttribute("title") === "Hide tasks",
    );
    const hRect = header.getBoundingClientRect();
    const tRect = hideTasksBtn?.getBoundingClientRect();

    return {
      headerRight: hRect.right,
      hideTasksRight: tRect?.right,
      uncut: tRect ? tRect.right <= hRect.right + 0.5 : false,
    };
  });
  console.log("Electron Case (a) measurements:", electronCaseA);
  assert.ok(electronCaseA.uncut, "In Electron, Hide tasks button must not be cut off");

  console.log("PASS: Electron isolated verification succeeded!");

  console.log("\n========================================================");
  console.log("ALL VERIFICATIONS COMPLETED SUCCESSFULLY!");
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
