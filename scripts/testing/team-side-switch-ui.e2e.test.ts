// "Just me / Team" at the top of a team's sidebar and the audience label by the message box, in the real app on a real Team Cloud (OMB_CLOUD_ROLE=team, each person paired
// with the Admin's signed claim) in headless Chrome: what one member types under Just me reaches no other member and no
// admin, on screen or through the API, and what they type under Team reaches both. Run with OMB_UI_E2E=1;
// OMB_TEAM_SWITCH_SHOTS=DIR keeps the screenshots there.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
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
if (!enabled) console.info("skipping the Just me / Team UI e2e: set OMB_UI_E2E=1");

const SHOTS = process.env.OMB_TEAM_SWITCH_SHOTS || join(REPO_ROOT, ".omb-scratch", "team-side-switch");
const PRIVATE = "Kumquat salary plan for March";
const SHARED = "Team lunch is on Friday";
const DESKTOP = ["1280", "800"] as const, PHONE = ["390", "844"] as const;

/** A new member is offered their own MausBot in a dialog over the app; this run leaves it for later. */
const DISMISS = `(() => { [...document.querySelectorAll('[role="dialog"] button, dialog button')].find((button) => button.textContent.trim() === "Not now")?.click(); return true; })()`;

type Task = { threadId: string; private?: true; sharedChat?: true; unread?: boolean };
type Bot = { id: string; threadId: string; mainThreadId: string; tasks: Task[] };
type App = Awaited<ReturnType<typeof openAs>>;

let fx: CloudSendFixture, team: CloudTeamFixture;
let tools: { binary: string; chrome: string | null };
const tokens: Record<"olive" | "ada" | "ben", string> = { olive: "", ada: "", ben: "" };
let scout = "", main = "";
const apps: App[] = [];

const scoutAs = async (who: keyof typeof tokens) => ((await team.as(tokens[who], "GET", "/api/bots?messages=0")).body.bots as Bot[]).find((bot) => bot.id === scout)!;
const wordsIn = async (who: keyof typeof tokens, threadId: string) => {
  const page = await team.as(tokens[who], "GET", `/api/threads/${threadId}/messages?limit=50`);
  return { status: page.status, text: JSON.stringify(page.body) };
};

