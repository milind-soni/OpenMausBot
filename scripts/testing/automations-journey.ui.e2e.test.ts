// Automations as a person uses them, end to end in the real app: the real server and its webhook receiver in a
// temporary home, a scripted engine that obeys tool calls, the real renderer in headless Chrome. Every step leaves a
// screenshot. Run with OMB_UI_E2E=1; OMB_AUTOMATIONS_JOURNEY_SHOTS=DIR keeps the screenshots there.
import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { cloudHomeChildEnvironments, spawnWithSecrets } from "../../server/cloud-home-start.ts";
import { cloudHomeConfiguration, cloudPairingSignature } from "../../server/cloud-home.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { launchRestartableServer, type RestartableServer } from "../../server/testing/restartable-server.ts";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, type UiHandle } from "./control-omb-ui.ts";
import { mountPreview } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHOTS = process.env.OMB_AUTOMATIONS_JOURNEY_SHOTS || join(ROOT, ".omb-scratch", "automations-journey");
const SHORT_TMP = process.platform === "win32" ? tmpdir() : "/tmp";
const enabled = process.env.OMB_UI_E2E === "1";

const SCHEDULE = "Every day at 9 AM, Scout sends you a summary of your inbox";
const EDITED = "Every day at 10:30 AM, Scout sends you a summary of your inbox and your calendar";
const FORM = "When your sales form sends something, Scout drafts a follow-up for the lead";
const FAILING = "Every day at 5 PM, Scout checks the sales inbox";

/** What each bot does when it is asked something, and when one of its automations runs. */
function plan(bots: Array<{ id: string }>) {
  const script = [
    { key: "schedule", match: ["every morning, summarize my inbox"], repeat: true, steps: [{ tool: "create_trigger", arguments: { when: "schedule", name: "Morning inbox summary", instructions: "Send me a summary of my inbox.", schedule: { type: "daily", time: "09:00" } } }], reply: "Done. Every morning at 9 I'll send you a summary of your inbox." },
    { key: "webhook", match: ["form sends a lead"], repeat: true, steps: [{ tool: "create_trigger", arguments: { when: "webhook", name: "Sales form leads", instructions: "Draft a follow-up for the lead." } }], reply: "Set up. Paste the address into your form tool." },
    { key: "failing", match: ["every day at 5pm, check the sales inbox"], repeat: true, steps: [{ tool: "create_trigger", arguments: { when: "schedule", name: "Sales inbox check", instructions: "Check the sales inbox.", schedule: { type: "daily", time: "17:00" } } }], reply: "I'll check it every day at 5." },
    { key: "weekly", match: ["every friday at 4pm, send me a weekly report"], repeat: true, steps: [{ tool: "create_trigger", arguments: { when: "schedule", name: "Weekly report", instructions: "Send me a weekly report.", schedule: { type: "weekly", time: "16:00", weekdays: ["friday"] } } }], reply: "Every Friday at 4." },
    { key: "run-summary", match: ["Send me a summary of my inbox"], repeat: true, steps: [], reply: "Inbox: 3 new emails, nothing urgent." },
    { key: "run-lead", match: ["Draft a follow-up for the lead."], repeat: true, steps: [], reply: "Drafted a follow-up for Ada." },
    { key: "run-failing", match: ["Check the sales inbox."], repeat: true, steps: [], failWith: "Not logged in · Please run /login" },
    { key: "run-hourly", match: ["Count the new leads."], repeat: true, steps: [], reply: "4 new leads." },
    { key: "chat", match: [""], repeat: true, steps: [], reply: "OK." },
  ];
  return Object.fromEntries(bots.map((bot) => [bot.id, { script }]));
}

type App = Awaited<ReturnType<typeof openApp>>;

