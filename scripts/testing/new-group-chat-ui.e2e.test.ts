// Sidebar → New group chat in the real app over the fake engine: the person picks the bots, presses one button and is in
// the room with the message box focused, and the first plain message is answered with no @mention and no setup form.
// Run with OMB_UI_E2E=1 (or with the pinned browser already installed).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { launchVerificationServer } from "../control-omb.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import type { HeadlessPage } from "./headless-chrome.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping the new group chat UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

const COMPOSER = `document.querySelector('main textarea[aria-label="Message Otto & Juniper"]')`;
const clickByText = (selector: string, text: string) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) || e.getAttribute("aria-label") === ${JSON.stringify(text)}); el?.click(); return Boolean(el); })()`;

(enabled ? it : it.skip)("picks the bots, lands in the room ready to type, and gets an answer to the first message", async () => {
  const { chrome } = await ensureUiBrowser();
  if (chrome && !process.env.OMB_CDP_CHROME) process.env.OMB_CDP_CHROME = chrome;
  const { openHeadlessChrome } = await import("./headless-chrome.ts");
  const fixture = await launchVerificationServer(process.env);
  const profile = mkdtempSync(join(tmpdir(), "omb-new-group-chrome-"));
  let preview: MountedPreview | undefined, page: HeadlessPage | undefined;
  try {
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    for (const bot of ((await api("GET", "/api/bots")).bots as Array<{ id: string; defaultBot?: object }>).filter((one) => one.defaultBot)) {
      await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    }
    const otto = (await api("POST", "/api/bots", { name: "Otto", color: "teal" })).bot as { id: string };
    await api("POST", "/api/bots", { name: "Juniper", color: "purple" });
    preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "New group chat", logLevel: "warn" });
    page = await openHeadlessChrome(profile);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: preview.previewUrl });
    await page.until("Boolean(document.querySelector('[data-sidebar-bot-row]'))", 300_000);

    await page.until(clickByText("button", "New or share"), 20_000);
    await page.until(clickByText("[role=menuitem]", "New group chat"), 10_000);
    await page.until("Boolean(document.querySelector('[role=dialog] button[role=checkbox]'))", 10_000);
    expect(await page.evaluate("document.querySelectorAll('[role=dialog] input, [role=dialog] textarea').length")).toBe(0);
    for (const name of ["Otto", "Juniper"]) await page.until(clickByText("button[role=checkbox]", name), 10_000);
    await page.until(clickByText("button", "Create group chat"), 10_000);

    await page.until(`Boolean(${COMPOSER}) && document.activeElement === ${COMPOSER}`, 30_000);
    expect(await page.evaluate("document.querySelector('[data-room-name]')?.textContent")).toBe("Otto & Juniper");
    const room = ((await api("GET", "/api/bots")).groups as Array<{ name: string; defaultResponder: unknown; setupCompletedAt: unknown }>).find((group) => group.name === "Otto & Juniper");
    expect(room).toMatchObject({ defaultResponder: { kind: "member", botId: otto.id }, setupCompletedAt: expect.any(Number) });

    await page.send("Input.insertText", { text: "What should we plan first?" });
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.until("/hello from fake claude/.test(document.querySelector('[role=log]')?.textContent ?? '')", 60_000);
    expect(await page.evaluate("document.querySelector('[role=log]').textContent.includes('What should we plan first?')")).toBe(true);
  } finally {
    page?.close();
    await page?.exited(10_000);
    await preview?.close();
    await fixture.close();
    rmSync(profile, { recursive: true, force: true });
  }
}, 600_000);
