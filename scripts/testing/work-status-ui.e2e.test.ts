// A Team Cloud room whose work a bot split into threads, in the real app in headless Chrome: Lead splits Mira's ask with
// board_add (one room thread per piece), and each work thread shows one short status on its feed row and over it when
// it is open beside the feed (Up next, Writer working, Needs you, Needs Mira, Done, Stopped), with no switch and no
// "Board" anywhere a person reads. A live change moves a row's status, and an empty room says a bot can split big work.
// The pieces' states are written to board.json and the Cloud restarted on it; the dispatcher's quiet minutes last hours
// here, so nothing moves them. Asked where the work stands, Lead (the synthetic Claude CLI) shows it in the thread with
// show_html, grouped by the same statuses. Run with OMB_UI_E2E=1; OMB_WORK_STATUS_SHOTS=DIR keeps the screenshots.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WELCOME_VERSION } from "../../electron/onboarding-record.mjs";
import type { BoardItem } from "../../shared/board.ts";
import { personKey } from "../../server/person-key.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { SPOTLIGHTS } from "../../src/lib/first-conversation.ts";
import { TOUR_STEPS } from "../../src/lib/guided-tour.ts";
import { NOTICES } from "../../src/lib/notices.ts";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "./cloud-send-fixture.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { mountPreview, REPO_ROOT } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1";
if (!enabled) console.info("skipping the work status UI e2e: set OMB_UI_E2E=1");

const SHOTS = process.env.OMB_WORK_STATUS_SHOTS || join(REPO_ROOT, ".omb-scratch", "work-status");
const WIDE = ["1440", "900"] as const, NARROW = ["900", "800"] as const;
const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
/** The synthetic CLI calls the tools tool-calls.json names for a word of the turn's newest line. */
const ENGINE = `const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = dir + "/tool-calls.json";
process.env.FAKE_CLAUDE_MARKERS_LATEST = "1";`;
/** What a bot's work view looks like: one compact page, grouped by what people see on the threads. */
function workPage(groups: Array<[string, string[]]>): string {
  const section = ([status, titles]: [string, string[]]) => `<section><h3>${status}</h3><ul>${titles.map((title) => `<li>${title}</li>`).join("")}</ul></section>`;
  return `<style>body{margin:0;font:13px/18px var(--font-sans);color:var(--color-text-primary);background:transparent}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:12px}
section{border:0.5px solid var(--color-border-primary);border-radius:10px;padding:8px 10px}
h3{margin:0 0 4px;font-size:12px;font-weight:600;opacity:.85}
ul{margin:0;padding:0;list-style:none}li{padding:2px 0}</style>
<main>${groups.map(section).join("")}</main>`;
}
const DISMISS = `(() => { [...document.querySelectorAll('[role="dialog"] button, dialog button')].find((button) => button.textContent.trim() === "Not now")?.click(); return true; })()`;

type Bot = { id: string; name: string };
type Room = { id: string; threadId: string };

let fx: CloudSendFixture, team: CloudTeamFixture;
let tools: { binary: string; chrome: string | null };
let olive = "", mira = "";
let writer: Bot, reviewer: Bot, lead: Bot, launch: Room, quiet: Room;
const pieces: Record<string, BoardItem> = {};