/** The real renderer on `server` in headless Chrome, and what a person does with it. */
async function openApp(server: { url: string; port: number; dataDir: string; logPath: string }, options: { shots: string; bots: Record<string, string>; proxyHeaders?: Record<string, string> }) {
  mkdirSync(options.shots, { recursive: true });
  const tools = await ensureUiBrowser(process.env);
  const preview = await mountPreview({ info: { url: server.url } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Automations journey", logLevel: "warn", proxyHeaders: options.proxyHeaders });
  const handle: UiHandle = { url: server.url, previewUrl: preview.previewUrl, session: `omb-journey-${server.port}`, binary: tools.binary, home: server.dataDir, botId: Object.values(options.bots)[0]!, logPath: server.logPath, chrome: tools.chrome };
  const browserEnv = sessionEnv(handle);
  const browser = (...args: string[]) => agentBrowser(tools.binary, browserEnv, args, 120_000);
  await browser("set", "viewport", "1280", "800");
  await browser("open", preview.previewUrl);
  const handlePath = join(server.dataDir, "ui.json");
  writeFileSync(handlePath, JSON.stringify(handle));
  const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handlePath, ...args]) as Promise<Record<string, any>>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const click = (name: string) => ui("click", "--name", name);
  let shot = 0;
  const screenshot = async (name: string) => { await new Promise((resolve) => setTimeout(resolve, 300)); await ui("screenshot", "--out", join(options.shots, `${String(++shot).padStart(2, "0")}-${name}.png`)); };
  const text = (selector = "main") => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`) as Promise<string>;
  /** Clicks the button with this exact text inside the first element matching `scope`. */
  const clickIn = async (scope: string, label: string) => {
    const found = await evaluate(`(() => { const button = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)}); button?.click(); return Boolean(button); })()`);
    expect(found, `${label} in ${scope}`).toBe(true);
  };
  const fill = (selector: string, value: string) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event("input", { bubbles: true })); return field.value; })()`);
  const select = (label: string, option: string) => evaluate(`(() => { const field = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); field.value = [...field.options].find((candidate) => candidate.textContent === ${JSON.stringify(option)}).value; field.dispatchEvent(new Event("change", { bubbles: true })); return field.value; })()`);
  const row = (sentence: string) => `[...document.querySelectorAll("[data-automation]")].find((item) => item.innerText.includes(${JSON.stringify(sentence)}))`;
  const rowText = (sentence: string) => evaluate(`${row(sentence)}?.innerText ?? ""`) as Promise<string>;
  const rowStatus = (sentence: string) => evaluate(`${row(sentence)}?.dataset.automationStatus ?? "gone"`) as Promise<string>;
  const flip = (sentence: string) => evaluate(`(() => { const toggle = ${row(sentence)}?.querySelector("[role=switch]"); toggle?.click(); return toggle?.getAttribute("aria-checked") ?? null; })()`);
  const switchState = (sentence: string) => evaluate(`${row(sentence)}?.querySelector("[role=switch]")?.getAttribute("aria-checked") ?? null`) as Promise<string | null>;
  /** Opens an automation from its row: the row's title is its name, with the sentence beneath. */
  const openRow = async (sentence: string) => {
    const found = await evaluate(`(() => { const button = ${row(sentence)}?.querySelector("button"); button?.click(); return Boolean(button); })()`);
    expect(found, sentence).toBe(true);
  };
  const panel = () => text('aside[aria-label="Automation"]');
  const card = (sentence: string) => `[...document.querySelectorAll("[data-trigger-card]")].find((item) => item.innerText.includes(${JSON.stringify(sentence)}))`;
  const cardText = (sentence: string) => evaluate(`${card(sentence)}?.innerText ?? ""`) as Promise<string>;
  const clickCard = (sentence: string, label: string) => evaluate(`(() => { const button = [...(${card(sentence)}?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)}); button?.click(); return Boolean(button); })()`);
  const reload = async () => { await evaluate("location.reload(); true"); await expect.poll(() => evaluate("Boolean(document.querySelector('nav'))"), { timeout: 30_000 }).toBe(true); };
  const openAutomations = async () => {
    // A narrow window keeps the sidebar behind its menu button.
    await evaluate(`document.querySelector('button[aria-label="Open bot list"]')?.click(); true`);
    await expect.poll(() => evaluate(`(() => { const entry = [...document.querySelectorAll("nav button")].find((button) => button.textContent.trim() === "Automations"); entry?.click(); return Boolean(entry); })()`)).toBe(true);
    await expect.poll(() => text("main h1"), { timeout: 15_000 }).toBe("Automations");
  };
  /** Opens a bot's chat; with `thread`, that conversation, as a person would from the bot's thread list. */
  const openChat = async (bot: string, thread?: string) => {
    const id = options.bots[bot];
    await expect.poll(() => evaluate(`(() => { const row = document.querySelector('[data-sidebar-bot-row="${id}"]'); row?.click(); return Boolean(row); })()`), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => evaluate("document.querySelector('textarea')?.getAttribute('placeholder') ?? ''"), { timeout: 15_000 }).toBe(`Message ${bot}`);
    if (!thread || (await text()).includes(thread)) return;
    await evaluate(`document.querySelector('button[aria-label="Expand ${bot} threads"]')?.click(); true`);
    await expect.poll(() => evaluate(`(() => { const botRow = document.querySelector('[data-sidebar-bot-row="${id}"]'); const row = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === ${JSON.stringify(thread)} && (botRow.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)); row?.click(); return Boolean(row); })()`)).toBe(true);
    await expect.poll(() => text(), { timeout: 15_000 }).toContain(thread);
  };
  const say = async (bot: string, message: string, thread?: string) => { await openChat(bot, thread); await ui("type", "--name", `Message ${bot}`, "--text", message); await ui("press", "--keys", "Enter"); };
  const noOverflow = async (where: string) => expect(await evaluate("document.scrollingElement.scrollWidth - window.innerWidth"), `horizontal overflow on ${where}`).toBeLessThanOrEqual(1);
  const close = async () => {
    await browser("close").catch(() => {});
    await preview.close();
  };
  return { ui, evaluate, click, screenshot, text, clickIn, fill, select, rowText, rowStatus, flip, switchState, openRow, panel, card, cardText, clickCard, reload, openAutomations, openChat, say, noOverflow, browser, close };
}

