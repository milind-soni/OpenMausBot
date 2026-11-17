// Sharing a private conversation and saving to team memory, in the real app on a real Team Cloud (OMB_CLOUD_ROLE=team,
// each person paired with the Admin's signed claim) in headless Chrome: Rui hands a private chat to Marta, who finds it
// in her inbox and carries it on with the bot's whole context; it goes back and forth through their inboxes; Rui saves a
// decision to team memory in one click and Ana's new conversation with the bot uses it; the team's admin sees none of
// Rui's private chats. Run with OMB_UI_E2E=1; OMB_TEAM_SHARE_SHOTS=DIR keeps the screenshots there.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WELCOME_VERSION } from "../../electron/onboarding-record.mjs";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { SPOTLIGHTS } from "../../src/lib/first-conversation.ts";
import { TOUR_STEPS } from "../../src/lib/guided-tour.ts";
import { NOTICES } from "../../src/lib/notices.ts";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "./cloud-send-fixture.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { mountPreview, REPO_ROOT } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1";
if (!enabled) console.info("skipping the conversation sharing UI e2e: set OMB_UI_E2E=1");

const SHOTS = process.env.OMB_TEAM_SHARE_SHOTS || join(REPO_ROOT, ".omb-scratch", "team-conversation-share");
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";`;
const HANDOFF = "Kumquat launch: the supplier is Ortega, call before Friday";
const OTHER = "Rui's own salary questions";
const MARTA_LINE = "Picking this up: what did we agree with Ortega?";
const DECISION = "Decision: we ship the Kumquat launch on 3 March";
const DESKTOP = ["1280", "800"] as const, PHONE = ["390", "844"] as const;
const DISMISS = `(() => { [...document.querySelectorAll('[role="dialog"] button, dialog button')].find((button) => button.textContent.trim() === "Not now")?.click(); return true; })()`;

type Who = "olive" | "rui" | "marta" | "ana";
type Row = { text: string; tab: string; origin?: { threadId: string } };
type App = Awaited<ReturnType<typeof openAs>>;

let fx: CloudSendFixture, team: CloudTeamFixture;
let tools: { binary: string; chrome: string | null };
const tokens: Record<Who, string> = { olive: "", rui: "", marta: "", ana: "" };
const emails: Record<Who, string> = { olive: "olive@acme.test", rui: "rui@acme.test", marta: "marta@acme.test", ana: "ana@acme.test" };
let scout = "", handoff = "", other = "";
const apps: App[] = [];

