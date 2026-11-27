// The person's journey with app events in a real browser against a real server (temporary home, scripted engine, the
// connected-apps service's code behind a fake Composio): set one up from chat and from + New, see its sentence, its
// events and what it skipped, pause, resume, reconnect and delete. Runs where a Chromium and playwright-core are named:
//   OMB_UI_CHROMIUM=<chrome or headless shell> OMB_UI_PLAYWRIGHT_CORE=<playwright-core dir> OMB_UI_DIST=<vite build dir>
//   [OMB_UI_SHOTS=<folder for screenshots>] vitest run server/app-events.ui.e2e.test.ts
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";

const { OMB_UI_CHROMIUM: chromiumPath, OMB_UI_PLAYWRIGHT_CORE: playwrightPath, OMB_UI_DIST: dist } = process.env;
const shots = process.env.OMB_UI_SHOTS ?? join(process.cwd(), "docs", "screenshots", "automations-app-events");
const ready = Boolean(chromiumPath && playwrightPath && dist);

let broker: BrokerFake;
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let browser: any;
let owner: { id: string; token: string; userId: string };
let gmail = "";

beforeAll(async () => {
  if (!ready) return;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  broker = await startBrokerFake();
  owner = await broker.install();
  gmail = broker.account(owner.userId, "gmail", "sales");
  broker.account(owner.userId, "slack");
  fixture = await launchVerificationServer({ ...process.env, OMB_COMPOSIO_BROKER_URL: broker.url, OMB_COMPOSIO_BROKER_TOKEN: owner.token },
    undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, dist);
  const { chromium } = createRequire(join(playwrightPath!, "package.json"))("playwright-core");
  // A mock keychain keeps the test browser from asking the person's macOS keychain for anything.
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--use-mock-keychain"] });
  mkdirSync(shots, { recursive: true });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
  await broker?.close();
  vi.restoreAllMocks();
});

it.skipIf(!ready)("sets one up from chat and from + New, shows its sentence and events, pauses, resumes, asks to reconnect and deletes", async () => {
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => (await fetch(`${fixture.info.url}${path}`, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json() as Promise<any>;
  await api("PUT", "/api/config", { onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  const { bot } = await cli("new-bot", "--name", "Scout");
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const plan = (steps: unknown[], reply: string) => writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { steps, reply } }));
  plan([
    { tool: "list_trigger_events", arguments: { app: "gmail" } },
    { tool: "create_trigger", arguments: { when: "app_event", name: "Acme replies", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE",
      filter: { from: "acme.com" }, instructions: "Draft a reply to the email in the event data. Do not send it." } },
  ], "Done: when you get an email from Acme, I'll draft a reply for you to check.");

  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  page.on("dialog", (dialog: any) => dialog.accept());
  const shot = (name: string) => page.screenshot({ path: join(shots, name) });
  await page.goto(fixture.info.url);
  await page.getByText("Scout", { exact: true }).first().waitFor();
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
  await page.getByText("Scout", { exact: true }).first().click();

  // 1. From chat.
  const composer = page.locator("textarea").last();
  await composer.fill("When I get an email from Acme, draft a reply.");
  await composer.press("Enter");
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
  const card = page.locator("[data-trigger-card]").first();
  await card.waitFor({ timeout: 30_000 });
  await expect.poll(() => card.textContent(), { timeout: 15_000 }).toContain("When you get an email from acme.com, Scout drafts a reply to the email");
  expect(await card.textContent()).not.toContain("event data");
  expect(await card.textContent()).toContain("Checks every 15 minutes · waiting for the first email");
  await shot("chat-card-set-up.png");

  // 2. An email from Acme arrives at Composio; the card shows the run.
  const remoteId = (await api("GET", "/api/app-triggers")).triggers[0].remote.triggerId as string;
  plan([], "Drafted a reply to Ada about order #1042.");
  await broker.deliver(remoteId, { sender: "Ada <ada@acme.com>", subject: "Where is order #1042?", message_text: "Hi there" });
  await expect.poll(() => card.textContent(), { timeout: 40_000 }).toContain("Drafted a reply to Ada");
  await shot("chat-card-after-event.png");

  // 3. Past today's limit the service keeps nothing more; the panel says how many were skipped.
  broker.setQueuedToday(owner.id, 500);
  for (let index = 0; index < 3; index += 1) await broker.deliver(remoteId, { sender: "bo@acme.com", subject: `Order #${index}` });
  await api("POST", "/api/app-triggers/sync");
  await page.locator('[data-tour="nav-automations"]').first().click();
  const row = page.locator("[data-automation]").first();
  await row.waitFor({ timeout: 15_000 });
  await shot("automations-list.png");
  await row.locator("button").first().click();
  const panel = page.locator('aside[aria-label="Automation"]');
  await panel.waitFor();
  await expect.poll(() => panel.textContent(), { timeout: 15_000 }).toContain("3 skipped today: daily limit");
  expect(await panel.textContent()).toContain("Started a run · From Ada <ada@acme.com> · Where is order #1042?");
  await shot("automation-panel.png");

  // 4. Pause and resume.
  await panel.getByRole("button", { name: "Pause" }).click();
  await expect.poll(async () => (await api("GET", "/api/app-triggers")).triggers[0].enabled, { timeout: 10_000 }).toBe(false);
  await expect.poll(() => panel.textContent(), { timeout: 10_000 }).toContain("Paused");
  await shot("automation-paused.png");
  await panel.getByRole("button", { name: "Resume" }).click();
  await expect.poll(async () => (await api("GET", "/api/app-triggers")).triggers[0].enabled, { timeout: 10_000 }).toBe(true);

  // 5. + New → Set it up yourself → When something happens in an app.
  await page.getByRole("button", { name: "Close" }).first().click().catch(() => {});
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Set it up yourself" }).click();
  await page.getByRole("radio", { name: "When something happens in an app" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const editor = page.getByRole("dialog", { name: "When something happens in an app" });
  await editor.locator('select[aria-label="App"]').waitFor({ timeout: 15_000 });
  await editor.locator('input[placeholder="acme.com"]').fill("globex.com");
  await editor.locator('input[placeholder="order"]').fill("invoice");
  await editor.locator("textarea").fill("File the invoice in the shared folder and tell me the total.");
  await shot("new-app-event-editor.png");
  await editor.getByRole("button", { name: "Set it up" }).click();
  await expect.poll(async () => (await api("GET", "/api/app-triggers")).triggers.length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => page.locator("[data-automation]").count(), { timeout: 10_000 }).toBe(2);
  expect(await page.locator("main").textContent()).toContain("When you get an email from globex.com about “invoice”, Scout files the invoice in the shared folder");
  await shot("automations-two.png");

  // 6. The Gmail connection expires: Needs you, with Reconnect.
  await broker.expire(gmail);
  await expect.poll(() => page.locator('li[data-automation-status="needs-you"]').count(), { timeout: 40_000 }).toBe(2);
  expect(await page.locator("main").textContent()).toContain("Gmail needs to be reconnected.");
  await shot("automations-needs-you.png");

  // 7. Delete from the panel.
  const first = page.locator("[data-automation]").first();
  await first.locator("button").first().click();
  await page.locator('aside[aria-label="Automation"]').getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await api("GET", "/api/app-triggers")).triggers.length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => page.locator("[data-automation]").count(), { timeout: 10_000 }).toBe(1);
  await shot("automations-after-delete.png");
  await page.close();
}, 240_000);