async function openApp(size: readonly [string, string]) {
  const preview = await mountPreview({ info: { url: team.base } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Work status",
    logLevel: "warn", proxyHeaders: { ...fx.edge, authorization: `Bearer ${olive}` } });
  // agent-browser 0.37 refuses a socket path over 103 bytes, and it lives under this home.
  const home = join(fx.root, "b0");
  mkdirSync(join(home, "tmp"), { recursive: true });
  const env = sessionEnv({ home, session: "w0", chrome: tools.chrome });
  const browser = (...args: string[]) => agentBrowser(tools.binary, env, args, 120_000);
  await browser("set", "viewport", ...size);
  const evaluate = async <T>(js: string) => (await browser("eval", js)).result as T;
  await browser("open", new URL("/package.json", preview.previewUrl).href);
  await evaluate(`(() => { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); return true; })()`);
  await browser("open", preview.previewUrl);
  const until = (js: string, timeout = 60_000) => expect.poll(() => evaluate<boolean>(`Boolean(${js})`), { timeout, interval: 400 }).toBe(true).catch(async (cause: unknown) => {
    await browser("screenshot", join(SHOTS, "failed.png")).catch(() => {});
    throw new Error(`${js} never held`, { cause });
  });
  const click = async (selector: string) => {
    await until(`document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  };
  return {
    evaluate, until, click, browser,
    statuses: () => evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-feed-thread]')].map((row) => [row.dataset.feedThread, row.querySelector('[data-feed-work]')?.textContent ?? '']))`),
    async ready() {
      // Rooms are on the Team side; the offer of one's own MausBot is left for later.
      await until(`${DISMISS} && (document.querySelector('[data-team-side-option="team"]')?.click(), document.querySelector('[data-sidebar-group-row]'))`);
      for (const label of ["Skip setup", "Hide setup"]) {
        await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)})?.click(); true`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await evaluate(DISMISS);
    },
    async skins(name: string) {
      for (const skin of ["midnight", "daylight"]) {
        await evaluate(`import('/src/lib/skins.ts').then(({ applySkin }) => { applySkin(${JSON.stringify(skin)}); return true; })`);
        await new Promise((resolve) => setTimeout(resolve, 700));
        await browser("screenshot", join(SHOTS, `${name}-${skin}.png`));
      }
      await evaluate("import('/src/lib/skins.ts').then(({ applySkin }) => { applySkin('midnight'); return true; })");
    },
    async close() {
      await browser("close").catch(() => {});
      await preview.close();
    },
  };
}

(enabled ? describe : describe.skip)("a work thread's one status, in the real app on a Team Cloud", () => {
  let app: Awaited<ReturnType<typeof openApp>> | null = null;

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    tools = await ensureUiBrowser(process.env);
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-work-status-${randomBytes(8).toString("hex")}`,
      team: { id: "team-acme-work-ui", name: "Acme", engine: ENGINE, env: { OMB_BOARD_TIME_SCALE: "1000" } } });
    team = fx.team!;
    olive = (await team.pair(OLIVE)).token!;
    mira = (await team.pair(MIRA)).token!;
    writeFileSync(join(team.home, "tool-calls.json"), "{}");
    const onboarding = { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS, "cloud-welcome-done", "cloud-setup-hidden"] };
    expect((await team.as(olive, "PATCH", "/api/config", { onboarding, language: "en" })).status).toBe(200);
    for (const token of [olive, mira]) await team.as(token, "PUT", "/api/me/welcome", { welcomed: true });
    const bot = async (name: string) => {
      const made = await team.as(olive, "POST", "/api/bots", { name, visibility: "everyone" });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      return made.body.bot as Bot;
    };
    writer = await bot("Writer");
    reviewer = await bot("Reviewer");
    lead = await bot("Lead");
    const room = async (name: string) => {
      const made = await team.as(olive, "POST", "/api/groups", { name, memberIds: [writer.id, reviewer.id, lead.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      return made.body.group as Room;
    };
    launch = await room("Launch");
    quiet = await room("Ideas");

    const asked = await team.as(mira, "POST", `/api/groups/${launch.id}/messages`, { text: "@Lead Plan the launch and split it up between you.", threadId: launch.threadId });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    for (const end = Date.now() + 60_000; !((await team.as(olive, "GET", "/api/bots")).body.bots as Array<{ busy?: boolean }>).every((one) => !one.busy);) {
      if (Date.now() > end) throw new Error("Lead's turn did not end");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // Lead splits the work, as its tool does when a person asks: one room thread per piece, Lead's brief first in each.
    const bearer = await team.capability(lead.id, launch.threadId);
    const split = await fetch(`${team.base}/api/internal/board/add`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ items: [
      { key: "research", title: "Research venues", brief: "Shortlist three venues near the office that fit 80 people." },
      { key: "venue", title: "Book the venue", brief: "Book the venue the team picks from the shortlist.", needs: ["research"] },
      { key: "date", title: "Pick the launch date", brief: "Find a Friday in March that works for marketing and sales." },
      { key: "draft", title: "Draft the launch post", brief: "Write a 300-word launch post for the blog.", for: "Writer" },
      { key: "review", title: "Review the post", brief: "Check the draft for tone and facts.", needs: ["draft"], for: "Reviewer" },
      { key: "banners", title: "Order printed banners", brief: "Order two roll-up banners from the usual printer." },
    ] }) });
    expect(split.status, await split.clone().text()).toBe(201);
    const items = (await team.as(olive, "GET", `/api/board?groupId=${launch.id}`)).body.items as BoardItem[];
    for (const item of items) pieces[item.title] = item;
    const at = Date.now();
    const holder = (bot: Bot) => ({ botId: bot.id, since: at - 60_000 });
    const states: Record<string, Partial<BoardItem>> = {
      "Research venues": { state: "done", attempts: 1, result: "The Loft, Hall 9 and Riverside." },
      "Book the venue": { state: "needs_person", holder: holder(writer), attempts: 1, question: { text: "Which of the three should I book?", askedAt: at, person: personKey({ id: "", email: OLIVE.email }), name: "Olive" } },
      "Pick the launch date": { state: "needs_person", holder: holder(lead), attempts: 1, question: { text: "Does March 13 work for sales?", askedAt: at, person: personKey({ id: "", email: MIRA.email }), name: "Mira" } },
      "Draft the launch post": { state: "working", holder: holder(writer), attempts: 1 },
      "Review the post": { state: "waiting" },
      "Order printed banners": { state: "failed", attempts: 3, result: "Stopped after 3 tries." },
    };
    // Written while nothing changes the board, then read again by the restarted Cloud.
    const file = join(team.home, ".openmausbot", "board.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { version: 1; items: BoardItem[]; repeats: unknown[] };
    stored.items = stored.items.map((item) => ({ ...item, ...states[item.title] }));
    writeFileSync(file, JSON.stringify(stored, null, 2));
    await team.relaunch();
  }, hostTimeout(300_000));

  afterAll(async () => {
    await app?.close().catch(() => {});
    await fx?.close();
  }, hostTimeout(120_000));

  it("shows each work thread's status on its row and over it when open, in both reference skins", async () => {
    app = await openApp(WIDE);
    await app.ready();
    await app.click(`[data-sidebar-group-row="${launch.id}"]`);
    await app.until(`document.querySelectorAll('[data-feed-thread] [data-feed-work]').length === 6`);
    const byTitle = (title: string) => pieces[title]!.threadId;
    expect(await app.statuses()).toMatchObject({
      [byTitle("Research venues")]: "Done",
      [byTitle("Book the venue")]: "Needs you",
      [byTitle("Pick the launch date")]: "Needs Mira",
      [byTitle("Draft the launch post")]: "Writer working",
      [byTitle("Review the post")]: "Up next",
      [byTitle("Order printed banners")]: "Stopped",
    });
    expect(await app.evaluate<string>("document.querySelector('main').innerText"), "no Board for people").not.toMatch(/\bBoard\b/);
    const mark = (title: string) => app!.evaluate<string | null>(`document.querySelector('[data-feed-thread="${byTitle(title)}"] [data-feed-mark]')?.dataset.feedMark ?? null`);
    expect(await mark("Pick the launch date"), "what waits on Mira does not wait on Olive").not.toBe("waiting");
    expect(await mark("Book the venue")).toBe("waiting");
    await app.evaluate(`document.querySelector('[data-feed-thread="${byTitle("Book the venue")}"] > button').click(); true`);
    await app.until(`document.querySelector('[data-thread-panel="${byTitle("Book the venue")}"] [data-thread-work="needs"]')`);
    expect(await app.evaluate<string>(`document.querySelector('[data-thread-work]').textContent`)).toBe("Needs you");
    await app.skins("01-feed-and-thread-1440");

    // A live change moves the row: Olive marks the post's draft done, and its review is up next as before.
    const done = await team.as(olive, "PATCH", `/api/board/items/${byTitle("Draft the launch post")}`, { move: "done", result: "Draft in the doc." });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await app.until(`document.querySelector('[data-feed-thread="${byTitle("Draft the launch post")}"] [data-feed-work]')?.textContent === "Done"`);
  }, hostTimeout(300_000));

  it("keeps the statuses where the feed and the thread share a narrow window, and an empty room hints at splitting", async () => {
    await app!.browser("set", "viewport", ...NARROW);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await app!.until(`document.querySelectorAll('[data-feed-thread] [data-feed-work]').length >= 5 && document.querySelector('[data-thread-work]')`);
    await app!.browser("screenshot", join(SHOTS, "02-feed-and-thread-narrow-900-midnight.png"));
    await app!.browser("set", "viewport", ...WIDE);
    await app!.click(`[data-sidebar-group-row="${quiet.id}"]`);
    await app!.until("document.querySelector('[data-feed-split-hint]')");
    expect(await app!.evaluate<string>("document.querySelector('[data-feed-split-hint]').textContent")).toBe("Ask a bot to split big work into threads.");
    await app!.skins("04-empty-room-hint-1440");
  }, hostTimeout(300_000));

  it("shows where the work stands in the thread when a person asks, as one page grouped by the same statuses", async () => {
    const page = workPage([["Needs you", ["Book the venue"]], ["Needs Mira", ["Pick the launch date"]], ["Up next", ["Review the post"]],
      ["Done", ["Research venues", "Draft the launch post"]], ["Stopped", ["Order printed banners"]]]);
    writeFileSync(join(team.home, "tool-calls.json"), JSON.stringify({ stand: [
      { name: "board_list", server: "agents", input: { room: "Launch" } },
      { name: "show_html", server: "agents", input: { title: "Launch: where the work stands", html: page, height: 200 } },
    ] }));
    await app!.click(`[data-sidebar-group-row="${launch.id}"]`);
    await app!.until(`document.querySelector('[data-feed-thread="${launch.threadId}"]')`);
    await app!.evaluate(`document.querySelector('[data-feed-thread="${launch.threadId}"] > button').click(); true`);
    await app!.until(`document.querySelector('[data-thread-panel="${launch.threadId}"]')`);
    const sent = await team.as(olive, "POST", `/api/groups/${launch.id}/messages`, { text: "@Lead where does the work stand?", threadId: launch.threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await app!.until(`document.querySelector('[data-thread-panel="${launch.threadId}"] iframe[data-app-frame]')`, 90_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await app!.skins("05-work-view-in-thread-1440");
  }, hostTimeout(300_000));
});