const as = (who: Who, method: string, path: string, body?: unknown) => team.as(tokens[who], method, path, body);
const status = async (who: Who, threadId: string) => (await as(who, "GET", `/api/threads/${threadId}/messages?limit=50`)).status;
const idle = async () => ((await as("olive", "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>).every((bot) => bot.activity !== "working" && !bot.busy);
const openRows = async (who: Who, threadId: string) => (((await as(who, "GET", "/api/inbox")).body.rows ?? []) as Row[]).filter((row) => row.origin?.threadId === threadId && row.tab !== "done");
const dump = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { prompt: unknown; systemPrompt?: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAs(who: Who, size: readonly [string, string]) {
  const preview = await mountPreview({ info: { url: team.base } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Sharing",
    logLevel: "warn", proxyHeaders: { ...fx.edge, authorization: `Bearer ${tokens[who]}` } });
  const home = join(fx.root, `b${apps.length}`);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const env = sessionEnv({ home, session: `s${apps.length}`, chrome: tools.chrome });
  const browser = (...args: string[]) => agentBrowser(tools.binary, env, args, 120_000);
  await browser("set", "viewport", ...size);
  const evaluate = async <T>(js: string) => (await browser("eval", js)).result as T;
  await browser("open", new URL("/package.json", preview.previewUrl).href);
  await evaluate(`(() => { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); return true; })()`);
  await browser("open", preview.previewUrl);
  const audience = () => evaluate<string | null>("(() => { const label = document.querySelector('[data-team-audience]'); return label ? label.dataset.teamAudience + ':' + label.textContent : null; })()");
  const clickText = (selector: string, text: string) => evaluate<boolean>(`(() => { const hit = [...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => each.textContent.trim().includes(${JSON.stringify(text)})); hit?.click(); return Boolean(hit); })()`);
  const app = {
    who, evaluate, audience, clickText,
    words: () => evaluate<string>("document.body.innerText"),
    async shot(name: string) {
      await sleep(400);
      await browser("screenshot", join(SHOTS, `${name}.png`));
    },
    async openScout(on: "me" | "team") {
      await evaluate(DISMISS);
      await expect.poll(() => evaluate<boolean>(`(() => { const row = document.querySelector('[data-sidebar-bot-row="${scout}"]'); row?.click(); return Boolean(row); })()`), { timeout: 60_000, interval: 500 }).toBe(true);
      await expect.poll(async () => (await audience())?.split(":")[0], { timeout: 30_000 }).toBe(on);
    },
    async say(text: string) {
      await evaluate(`(() => { const field = document.querySelector('textarea[placeholder^="Message"]'); field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
        field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await browser("press", "Enter");
      await expect.poll(() => evaluate<string>("document.querySelector('main')?.innerText ?? ''"), { timeout: 30_000 }).toContain(text);
      await sleep(500);
      await expect.poll(idle, { timeout: 60_000, interval: 300 }).toBe(true);
    },
    /** The conversation's own actions: the bot panel's Conversation rows (Simple), else the header's ⋯. */
    async conversationAction(item: string) {
      await expect.poll(async () => {
        if (await clickText('[data-panel-card="conversation"] button', item)) return true;
        await evaluate(`(() => { if (!document.querySelector('[data-panel-card="conversation"]')) document.querySelector('[data-chathead-pill]')?.click(); return true; })()`);
        await evaluate(`(() => { const trigger = document.querySelector('[data-testid="chat-more"]'); (trigger?.closest('button') ?? trigger)?.click(); return true; })()`);
        return clickText('[role="menuitem"]', item);
      }, { timeout: 30_000, interval: 500 }).toBe(true);
    },
    async openInbox() {
      await evaluate(DISMISS);
      await expect.poll(() => evaluate<boolean>(`(() => { const row = document.querySelector('[data-sidebar-inbox]'); (row?.closest('button') ?? row)?.click(); return Boolean(row); })()`), { timeout: 60_000, interval: 500 }).toBe(true);
      await expect.poll(() => evaluate<boolean>("Boolean(document.querySelector('[data-inbox-panel]'))"), { timeout: 30_000 }).toBe(true);
    },
    async openInboxLine(text: string) {
      await expect.poll(() => clickText("[data-inbox-row] button", text), { timeout: 30_000, interval: 500 }).toBe(true);
      await expect.poll(() => evaluate<boolean>(`(() => { const open = document.querySelector('[data-inbox-action="open"]'); open?.click(); return Boolean(open); })()`), { timeout: 30_000 }).toBe(true);
    },
    async close() {
      await browser("close").catch(() => {});
      await preview.close();
    },
  };
  apps.push(app);
  return app;
}

(enabled ? describe : describe.skip)("sharing a conversation and saving to team memory on a Team Cloud, in the real app", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    tools = await ensureUiBrowser(process.env);
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-share-${randomBytes(8).toString("hex")}`,
      team: { id: "team-acme-share-ui", name: "Acme", engine: ENGINE, env: { OMB_TEAM_PRESENCE_GRACE_MS: "1000" } } });
    team = fx.team!;
    for (const [who, role] of [["olive", "owner"], ["rui", "member"], ["marta", "member"], ["ana", "member"]] as const) tokens[who] = (await team.pair({ email: emails[who], role })).token!;
    const onboarding = { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS, "cloud-welcome-done", "cloud-setup-hidden"] };
    expect((await as("olive", "PATCH", "/api/config", { onboarding, language: "en" })).status).toBe(200);
    for (const who of ["rui", "marta", "ana"] as const) {
      expect((await as(who, "PUT", "/api/me/welcome", { welcomed: true })).status).toBe(200);
      expect((await as(who, "PUT", "/api/me", { name: who[0]!.toUpperCase() + who.slice(1) })).status).toBe(200);
    }
    for (const who of ["olive", "rui", "marta", "ana"] as const) {
      const own = ((await as(who, "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; defaultBot?: { person?: string } }>).find((bot) => bot.defaultBot?.person === emails[who])!;
      expect((await as(who, "PATCH", `/api/bots/${own.id}`, { welcomed: true, sidebarHidden: false, pinned: true })).status).toBe(200);
    }
    const created = await as("olive", "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    scout = created.body.bot.id;
  }, hostTimeout(300_000));
  afterAll(async () => {
    for (const app of apps) await app.close().catch(() => {});
    await fx?.close();
  }, hostTimeout(120_000));

  it("Rui shares a private chat with Marta from the conversation's menu, after a confirm step that says who will read all of it", async () => {
    const rui = await openAs("rui", DESKTOP);
    await rui.openScout("me");
    expect(await rui.audience()).toBe("me:Private · only you");
    await rui.say(HANDOFF);
    const tasks = ((await as("rui", "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string; private?: true }> }>).find((bot) => bot.id === scout)!.tasks;
    handoff = tasks.find((task) => task.private)!.threadId;
    await rui.shot("00-rui-private-chat-desktop");
    await rui.conversationAction("Share with…");
    await expect.poll(() => rui.evaluate<string>("document.querySelector('[role=alertdialog]')?.innerText ?? ''"), { timeout: 30_000 }).toContain("Nobody else can see it, admins included.");
    await rui.evaluate(`(() => { const select = document.querySelector('[role=alertdialog] select'); select.value = ${JSON.stringify(emails.marta)}; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await expect.poll(() => rui.evaluate<string>("document.querySelector('[role=alertdialog]')?.innerText ?? ''"), { timeout: 10_000 })
      .toContain("Marta will be able to read this whole conversation, including everything already in it and its files, and carry it on with Scout.");
    await rui.shot("01-rui-share-with-confirm-desktop");
    expect(await status("marta", handoff), "nothing moves before he confirms").toBe(404);
    await rui.clickText("[role=alertdialog] button", "Share with Marta");
    await expect.poll(rui.audience, { timeout: 30_000 }).toBe("team:Shared · only you and Marta can see");
    await rui.shot("02-rui-shared-label-desktop");
    expect(await status("marta", handoff)).toBe(200);
    for (const who of ["ana", "olive"] as const) expect(await status(who, handoff), who).toBe(404);
    await rui.close();
    const made = await as("rui", "POST", `/api/bots/${scout}/tasks`, { title: "Salary" });
    other = made.body.task.threadId;
    expect((await as("rui", "POST", `/api/bots/${scout}/messages`, { text: OTHER, threadId: other })).status).toBe(202);
    await expect.poll(idle, { timeout: 60_000, interval: 300 }).toBe(true);

  }, hostTimeout(300_000));

  it("Marta finds it in her inbox, opens it, and the bot carries on with the whole conversation", async () => {
    await sleep(2_500);
    const marta = await openAs("marta", DESKTOP);
    await marta.openInbox();
    await expect.poll(marta.words, { timeout: 30_000 }).toContain("Rui shared");
    await marta.shot("03-marta-inbox-desktop");
    await marta.openInboxLine("Rui shared");
    await expect.poll(marta.audience, { timeout: 30_000 }).toBe("team:Shared · only you and Rui can see");
    expect(await marta.evaluate<string>("document.querySelector('main')?.innerText ?? ''"), "everything already in it").toContain(HANDOFF);
    rmSync(join(team.home, "dump.json"), { force: true });
    await marta.say(MARTA_LINE);
    await expect.poll(() => existsSync(join(team.home, "dump.json")), { timeout: 30_000 }).toBe(true);
    expect(JSON.stringify(dump().prompt), "the bot has the conversation so far").toContain(HANDOFF);
    expect(JSON.stringify(dump()), "and none of Rui's other private chat").not.toContain(OTHER);
    await marta.shot("04-marta-carries-on-desktop");
    await marta.close();
  }, hostTimeout(300_000));

  it("and back: Rui's inbox holds one line for it, he answers there, and it waits in Marta's inbox in turn", async () => {
    await sleep(2_500);
    expect((await openRows("rui", handoff)).length, "one line, updated in place by the bot's answer").toBe(1);
    const rui = await openAs("rui", DESKTOP);
    await rui.openInbox();
    await expect.poll(rui.words, { timeout: 30_000 }).toContain("answered Marta");
    await rui.shot("05-rui-inbox-back-desktop");
    await rui.openInboxLine("answered Marta");
    await expect.poll(rui.audience, { timeout: 30_000 }).toBe("team:Shared · only you and Marta can see");
    expect(await rui.evaluate<string>("document.querySelector('main')?.innerText ?? ''")).toContain(MARTA_LINE);
    await rui.say(DECISION);
    expect(await openRows("rui", handoff), "he answered, so nothing waits on him").toEqual([]);
    expect((await openRows("marta", handoff)).length, "now it waits on Marta").toBe(1);

    await rui.evaluate(`(() => { const row = [...document.querySelectorAll('[data-message-row]')].find((each) => each.innerText.includes(${JSON.stringify(DECISION)})); row.querySelector('button[aria-label="Message actions"]').click(); return true; })()`);
    await expect.poll(() => rui.clickText('[role="menuitem"]', "Save to team memory"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => rui.evaluate<string>("document.querySelector('[data-access-toast]')?.innerText ?? ''"), { timeout: 10_000 }).toContain("Saved to Scout's team memory");
    await rui.shot("06-rui-saved-to-team-memory-desktop");
    expect(readFileSync(join(team.home, ".openmausbot", "workspaces", scout, "MEMORY.md"), "utf8")).toMatch(/Decision: we ship the Kumquat launch on 3 March \(saved by Rui, \d{4}-\d{2}-\d{2}\)/);
    await rui.close();
  }, hostTimeout(300_000));

  it("Marta at phone width: the line waiting on her, and the conversation's label", async () => {
    await sleep(2_500);
    const marta = await openAs("marta", PHONE);
    await marta.openInbox();
    await expect.poll(marta.words, { timeout: 30_000 }).toContain("answered Rui");
    await marta.shot("07-marta-inbox-phone");
    await marta.openInboxLine("answered Rui");
    await expect.poll(marta.audience, { timeout: 30_000 }).toBe("team:Shared · only you and Rui can see");
    await marta.evaluate(`(() => { document.querySelector('[data-inbox-panel] button[aria-label="Close inbox"]')?.click(); return true; })()`);
    await expect.poll(() => marta.evaluate<boolean>("!document.querySelector('[data-inbox-panel]')"), { timeout: 10_000 }).toBe(true);
    await marta.shot("08-marta-shared-chat-phone");
    expect(await marta.evaluate<number>("document.scrollingElement.scrollWidth - window.innerWidth"), "no sideways scroll").toBeLessThanOrEqual(1);
    await marta.close();
  }, hostTimeout(300_000));

  it("Ana's new conversation with Scout reads the decision Rui saved", async () => {
    const ana = await openAs("ana", DESKTOP);
    await ana.openScout("me");
    rmSync(join(team.home, "dump.json"), { force: true });
    await ana.say("When do we ship the Kumquat launch?");
    await expect.poll(() => existsSync(join(team.home, "dump.json")), { timeout: 30_000 }).toBe(true);
    expect(`${JSON.stringify(dump().prompt)}\n${dump().systemPrompt ?? ""}`).toContain(DECISION);
    expect(await ana.words(), "nothing of the handoff on her screen").not.toContain(HANDOFF);
    await ana.shot("09-ana-new-chat-desktop");
    await ana.close();
  }, hostTimeout(300_000));

  it("the team's admin sees none of Rui's private chats, nor the one he handed to Marta", async () => {
    for (const threadId of [other, handoff]) expect(await status("olive", threadId)).toBe(404);
    const olive = await openAs("olive", DESKTOP);
    await olive.openScout("me");
    expect(await olive.words()).not.toContain(OTHER);
    expect(await olive.words()).not.toContain(HANDOFF);
    await olive.evaluate(`document.querySelector('[data-team-side-option="team"]')?.click(); true`);
    await sleep(1_000);
    expect(await olive.words(), "nor on the Team side").not.toContain(HANDOFF);
    await olive.shot("10-admin-desktop");
    await olive.close();
  }, hostTimeout(300_000));
});