(enabled ? it : it.skip)("a person sets up, uses, pauses, edits, breaks, deletes and restarts automations in the real app", async () => {
  let server: RestartableServer | undefined;
  let app: App | undefined;
  try {
    server = await launchRestartableServer({ scripted: true, dataDirRoot: SHORT_TMP });
    const live = server;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${live.url}${path}`, { method, headers: { "content-type": "application/json", origin: live.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json() as any;
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const starter = (await api("GET", "/api/bots?messages=0")).bots[0];
    await api("PATCH", `/api/bots/${starter.id}/profile`, { name: "Hazel" });
    const newBot = async (name: string) => ((await runControlOmb(["new-bot", "--name", name, "--url", live.url])) as { bot: { id: string } }).bot.id;
    const scout = await newBot("Scout");
    const ledger = await newBot("Ledger");
    writeFileSync(live.planPath, JSON.stringify(plan([{ id: starter.id }, { id: scout }, { id: ledger }])));

    app = await openApp(live, { shots: SHOTS, bots: { Scout: scout, Ledger: ledger } });
    const { ui, evaluate, click, screenshot, text, clickIn, fill, select, rowText, rowStatus, flip, switchState, openRow, panel, card, cardText, clickCard, reload, openAutomations, openChat, say, noOverflow, browser } = app;
    const MAIN = "every morning, summarize my inbox";
    const state = async () => ({ ...(await api("GET", "/api/routines")), ...(await api("GET", "/api/webhooks")) }) as { routines: any[]; runs: any[]; webhooks: any[]; attempts: any[] };

    // 1. Empty state → Try → the New box → pick a bot → Set it up → the conversation → the one-line card → the list.
    await openAutomations();
    await expect.poll(() => text()).toContain("Your bots can do things on their own.");
    await screenshot("empty");
    await click("Try: every morning, summarize my inbox");
    await expect.poll(() => text("[role=dialog]")).toContain("Who should do it?");
    await select("Who should do it?", "Scout");
    await screenshot("new-box");
    await click("Set it up");
    await expect.poll(() => cardText(SCHEDULE), { timeout: 30_000 }).toContain("Next: today 9:00 AM");
    expect(await cardText(SCHEDULE)).toMatch(/^Set up: Every day at 9 AM, Scout sends you a summary of your inbox\nNext: (today|tomorrow) 9:00 AM/);
    await screenshot("chat-card");
    await openAutomations();
    await expect.poll(() => rowText(SCHEDULE)).toMatch(/Working · hasn't run yet · next: (today|tomorrow) 9:00 AM/);
    await screenshot("list-one");

    // 2. From chat: "whenever our form sends a lead" → the card → Copy address → a real call with the right secret runs
    // it, a wrong secret is turned away, and More lists both.
    await say("Scout", "whenever our form sends a lead, draft a follow-up");
    await expect.poll(() => cardText(FORM), { timeout: 30_000 }).toContain("Hasn't run yet");
    await evaluate("window.__copied = []; navigator.clipboard.writeText = async (value) => { window.__copied.push(value); }; true");
    expect(await clickCard(FORM, "Copy address")).toBe(true);
    await expect.poll(() => evaluate("window.__copied.length")).toBe(1);
    const address = await evaluate("window.__copied[0]") as string;
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/wh_[\w-]+\/whsec_[\w-]+$/);
    expect(await cardText(FORM)).toContain("Copied");
    await screenshot("webhook-card-copied");
    const lead = { lead: "Ada Lovelace", email: "ada@example.com", message: "Interested in the Pro plan" };
    const accepted = await fetch(address, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lead) });
    expect(accepted.status).toBe(202);
    await expect.poll(() => cardText(FORM), { timeout: 30_000 }).toMatch(/Last ran today [^\n]* ✓ Drafted a follow-up for Ada\./);
    await screenshot("webhook-ran");
    const wrong = await fetch(address.replace(/whsec_[\w-]+$/, "whsec_not-the-secret"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(wrong.status).toBe(401);
    await openAutomations();
    await expect.poll(() => rowText(FORM)).toMatch(/Working · last ran today/);
    await openRow(FORM);
    await expect.poll(panel).toMatch(/recent runs/i);
    await evaluate(`document.querySelector('aside[aria-label="Automation"] details summary').click(); true`);
    await expect.poll(() => text('aside[aria-label="Automation"] details')).toContain("Recent calls");
    const calls = await evaluate(`[...document.querySelectorAll('aside[aria-label="Automation"] [data-call]')].map((item) => item.innerText.replace(/\\n/g, " "))`) as string[];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/✗ Wrong secret$/);
    expect(calls[1]).toMatch(/✓ Received$/);
    expect(await text('aside[aria-label="Automation"] section[aria-label="Last thing it received"]')).toContain('"lead": "Ada Lovelace"');
    expect(await text('aside[aria-label="Automation"] details')).toContain("Secret: ••••••••");
    expect(await evaluate(`document.querySelector('aside[aria-label="Automation"]').innerHTML.includes("whsec_")`), "the secret stays masked when More opens").toBe(false);
    await evaluate(`document.querySelectorAll('aside[aria-label="Automation"] [data-call] button')[1].click(); true`);
    await expect.poll(() => evaluate(`document.querySelectorAll('aside[aria-label="Automation"] [data-call]')[1].querySelector("pre")?.innerText ?? ""`)).toContain('"email": "ada@example.com"');
    await screenshot("more-recent-calls");
    await click("Close");

    // 3. Off and back on: the list switch, the panel's Pause and Resume, the chat card's Pause and Resume — each one
    // changes the switch, the status word and the next time, and survives a reload.
    for (const sentence of [SCHEDULE, FORM]) {
      expect(await flip(sentence)).toBe("true");
      await expect.poll(() => switchState(sentence)).toBe("false");
      await expect.poll(() => rowStatus(sentence)).toBe("paused");
      expect(await rowText(sentence)).toMatch(/^.+\nPaused · /);
      expect(await rowText(sentence)).not.toContain("next:");
      if (sentence === SCHEDULE) await screenshot("list-switched-off");
      await reload();
      await openAutomations();
      expect(await rowStatus(sentence)).toBe("paused");
      expect(await flip(sentence)).toBe("false");
      await expect.poll(() => rowStatus(sentence)).toBe("working");
      if (sentence === SCHEDULE) expect(await rowText(sentence)).toMatch(/Working · hasn't run yet · next: (today|tomorrow) 9:00 AM/);
      await reload();
      await openAutomations();
      expect(await rowStatus(sentence)).toBe("working");
      expect(await switchState(sentence)).toBe("true");
    }
    await screenshot("list-switched-back-on");
    expect((await state()).routines[0]).toMatchObject({ enabled: true });
    expect((await state()).webhooks[0]).toMatchObject({ enabled: true });

    await openRow(SCHEDULE);
    await clickIn('aside[aria-label="Automation"]', "Pause");
    await expect.poll(panel).toMatch(/^.+\nPaused\n/);
    await expect.poll(() => rowText(SCHEDULE)).toMatch(/Paused · /);
    await screenshot("panel-paused");
    await reload();
    await openAutomations();
    await openRow(SCHEDULE);
    expect(await panel()).toMatch(/^.+\nPaused\n/);
    await clickIn('aside[aria-label="Automation"]', "Resume");
    await expect.poll(panel).toMatch(/^.+\nWorking\n/);
    await expect.poll(() => rowText(SCHEDULE)).toMatch(/next: (today|tomorrow) 9:00 AM/);
    await click("Close");

    await openChat("Scout", MAIN);
    expect(await clickCard(SCHEDULE, "Pause")).toBe(true);
    await expect.poll(() => cardText(SCHEDULE)).toMatch(/\nPaused\nResume/);
    await screenshot("chat-card-paused");
    await reload();
    await openChat("Scout", MAIN);
    await expect.poll(() => cardText(SCHEDULE)).toMatch(/\nPaused\nResume/);
    expect(await clickCard(SCHEDULE, "Resume")).toBe(true);
    await expect.poll(() => cardText(SCHEDULE)).toMatch(/\nNext: (today|tomorrow) 9:00 AM\nPause/);
    expect(await clickCard(FORM, "Pause")).toBe(true);
    await expect.poll(() => cardText(FORM)).toMatch(/\nPaused\nResume/);
    expect(await clickCard(FORM, "Resume")).toBe(true);
    await expect.poll(() => cardText(FORM)).toMatch(/Last ran today [^\n]* ✓ Drafted a follow-up for Ada\.\nPause/);

    // 4. Run now; Edit the time and the instructions; the sentence follows.
    await openAutomations();
    await openRow(SCHEDULE);
    await clickIn('aside[aria-label="Automation"]', "Run now");
    await expect.poll(panel, { timeout: 30_000 }).toMatch(/Today [^\n]*\n✓\nInbox: 3 new emails, nothing urgent\./);
    await expect.poll(() => rowText(SCHEDULE)).toMatch(/Working · last ran today [^·]+ · next: /);
    await screenshot("run-now");
    await clickIn('aside[aria-label="Automation"]', "Edit");
    await expect.poll(() => text("[role=dialog]")).toContain("Edit automation");
    await fill("[role=dialog] input[type=time]", "10:30");
    await fill("[role=dialog] textarea", "Send me a summary of my inbox and my calendar.");
    await screenshot("edit");
    await clickIn("[role=dialog]", "Save");
    await expect.poll(() => evaluate("Boolean(document.querySelector('[role=dialog]'))")).toBe(false);
    await expect.poll(() => rowText(EDITED)).toMatch(/next: (today|tomorrow) 10:30 AM/);
    expect(await panel()).toContain(EDITED);
    await screenshot("edited");
    await click("Close");

    // 5. The calendar shows the week; an event opens the same panel.
    await click("Calendar");
    await expect.poll(() => evaluate(`document.querySelectorAll('[data-event-card][aria-label^="Morning inbox summary"]').length`)).toBeGreaterThan(0);
    await screenshot("calendar-week");
    await evaluate(`[...document.querySelectorAll('[data-event-card][aria-label^="Morning inbox summary"]')].at(-1).click(); true`);
    await expect.poll(panel).toContain(EDITED);
    await screenshot("calendar-event-panel");
    await click("Close");
    await click("List");

    // 6. A run that fails because the bot is signed out puts it first under Needs you, with the one button that fixes it,
    // and its future days on the calendar say so too.
    await say("Scout", "every day at 5pm, check the sales inbox", MAIN);
    await expect.poll(() => cardText(FAILING), { timeout: 30_000 }).toContain("Next:");
    await openAutomations();
    await openRow(FAILING);
    await clickIn('aside[aria-label="Automation"]', "Run now");
    await expect.poll(panel, { timeout: 30_000 }).toContain("Needs you");
    expect(await panel()).toContain("It's signed out. Sign in again so it can run.");
    await click("Close");
    await expect.poll(() => evaluate(`document.querySelector("[data-automation]")?.innerText ?? ""`)).toContain(FAILING);
    expect(await rowStatus(FAILING)).toBe("needs-you");
    expect(await rowText(FAILING)).toContain("Needs you: It's signed out. Sign in again so it can run.\nSign in");
    await screenshot("needs-you");
    await click("Calendar");
    await expect.poll(() => evaluate(`[...document.querySelectorAll('[data-event-card][aria-label^="Sales inbox check"]')].filter((card) => !card.getAttribute("aria-label").includes("Failed")).map((card) => card.querySelector("[data-event-status]")?.dataset.eventStatus)`))
      .toEqual(expect.arrayContaining(["needs-you"]));
    expect(await evaluate(`[...document.querySelectorAll('[data-event-card][aria-label^="Morning inbox summary"] [data-event-status]')].map((dot) => dot.dataset.eventStatus).filter((status) => status !== "working")`)).toEqual([]);
    await evaluate(`[...document.querySelectorAll('[data-event-card][aria-label^="Sales inbox check"]')].find((card) => card.querySelector('[data-event-status="needs-you"]') && !card.getAttribute("aria-label").includes("Failed")).scrollIntoView({ block: "center" }); true`);
    await screenshot("calendar-needs-you");
    await click("List");

    // 7. Delete one from its panel; Undo one a bot just made from its card.
    await openRow(FAILING);
    await evaluate("window.confirm = () => true; true");
    await clickIn('aside[aria-label="Automation"]', "Delete");
    await expect.poll(() => rowStatus(FAILING)).toBe("gone");
    await screenshot("deleted");
    await say("Scout", "every friday at 4pm, send me a weekly report", MAIN);
    const weekly = "Every Friday at 4 PM, Scout sends you a weekly report";
    await expect.poll(() => cardText(weekly), { timeout: 30_000 }).toContain("Undo");
    expect(await clickCard(weekly, "Undo")).toBe(true);
    await expect.poll(() => evaluate(`[...document.querySelectorAll("[data-trigger-card]")].map((item) => item.innerText).join("\\n")`)).toContain("Automation removed · undone");
    await screenshot("undone");
    await openAutomations();
    expect(await rowStatus(weekly)).toBe("gone");

    // 8. Deleting a bot takes its automations with it: off the list, off the calendar, and nothing of it runs.
    await say("Ledger", "every morning, summarize my inbox");
    await expect.poll(() => cardText("Every day at 9 AM, Ledger sends you a summary of your inbox"), { timeout: 30_000 }).toContain("Next:");
    await say("Ledger", "whenever our form sends a lead, draft a follow-up");
    await expect.poll(() => cardText("When your sales form sends something, Ledger drafts a follow-up for the lead"), { timeout: 30_000 }).toContain("Hasn't run yet");
    await openAutomations();
    await expect.poll(() => evaluate(`[...document.querySelectorAll("[data-automation]")].filter((item) => item.innerText.includes("Ledger")).length`)).toBe(2);
    await screenshot("ledger-automations");
    await openChat("Ledger");
    await evaluate(`document.querySelector('button[aria-label="Actions for Ledger"]').click(); true`);
    await expect.poll(() => text("[role=menu]")).toContain("Delete");
    await clickIn("[role=menu]", "Delete");
    await expect.poll(() => text("[role=alertdialog], [role=dialog]")).toContain("automations");
    await screenshot("delete-bot-confirm");
    await clickIn("[role=alertdialog], [role=dialog]", "Delete");
    await expect.poll(() => evaluate(`[...document.querySelectorAll("[data-sidebar-bot-row]")].some((item) => item.innerText.startsWith("Ledger"))`), { timeout: 30_000 }).toBe(false);
    await openAutomations();
    expect(await evaluate(`[...document.querySelectorAll("[data-automation]")].filter((item) => item.innerText.includes("Ledger")).length`)).toBe(0);
    await screenshot("bot-deleted-list");
    await click("Calendar");
    expect(await evaluate(`[...document.querySelectorAll("[data-event-card]")].filter((item) => item.innerText.includes("Ledger")).length`)).toBe(0);
    await click("List");
    const afterDelete = await state();
    expect(afterDelete.routines.filter((routine) => routine.botId === ledger)).toEqual([]);
    expect(afterDelete.webhooks.filter((webhook) => webhook.botId === ledger)).toEqual([]);

    // 9. Restart the server mid-way: everything is still there, in the same state, and a schedule still runs on time.
    const dueAt = Date.now() + 45_000;
    await api("POST", "/api/routines", { name: "Lead count", prompt: "Count the new leads.", botId: scout, schedule: { type: "interval", everyMinutes: 60, anchorAt: dueAt } });
    await expect.poll(() => rowText("Scout counts the new leads")).toContain("next: today");
    const before = await evaluate(`[...document.querySelectorAll("[data-automation]")].map((item) => item.dataset.automationStatus + " " + item.innerText.split("\\n")[0])`);
    await live.stop();
    await live.start();
    await reload();
    await openAutomations();
    await expect.poll(() => evaluate(`[...document.querySelectorAll("[data-automation]")].map((item) => item.dataset.automationStatus + " " + item.innerText.split("\\n")[0])`), { timeout: 30_000 }).toEqual(before);
    await expect.poll(() => rowText("Scout counts the new leads"), { timeout: 90_000, interval: 2_000 }).toMatch(/Working · last ran today [^·]+ · next: today/);
    await screenshot("after-restart");
    expect((await state()).runs.filter((run) => run.botId === ledger)).toEqual([]);

    // 10. Advanced mode, then a narrow window: nothing overflows, the panel and the calendar still work.
    await noOverflow("the list in Simple mode");
    await evaluate(`localStorage.setItem("omb-advanced-mode", "1"); true`);
    await reload();
    await openAutomations();
    await expect.poll(() => rowStatus(EDITED)).toBe("working");
    await screenshot("advanced-list");
    await openRow(FORM);
    await expect.poll(panel).toContain("Copy address");
    await screenshot("advanced-panel");
    await click("Close");
    await browser("set", "viewport", "390", "780");
    await reload();
    await openAutomations();
    await noOverflow("the narrow list");
    expect(await evaluate(`(() => { const menu = document.querySelector('button[aria-label="Open bot list"]').getBoundingClientRect(); const back = document.querySelector('main header button[aria-label="Back"]').getBoundingClientRect(); return back.left >= menu.right; })()`), "the Back button sits clear of the menu button").toBe(true);
    await screenshot("narrow-list");
    await openRow(EDITED);
    await expect.poll(panel).toMatch(/recent runs/i);
    await noOverflow("the narrow panel");
    expect(await evaluate(`(() => { const box = document.querySelector('aside[aria-label="Automation"]').getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth + 1; })()`)).toBe(true);
    await screenshot("narrow-panel");
    await click("Close");
    await click("Calendar");
    await noOverflow("the narrow calendar");
    expect(await evaluate(`[...document.querySelectorAll("[aria-pressed=true]")].map((button) => button.textContent.trim())`)).toContain("Day");
    await screenshot("narrow-calendar");
    await click("List");
    await evaluate(`localStorage.setItem("omb-advanced-mode", "0"); true`);
    await reload();
    await openChat("Scout", MAIN);
    await evaluate(`${card(FORM)}.scrollIntoView({ block: "center" }); true`);
    await noOverflow("the narrow chat");
    expect(await evaluate(`${card(FORM)}.querySelector("span[title]").getBoundingClientRect().width`), "the card's status line keeps room to be read").toBeGreaterThan(200);
    await screenshot("narrow-simple-chat-cards");

    const consoleErrors = ((await ui("console")).messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error");
    expect(consoleErrors).toEqual([]);
  } catch (error) {
    await app?.screenshot("failure").catch(() => {});
    throw error;
  } finally {
    await app?.close();
    if (server) console.info(JSON.stringify({ logPath: server.logPath, screenshots: SHOTS }));
    await server?.close();
  }
}, 900_000);

const CLOUD_HOST = "omb-t-journey0123456.fly.dev";
const OUTSIDE_WHY = "A webhook's run made or changed this routine, so it runs without full access. Open it and save it once to run it with full access.";

/** A Cloud home as its image starts it (cloud-home-start's own environment and secrets pipe), with a fake public origin,
 * no network beyond loopback, the scripted engine, and the owner's paired device. */
async function launchCloudHome() {
  const home = mkdtempSync(join(SHORT_TMP, "omb-cloud-journey-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const planPath = join(home, "room-plan.json");
  writeFileSync(planPath, "{}");
  const claude = join(home, "claude-cli.mjs");
  writeFileSync(claude, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "owner@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_MODE ??= "happy";
await import(${JSON.stringify(pathToFileURL(join(ROOT, "server", "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ language: "en", instances: {
    ...Object.fromEntries(["cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: claude }, environment: { FAKE_CLAUDE_ROOM_PLAN: planPath } },
  } }));
  const port = await freePortBlock([0, 1]);
  const secret = randomBytes(32).toString("base64url");
  const offered: NodeJS.ProcessEnv = {
    OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "7a1c2e4f-9b3d-4c6e-8a7f-1d5e8c2b0a94", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
    OMB_PUBLIC_URL: `https://${CLOUD_HOST}`, OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_DATA_DIR: dataDir, PATH: dirname(process.execPath),
  };
  const { server: serverEnv, secrets } = cloudHomeChildEnvironments(cloudHomeConfiguration(offered)!, offered, home);
  const env = { ...serverEnv, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_TEST_SEALED_PATH: "1", TMPDIR: join(home, "tmp") };
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  const evidenceDir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `cloud-journey-${Date.now()}-${process.pid}.log`);
  const log = createWriteStream(logPath);
  const child: ChildProcess = spawnWithSecrets(process.execPath, ["--import", offline, join(ROOT, "server", "index.ts")], env, secrets, undefined, true);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited; see ${logPath}`);
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start; see ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const edge = { host: CLOUD_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await (await fetch(`${url}/api/cloud/pairing`, { method: "POST", headers: { ...edge, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body })).json() as { code: string };
  const paired = await (await fetch(`${url}/api/auth/pair`, { method: "POST", headers: { ...edge, origin: `https://${CLOUD_HOST}`, "content-type": "application/json" }, body: JSON.stringify({ code: granted.code }) })).json() as { token: string };
  const owner = { ...edge, origin: `https://${CLOUD_HOST}`, authorization: `Bearer ${paired.token}` };
  return {
    url, port, dataDir: home, logPath, planPath, hooksUrl: `http://127.0.0.1:${port + 1}`, owner,
    close: async () => { await waitForExit(child, { signal: "SIGTERM", graceMs: 15_000 }); log.end(); await removeTempDir(home); },
  };
}