/** The real renderer on the team's Cloud, signed in as one person, and what they do with it. */
async function openAs(who: keyof typeof tokens, size: readonly [string, string]) {
  const preview = await mountPreview({ info: { url: team.base } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Just me / Team",
    logLevel: "warn", proxyHeaders: { ...fx.edge, authorization: `Bearer ${tokens[who]}` } });
  // agent-browser 0.37 refuses a socket path over 103 bytes, and it lives under this home.
  const home = join(fx.root, `b${apps.length}`);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const env = sessionEnv({ home, session: `t${apps.length}`, chrome: tools.chrome });
  const browser = (...args: string[]) => agentBrowser(tools.binary, env, args, 120_000);
  await browser("set", "viewport", ...size);
  const evaluate = async <T>(js: string) => (await browser("eval", js)).result as T;
  // Once-per-person cards (a sponsor's offer, say) sit over the message box: this browser has seen them before the app starts.
  await browser("open", new URL("/package.json", preview.previewUrl).href);
  await evaluate(`(() => { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); return true; })()`);
  await browser("open", preview.previewUrl);
  const side = () => evaluate<string | null>("document.querySelector('[data-team-side]')?.dataset.teamSide ?? null");
  const audience = () => evaluate<string | null>("(() => { const label = document.querySelector('[data-team-audience]'); return label ? label.dataset.teamAudience + ':' + label.textContent : null; })()");
  const app = {
    who, evaluate, side, audience,
    listed: () => evaluate<string[]>("[...document.querySelectorAll('[data-sidebar-bot-row]')].map((row) => row.dataset.sidebarBotRow)"),
    words: () => evaluate<string>("document.body.innerText"),
    async shot(name: string) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await browser("screenshot", join(SHOTS, `${name}.png`));
    },
    async openScout(on: "me" | "team") {
      await evaluate(DISMISS);
      await expect.poll(() => evaluate<boolean>(`(() => { const row = document.querySelector('[data-sidebar-bot-row="${scout}"]'); row?.click(); return Boolean(row); })()`), { timeout: 60_000, interval: 500 }).toBe(true);
      await expect.poll(async () => `${await evaluate<string>("document.querySelector('textarea')?.getAttribute('placeholder') ?? ''")} ${(await audience())?.split(":")[0]}`, { timeout: 30_000 }).toBe(`Message Scout ${on}`);
    },
    async openList() {
      await evaluate(DISMISS);
      await expect.poll(audience, { timeout: 60_000, interval: 500 }).not.toBeNull();
      await evaluate(`document.querySelector('button[aria-label="Open bot list"]')?.click(); true`);
      await expect.poll(() => evaluate<boolean>(`Boolean(document.querySelector('button[aria-label="Open bot list"][aria-expanded="true"]') && document.querySelector('[data-team-side]'))`), { timeout: 30_000 }).toBe(true);
    },
    async choose(next: "me" | "team") {
      await evaluate(`document.querySelector('[data-team-side-option="${next}"]').click(); true`);
      await expect.poll(side, { timeout: 30_000 }).toBe(next);
      await expect.poll(async () => (await audience())?.split(":")[0] ?? null, { timeout: 30_000 }).toBe(next);
    },
    async say(text: string) {
      await evaluate(`(() => { const field = document.querySelector('textarea[placeholder^="Message"]'); field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
        field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await browser("press", "Enter");
      await expect.poll(() => evaluate<string>("document.querySelector('main')?.innerText ?? ''"), { timeout: 30_000 }).toContain(text);
    },
    /** Types without sending. */
    async draft(text: string) {
      await evaluate(`(() => { const field = document.querySelector('textarea[placeholder^="Message"]'); field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
        field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
    },
    typed: () => evaluate<string>(`document.querySelector('textarea[placeholder^="Message"]')?.value ?? ""`),
    saved: () => evaluate<string | null>(`localStorage.getItem("omb.team-side.team-acme-switch." + ${JSON.stringify(`${who}@acme.test`)})`),
    async reload() {
      await evaluate("location.reload(); true");
      await expect.poll(() => evaluate<boolean>(`Boolean(document.querySelector('[data-sidebar-bot-row="${scout}"]'))`), { timeout: 60_000, interval: 500 }).toBe(true);
    },
    async close() {
      await browser("close").catch(() => {});
      await preview.close();
    },
  };
  apps.push(app);
  return app;
}

(enabled ? describe : describe.skip)("Just me / Team on a Team Cloud, in the real app", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    tools = await ensureUiBrowser(process.env);
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-switch-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-switch", name: "Acme" } });
    team = fx.team!;
    tokens.olive = (await team.pair({ email: "olive@acme.test", role: "owner" })).token!;
    tokens.ada = (await team.pair({ email: "ada@acme.test", role: "member" })).token!;
    tokens.ben = (await team.pair({ email: "ben@acme.test", role: "member" })).token!;
    const onboarding = { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS, "cloud-welcome-done", "cloud-setup-hidden"] };
    expect((await team.as(tokens.olive, "PATCH", "/api/config", { onboarding, language: "en" })).status).toBe(200);
    for (const who of ["ada", "ben"] as const) expect((await team.as(tokens[who], "PUT", "/api/me/welcome", { welcomed: true })).status).toBe(200);
    // Each person said yes to "Add MausBot", as its card saves it: their own helper sits at the top of their sidebar.
    for (const who of ["olive", "ada", "ben"] as const) {
      const own = ((await team.as(tokens[who], "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; defaultBot?: { person?: string } }>).find((bot) => bot.defaultBot?.person === `${who}@acme.test`)!;
      const added = await team.as(tokens[who], "PATCH", `/api/bots/${own.id}`, { welcomed: true, sidebarHidden: false, pinned: true });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
    }
    const created = await team.as(tokens.olive, "POST", "/api/bots", { name: "Scout" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    scout = created.body.bot.id; main = created.body.bot.mainThreadId;
  }, hostTimeout(300_000));
  afterAll(async () => {
    for (const app of apps) await app.close().catch(() => {});
    await fx?.close();
  }, hostTimeout(120_000));

  let adaOwn = "", mine = "";

  it("a member's Just me chat is hers alone and her Team message is the team's, each sent to the conversation the label names", async () => {
    const ada = await openAs("ada", DESKTOP);
    await expect.poll(ada.side, { timeout: 60_000, interval: 500 }).toBe("me");
    expect(await ada.evaluate<string | null>("document.querySelector('[data-team-side-hint]')?.textContent ?? null"), "said once, the first time").toBe("Just me is private, even from admins. Team is shared.");
    expect(await ada.evaluate<string[]>("[...document.querySelectorAll('[data-team-side] [role=radio]')].map((radio) => radio.textContent.trim() + ':' + radio.getAttribute('aria-checked'))")).toEqual(["Just me:true", "Team:false"]);
    await ada.openScout("me");
    expect(await ada.audience(), "by the message box").toBe("me:Private · only you");
    await ada.say(PRIVATE);
    await ada.shot("01-ada-just-me-desktop");

    const bots = (await team.as(tokens.ada, "GET", "/api/bots?messages=0")).body.bots as Array<Bot & { defaultBot?: { person?: string } }>;
    mine = bots.find((bot) => bot.defaultBot?.person === "ada@acme.test")!.id;
    expect(await ada.listed(), "Just me lists her own MausBot and the bots she can chat with").toEqual(expect.arrayContaining([scout, mine]));
    const own = (await scoutAs("ada")).tasks.filter((task) => task.private === true);
    expect(own.length, "one private conversation, made by the click").toBe(1);
    adaOwn = own[0]!.threadId;
    expect(adaOwn).not.toBe(main);
    expect((await wordsIn("ada", adaOwn)).text).toContain(PRIVATE);
    expect((await wordsIn("ada", main)).text, "nothing typed under Just me reaches the shared chat").not.toContain(PRIVATE);

    await ada.choose("team");
    expect(await ada.audience()).toBe("team:Shared · everyone in Acme can see");
    expect(await ada.listed(), "a private-only bot is not on the Team side").not.toContain(mine);
    expect(await ada.listed()).toContain(scout);
    expect(await ada.words(), "nothing of the private chat on the Team side: not the transcript, not the sidebar").not.toContain(PRIVATE);
    await ada.say(SHARED);
    await ada.shot("02-ada-team-desktop");
    expect((await wordsIn("ada", main)).text).toContain(SHARED);
    expect((await wordsIn("ada", main)).text).not.toContain(PRIVATE);
    expect((await wordsIn("ada", adaOwn)).text, "nothing typed under Team lands in her private chat").not.toContain(SHARED);

    await ada.reload();
    await expect.poll(ada.side, { timeout: 60_000, interval: 500 }).toBe("team");
    await expect.poll(async () => (await ada.audience())?.split(":")[0] ?? null, { timeout: 30_000 }).toBe("team");
    await ada.choose("me");
    expect(await ada.audience()).toBe("me:Private · only you");
    expect(await ada.evaluate<string>("document.querySelector('main').innerText")).toContain(PRIVATE);
    expect(await ada.words(), "and nothing of the shared chat under Just me").not.toContain(SHARED);
    expect((await scoutAs("ada")).tasks.filter((task) => task.private === true).length, "going back opens her chat, it makes no second one").toBe(1);
    await ada.close();
  }, hostTimeout(300_000));

  it("a reload keeps a member in her private chat and keeps her choice, whatever conversation the server would show first", async () => {
    const ada = await openAs("ada", DESKTOP);
    await ada.openScout("me");
    await ada.choose("team");
    await ada.choose("me");
    expect(await ada.saved(), "she pressed Just me").toBe("me");
    for (let round = 0; round < 2; round++) {
      // A teammate opens the bot's shared chat meanwhile, so the bot's own pick of a conversation is the shared one.
      expect((await team.as(tokens.ben, "POST", `/api/bots/${scout}/tasks/${main}`, {})).status).toBe(200);
      expect((await scoutAs("ada")).threadId, "what her page is sent first").toBe(main);
      await ada.reload();
      await expect.poll(async () => `${await ada.side()} ${await ada.audience()}`, { timeout: 60_000, interval: 500 }).toBe("me me:Private · only you");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(`${await ada.side()} ${await ada.audience()}`, "and it stays there").toBe("me me:Private · only you");
      expect(await ada.saved(), "a reload never rewrites what she chose").toBe("me");
      expect(await ada.evaluate<string>("document.querySelector('main').innerText"), "her own conversation, the one she was in").toContain(PRIVATE);
      // The same teammate opening the shared chat again while her page is open moves nothing under her.
      expect((await team.as(tokens.ben, "POST", `/api/bots/${scout}/tasks/${main}`, {})).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(`${await ada.side()} ${await ada.audience()} ${await ada.saved()}`).toBe("me me:Private · only you me");
    }
    expect((await scoutAs("ada")).tasks.filter((task) => task.private === true).map((task) => task.threadId), "no second private chat is made").toEqual([adaOwn]);

    const AFTER = "Typed after the reload, for me alone";
    await ada.say(AFTER);
    expect((await wordsIn("ada", adaOwn)).text).toContain(AFTER);
    expect((await wordsIn("ada", main)).text, "what she types after a reload never reaches the shared chat").not.toContain(AFTER);

    const DRAFT = "A private thought not sent yet";
    await ada.draft(DRAFT);
    await ada.choose("team");
    expect(await ada.typed(), "a draft typed under Just me is not in the Team message box").toBe("");
    await ada.reload();
    await expect.poll(ada.audience, { timeout: 60_000, interval: 500 }).toBe("team:Shared · everyone in Acme can see");
    expect(await ada.typed(), "nor after a reload").toBe("");
    expect(await ada.saved(), "she pressed Team").toBe("team");
    await ada.choose("me");
    expect(await ada.typed(), "it waits where it was typed").toBe(DRAFT);
    expect((await wordsIn("ada", main)).text).not.toContain(DRAFT);
    await ada.draft("");
    await ada.close();
  }, hostTimeout(300_000));

  it("the switch stays reachable and the label visible at phone width", async () => {
    const ada = await openAs("ada", PHONE);
    await ada.openList();
    const fits = (selector: string) => ada.evaluate<boolean>(`(() => { const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return Boolean(box && box.width > 0 && box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight); })()`);
    await ada.shot("03-ada-list-just-me-phone");
    expect(await fits("[data-team-side] [role=radiogroup]"), "the whole switch is on screen in the bot list").toBe(true);
    await ada.evaluate(`document.querySelector('[data-team-side-option="team"]').click(); true`);
    await expect.poll(ada.side, { timeout: 30_000 }).toBe("team");
    expect(await ada.listed(), "the list changed and stayed open").toContain(scout);
    expect(await ada.listed()).not.toContain(mine);
    await ada.shot("04-ada-list-team-phone");
    await ada.openScout("team");
    await expect.poll(ada.audience, { timeout: 30_000 }).toBe("team:Shared · everyone in Acme can see");
    expect(await fits("[data-team-audience]"), "the label is on screen by the message box").toBe(true);
    await ada.shot("05-ada-team-chat-phone");
    await ada.openList();
    await ada.evaluate(`document.querySelector('[data-team-side-option="me"]').click(); true`);
    await expect.poll(ada.side, { timeout: 30_000 }).toBe("me");
    await ada.openScout("me");
    await expect.poll(ada.audience, { timeout: 30_000 }).toBe("me:Private · only you");
    expect(await fits("[data-team-audience]")).toBe(true);
    await ada.shot("06-ada-just-me-chat-phone");
    expect(await ada.evaluate<number>("document.scrollingElement.scrollWidth - window.innerWidth"), "no sideways scroll").toBeLessThanOrEqual(1);
    expect((await scoutAs("ada")).tasks.filter((task) => task.private === true).map((task) => task.threadId), "another device opens her chat, it makes no second one").toEqual([adaOwn]);
    await ada.close();
  }, hostTimeout(300_000));

  for (const [who, role] of [["ben", "another member"], ["olive", "the team's owner, an admin"]] as const) {
    it(`${role} reads the Team message and never the Just me chat`, async () => {
      const listed = await scoutAs(who);
      expect(listed.tasks.some((task) => task.threadId === adaOwn), "not in their list of conversations").toBe(false);
      expect(JSON.stringify((await team.as(tokens[who], "GET", "/api/bots")).body), "nor its words in anything listed").not.toContain(PRIVATE);
      expect((await wordsIn(who, adaOwn)).status, "opening it by id: no such conversation").toBe(404);

      const app = await openAs(who, DESKTOP);
      await expect.poll(app.side, { timeout: 60_000, interval: 500 }).toBe("me");
      await app.openScout("me");
      expect(await app.audience()).toBe("me:Private · only you");
      expect(await app.words(), "their own Just me has none of hers").not.toContain(PRIVATE);
      expect((await scoutAs(who)).tasks.filter((task) => task.private === true).map((task) => task.threadId), "their own private chat, not hers").not.toContain(adaOwn);
      await app.choose("team");
      await expect.poll(() => app.evaluate<string>("document.querySelector('main').innerText"), { timeout: 30_000 }).toContain(SHARED);
      expect(await app.words(), "nowhere on the Team side, sidebar included").not.toContain(PRIVATE);
      await app.shot(who === "ben" ? "07-ben-team-desktop" : "08-admin-team-desktop");
      await app.close();
    }, hostTimeout(300_000));
  }
});