(enabled ? it : it.skip)("on a Cloud: its public address, no keep-open hint, the same off/on, calls and cleanup, and each routine at the level it was made at", async () => {
  const cloud = await launchCloudHome();
  const shots = join(SHOTS, "cloud");
  let app: App | undefined;
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${cloud.url}${path}`, { method, headers: { ...cloud.owner, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json() as any;
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const newBot = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).bot.id as string;
    const scout = await newBot("Scout");
    const ledger = await newBot("Ledger");
    const script = [
      { key: "schedule", match: ["every morning, summarize my inbox"], repeat: true, steps: [{ tool: "create_trigger", arguments: { when: "schedule", name: "Morning inbox summary", instructions: "Send me a summary of my inbox.", schedule: { type: "daily", time: "09:00" } } }], reply: "Done." },
      { key: "webhook", match: ["form sends a lead"], repeat: true, steps: [{ tool: "create_trigger", arguments: { when: "webhook", name: "Sales form leads", instructions: "Draft a follow-up for the lead." } }], reply: "Set up." },
      // The webhook's own run makes a routine: what came in from outside stays confined.
      { key: "run-lead", match: ["Draft a follow-up for the lead."], repeat: true, steps: [{ tool: "create_trigger", arguments: { when: "schedule", name: "Hourly orders", instructions: "Email the order list.", schedule: { type: "interval", every_minutes: 60 } } }], reply: "Drafted a follow-up for Ada." },
      { key: "run-summary", match: ["Send me a summary of my inbox"], repeat: true, steps: [], reply: "Inbox: 3 new emails, nothing urgent." },
      { key: "run-orders", match: ["Email the order list."], repeat: true, steps: [], approve: { tool_name: "mcp__composio__COMPOSIO_SEARCH_TOOLS", input: { queries: [] } }, reply: "Sent." },
      { key: "chat", match: [""], repeat: true, steps: [], reply: "OK." },
    ];
    writeFileSync(cloud.planPath, JSON.stringify({ [scout]: { script }, [ledger]: { script } }));
    const turns = () => existsSync(`${cloud.planPath}.evidence.jsonl`)
      ? readFileSync(`${cloud.planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const state = async () => ({ ...(await api("GET", "/api/routines")), ...(await api("GET", "/api/webhooks")) }) as { routines: any[]; runs: any[]; webhooks: any[] };

    app = await openApp({ url: cloud.url, port: cloud.port, dataDir: cloud.dataDir, logPath: cloud.logPath }, { shots, bots: { Scout: scout, Ledger: ledger }, proxyHeaders: cloud.owner });
    const { evaluate, click, screenshot, text, clickIn, rowText, rowStatus, flip, switchState, panel, cardText, clickCard, openAutomations, openChat, say } = app;

    await expect.poll(() => evaluate(`(() => { const skip = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Skip setup"); skip?.click(); return Boolean(skip); })()`), { timeout: 30_000 }).toBe(true);

    // The owner sets up a schedule and a webhook from chat; the address to paste is the Cloud's public one.
    await say("Scout", "every morning, summarize my inbox");
    await expect.poll(() => cardText(SCHEDULE), { timeout: 30_000 }).toContain("Next:");
    await say("Scout", "whenever our form sends a lead, draft a follow-up");
    await expect.poll(() => cardText(FORM), { timeout: 30_000 }).toContain("Hasn't run yet");
    await evaluate("window.__copied = []; navigator.clipboard.writeText = async (value) => { window.__copied.push(value); }; true");
    expect(await clickCard(FORM, "Copy address")).toBe(true);
    await expect.poll(() => evaluate("window.__copied.length")).toBe(1);
    const address = await evaluate("window.__copied[0]") as string;
    expect(address).toMatch(new RegExp(`^https://${CLOUD_HOST.replaceAll(".", "\\.")}/hooks/wh_[\\w-]+/whsec_[\\w-]+$`));
    await screenshot("cloud-chat-cards");

    // Its calls: the right secret runs it, a wrong one is turned away, and More lists both. No "keep it open" hint.
    const local = address.replace(`https://${CLOUD_HOST}`, cloud.hooksUrl);
    expect((await fetch(local, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lead: "Ada Lovelace", email: "ada@example.com" }) })).status).toBe(202);
    await expect.poll(async () => (await state()).routines.some((routine) => routine.name === "Hourly orders"), { timeout: 30_000 }).toBe(true);
    expect((await fetch(local.replace(/whsec_[\w-]+$/, "whsec_wrong"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    await openAutomations();
    await expect.poll(() => rowText(FORM), { timeout: 30_000 }).toMatch(/Working · last ran today/);
    await evaluate(`${"[...document.querySelectorAll('[data-automation]')]"}.find((item) => item.innerText.includes(${JSON.stringify(FORM)})).querySelector("button").click(); true`);
    await expect.poll(panel).toContain("Copy address");
    expect(await panel()).not.toContain("Keep OpenMausBot open");
    await evaluate(`document.querySelector('aside[aria-label="Automation"] details summary').click(); true`);
    await expect.poll(() => evaluate(`[...document.querySelectorAll('aside[aria-label="Automation"] [data-call]')].map((item) => item.innerText.replace(/\\n/g, " "))`))
      .toEqual([expect.stringMatching(/✗ Wrong secret$/), expect.stringMatching(/✓ Received$/)]);
    expect(await text('aside[aria-label="Automation"] section[aria-label="Last thing it received"]')).toContain('"lead": "Ada Lovelace"');
    expect(await evaluate(`document.querySelector('aside[aria-label="Automation"]').innerHTML.includes("whsec_")`), "the secret stays masked when More opens").toBe(false);
    await screenshot("cloud-panel");
    await click("Close");

    // Off and back on, both kinds, the same as on the desktop.
    for (const sentence of [SCHEDULE, FORM]) {
      expect(await flip(sentence)).toBe("true");
      await expect.poll(() => rowStatus(sentence)).toBe("paused");
      expect(await flip(sentence)).toBe("false");
      await expect.poll(() => rowStatus(sentence)).toBe("working");
      expect(await switchState(sentence)).toBe("true");
    }
    expect((await state()).routines.find((routine) => routine.name === "Morning inbox summary")).toMatchObject({ enabled: true });
    expect((await state()).webhooks[0]).toMatchObject({ enabled: true });

    // A routine the owner's bot made in the owner's chat runs at the bot's own level, with nothing held.
    const ownerTurn = turns().find((turn) => String(JSON.stringify(turn.prompt)).includes("every morning, summarize my inbox"));
    await evaluate(`[...document.querySelectorAll('[data-automation]')].find((item) => item.innerText.includes(${JSON.stringify(SCHEDULE)})).querySelector("button").click(); true`);
    await clickIn('aside[aria-label="Automation"]', "Run now");
    await expect.poll(panel, { timeout: 30_000 }).toMatch(/✓\nInbox: 3 new emails, nothing urgent\./);
    const ownersRun = turns().findLast((turn) => String(JSON.stringify(turn.prompt)).includes("Send me a summary of my inbox."));
    expect(ownersRun).toMatchObject({ restricted: false, permissionMode: ownerTurn.permissionMode });
    const ownersRunThread = (await state()).runs.find((run) => run.routineName === "Morning inbox summary")?.threadId;
    expect((await api("GET", `/api/threads/${ownersRunThread}/messages`)).messages.filter((message: any) => message.card?.held || message.card?.guestConfined)).toEqual([]);
    await screenshot("cloud-owner-routine-ran");
    await click("Close");

    // The routine the webhook's run made stays confined, and its held approval says why.
    const hourly = "Every hour, Scout emails the order list";
    await expect.poll(() => rowStatus(hourly)).toBe("working");
    await evaluate(`[...document.querySelectorAll('[data-automation]')].find((item) => item.innerText.includes(${JSON.stringify(hourly)})).querySelector("button").click(); true`);
    await clickIn('aside[aria-label="Automation"]', "Run now");
    await expect.poll(async () => (await state()).runs.find((run) => run.routineName === "Hourly orders")?.status, { timeout: 30_000 }).toBe("waiting");
    const ordersThread = (await state()).runs.find((run) => run.routineName === "Hourly orders").threadId;
    await expect.poll(async () => (await api("GET", `/api/threads/${ordersThread}/messages`)).messages.find((message: any) => message.card?.held)?.card.held, { timeout: 30_000 }).toBe(OUTSIDE_WHY);
    await expect.poll(panel).toContain("Needs you");
    await clickIn('aside[aria-label="Automation"]', "Answer");
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[role=region] button[aria-expanded="false"][aria-controls^="approval-details-"]'))`), { timeout: 15_000 }).toBe(true);
    await evaluate(`document.querySelector('[role=region] button[aria-controls^="approval-details-"]').click(); true`);
    await expect.poll(() => evaluate(`document.querySelector('[id^="approval-details-"]:not([hidden]) .text-warning')?.innerText ?? ""`)).toBe(OUTSIDE_WHY);
    await screenshot("cloud-webhook-made-routine-held");

    // Deleting a bot takes its automations with it, on a Cloud too.
    await api("POST", "/api/webhooks", { name: "Ledger leads", prompt: "Log the lead.", botId: ledger });
    await api("POST", "/api/routines", { name: "Ledger close", prompt: "Close the books.", botId: ledger, schedule: { type: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] } });
    await openAutomations();
    await expect.poll(() => evaluate(`[...document.querySelectorAll("[data-automation]")].filter((item) => item.innerText.includes("Ledger")).length`)).toBe(2);
    await openChat("Ledger");
    await evaluate(`document.querySelector('button[aria-label="Actions for Ledger"]').click(); true`);
    await expect.poll(() => text("[role=menu]")).toContain("Delete");
    await clickIn("[role=menu]", "Delete");
    await expect.poll(() => text("[role=alertdialog]")).toContain("automations");
    await clickIn("[role=alertdialog]", "Delete");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.some((bot: any) => bot.id === ledger), { timeout: 30_000 }).toBe(false);
    await openAutomations();
    expect(await evaluate(`[...document.querySelectorAll("[data-automation]")].filter((item) => item.innerText.includes("Ledger")).length`)).toBe(0);
    const after = await state();
    expect([...after.routines, ...after.webhooks].filter((item) => item.botId === ledger)).toEqual([]);
    await screenshot("cloud-bot-deleted");
  } catch (error) {
    await app?.screenshot("failure").catch(() => {});
    throw error;
  } finally {
    await app?.close();
    console.info(JSON.stringify({ logPath: cloud.logPath, screenshots: shots }));
    await cloud.close();
  }
}, 600_000);
