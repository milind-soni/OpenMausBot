// A team bot is its maker's until they share it, in the real app on a real Team Cloud (OMB_CLOUD_ROLE=team, each person
// paired with the Admin's signed claim) in headless Chrome. Rui, an admin, makes a bot with New bot: it is private, under
// Just me only, and Marta, a User, neither sees it nor reaches it by id. Rui shares it with Marta from the Share button at
// the top right of the chat: her face shows beside it, she gets one line in her inbox and can chat, and another User
// still sees nothing. The Templates form states who can use a new bot, preset to Just me. `/?connect=bots` opens Bot
// access for an admin and nothing for a User. Run with OMB_UI_E2E=1; OMB_TEAM_PRIVATE_SHOTS=DIR keeps the screenshots.
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
if (!enabled) console.info("skipping the private-until-shared UI e2e: set OMB_UI_E2E=1");

const SHOTS = process.env.OMB_TEAM_PRIVATE_SHOTS || join(REPO_ROOT, ".omb-scratch", "team-private-default");
const DESKTOP = ["1280", "800"] as const, PHONE = ["390", "844"] as const;
const PEOPLE = { olive: "owner", rui: "admin", marta: "member", ben: "member" } as const;
type Who = keyof typeof PEOPLE;
const address = (who: Who) => `${who}@acme.test`;

/** A new member is offered their own MausBot in a dialog over the app; this run leaves it for later. */
const DISMISS = `(() => { [...document.querySelectorAll('[role="dialog"] button, dialog button')].find((button) => button.textContent.trim() === "Not now")?.click(); return true; })()`;

type Access = { everyone: string; people: Record<string, string> };
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; access?: Access; yourAccess?: string; defaultBot?: { person?: string } };
type App = Awaited<ReturnType<typeof openAs>>;

let fx: CloudSendFixture, team: CloudTeamFixture;
let tools: { binary: string; chrome: string | null };
const tokens = {} as Record<Who, string>;
const apps: App[] = [];

const botsOf = async (who: Who) => (await team.as(tokens[who], "GET", "/api/bots?messages=0")).body.bots as Bot[];
const notices = async (who: Who) => (((await team.as(tokens[who], "GET", "/api/inbox")).body.rows ?? []) as Array<{ kind: string; text: string }>).filter((row) => row.kind === "notice").map((row) => row.text);

/** The real renderer on the team's Cloud, signed in as one person, and what they do with it. */
async function openAs(who: Who, size: readonly [string, string], query = "") {
  const preview = await mountPreview({ info: { url: team.base } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Private until shared",
    logLevel: "warn", proxyHeaders: { ...fx.edge, authorization: `Bearer ${tokens[who]}` } });
  // agent-browser 0.37 refuses a socket path over 103 bytes, and it lives under this home.
  const home = join(fx.root, `b${apps.length}`);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const env = sessionEnv({ home, session: `t${apps.length}`, chrome: tools.chrome });
  const browser = (...args: string[]) => agentBrowser(tools.binary, env, args, 120_000);
  await browser("set", "viewport", ...size);
  const evaluate = async <T>(js: string) => (await browser("eval", js)).result as T;
  await browser("open", new URL("/package.json", preview.previewUrl).href);
  await evaluate(`(() => { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); return true; })()`);
  await browser("open", `${preview.previewUrl}${query}`);
  const until = (js: string, timeout = 60_000) => expect.poll(() => evaluate<boolean>(`Boolean(${js})`), { timeout, interval: 400 }).toBe(true).catch(async (cause: unknown) => {
    await browser("screenshot", join(SHOTS, `failed-${who}.png`)).catch(() => {});
    throw cause;
  });
  const click = async (selector: string) => {
    await until(`document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  };
  const app = {
    who, evaluate, until, click, browser,
    side: () => evaluate<string | null>("document.querySelector('[data-team-side]')?.dataset.teamSide ?? null"),
    audience: () => evaluate<string | null>("(() => { const label = document.querySelector('[data-team-audience]'); return label ? label.dataset.teamAudience + ':' + label.textContent : null; })()"),
    listed: () => evaluate<string[]>("[...document.querySelectorAll('[data-sidebar-bot-row]')].map((row) => row.dataset.sidebarBotRow)"),
    words: () => evaluate<string>("document.body.innerText"),
    /** Who the header says the bot is shared with: "private", "people", "everyone" or "added". */
    sharedWith: () => evaluate<string | null>("document.querySelector('[data-header-share]')?.dataset.headerShare ?? null"),
    faces: () => evaluate<string[]>("[...document.querySelectorAll('[data-header-share] [data-access-stack]')].filter((stack) => stack.getClientRects().length).flatMap((stack) => [...stack.querySelectorAll('button')].map((face) => (face.dataset.accessFace ? 'face:' : 'more:') + face.title))"),
    marker: () => evaluate<string | null>("document.querySelector('[data-header-share] [data-shared-with-marker]')?.title ?? null"),
    fits: (selector: string) => evaluate<boolean>(`(() => { const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return Boolean(box && box.width > 0 && box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight); })()`),
    async shot(name: string) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await browser("screenshot", join(SHOTS, `${name}.png`));
    },
    async ready() {
      await evaluate(DISMISS);
      await until("document.querySelector('[data-sidebar-bot-row]') || document.querySelector('textarea')");
      await evaluate(DISMISS);
      // An admin is shown the team's setup first, then its checklist over the foot of the sidebar, where this run clicks bots.
      for (const label of ["Skip setup", "Hide setup"]) {
        await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(label)})?.click(); true`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
    async choose(next: "me" | "team") {
      await click(`[data-team-side-option="${next}"]`);
      await expect.poll(app.side, { timeout: 30_000 }).toBe(next);
    },
    async openBot(id: string) {
      await evaluate(DISMISS);
      await click(`[data-sidebar-bot-row="${id}"]`);
      await until(`document.querySelector('textarea[placeholder^="Message"]')`);
    },
    async openList() {
      await evaluate(DISMISS);
      await click('button[aria-label="Open bot list"]');
      await until(`document.querySelector('button[aria-label="Open bot list"][aria-expanded="true"]')`, 30_000);
    },
    async say(text: string) {
      await evaluate(`(() => { const field = document.querySelector('textarea[placeholder^="Message"]'); field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
        field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await browser("press", "Enter");
      await expect.poll(() => evaluate<string>("document.querySelector('main')?.innerText ?? ''"), { timeout: 30_000 }).toContain(text);
    },
    async type(selector: string, text: string) {
      await until(`document.querySelector(${JSON.stringify(selector)})`);
      await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
        field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    },
    /** The header's Share dialog: opened from the Share button itself. */
    async openShare() {
      await click("[data-header-share] [data-share-bot-button]");
      await until("document.querySelector('[data-share-bot]')");
    },
    async closeShare() {
      await evaluate(`[...document.querySelectorAll('[data-share-bot] footer button')].at(-1).click(); true`);
      await until("!document.querySelector('[data-share-bot]')");
    },
    async close() {
      await browser("close").catch(() => {});
      await preview.close();
    },
  };
  apps.push(app);
  return app;
}

(enabled ? describe : describe.skip)("a team bot is its maker's until they share it, in the real app", () => {
  let scout = "", quotes: Bot;

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    tools = await ensureUiBrowser(process.env);
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-private-default-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-private-ui", name: "Acme" } });
    team = fx.team!;
    for (const who of Object.keys(PEOPLE) as Who[]) tokens[who] = (await team.pair({ email: address(who), role: PEOPLE[who] })).token!;
    const onboarding = { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS, "cloud-welcome-done", "cloud-setup-hidden"] };
    expect((await team.as(tokens.olive, "PATCH", "/api/config", { onboarding, language: "en" })).status).toBe(200);
    for (const who of Object.keys(PEOPLE) as Who[]) {
      await team.as(tokens[who], "PUT", "/api/me/welcome", { welcomed: true });
      const own = (await botsOf(who)).find((bot) => bot.defaultBot?.person === address(who))!;
      const added = await team.as(tokens[who], "PATCH", `/api/bots/${own.id}`, { welcomed: true, sidebarHidden: false, pinned: true });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
    }
    // One bot the whole team already uses, so everyone has a Team side to compare with.
    const created = await team.as(tokens.olive, "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    scout = created.body.bot.id;
  }, hostTimeout(300_000));
  afterAll(async () => {
    for (const app of apps) await app.close().catch(() => {});
    await fx?.close();
  }, hostTimeout(120_000));

  it("New bot makes a bot only Rui and the admins can use: under Just me only, and a User neither sees it nor reaches it", async () => {
    const rui = await openAs("rui", DESKTOP);
    await rui.ready();
    const before = new Set((await botsOf("rui")).map((bot) => bot.id));
    await rui.click('button[aria-label="New or share"]');
    await rui.until(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].some((item) => /^new bot$/i.test(item.textContent.trim()))`);
    await rui.evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((item) => /^new bot$/i.test(item.textContent.trim())).click(); true`);
    await expect.poll(async () => (await botsOf("rui")).filter((bot) => !before.has(bot.id)).length, { timeout: 60_000, interval: 500 }).toBe(1);
    quotes = (await botsOf("rui")).find((bot) => !before.has(bot.id))!;
    expect(quotes.access, "Only people added, nobody added").toEqual({ everyone: "none", people: {} });

    await rui.until(`document.querySelector('[data-sidebar-bot-row="${quotes.id}"]') && document.querySelector('textarea[placeholder^="Message"]')`);
    await expect.poll(rui.audience, { timeout: 30_000 }).toBe("me:Private · only you");
    await expect.poll(rui.sharedWith, { timeout: 30_000 }).toBe("private");
    expect(await rui.faces(), "no face and no mark beside Share").toEqual([]);
    expect(await rui.marker()).toBeNull();
    expect(await rui.fits("[data-header-share] [data-share-bot-button]"), "Share is at the top of the chat").toBe(true);
    await rui.shot("01-rui-new-bot-private-desktop");
    await rui.choose("team");
    expect(await rui.listed(), "a bot nobody else can use is not on the Team side").not.toContain(quotes.id);
    expect(await rui.listed()).toContain(scout);
    await rui.shot("02-rui-team-side-without-it-desktop");
    await rui.choose("me");
    expect(await rui.listed()).toContain(quotes.id);

    for (const who of ["marta", "ben"] as const) {
      expect((await botsOf(who)).some((bot) => bot.id === quotes.id), `${who}'s list`).toBe(false);
      expect((await team.as(tokens[who], "GET", `/api/threads/${quotes.mainThreadId ?? quotes.threadId}/messages?limit=5`)).status, `${who} by id`).toBe(404);
      expect((await team.as(tokens[who], "POST", `/api/bots/${quotes.id}/messages`, { text: "hello" })).status, `${who} writing to it`).toBe(404);
    }
    const marta = await openAs("marta", DESKTOP);
    await marta.ready();
    expect(await marta.listed()).not.toContain(quotes.id);
    expect(await marta.words()).not.toContain(quotes.name);
    await marta.choose("team");
    expect(await marta.listed()).not.toContain(quotes.id);
    expect(await marta.words()).not.toContain(quotes.name);
    await marta.shot("03-marta-cannot-see-it-desktop");
    await marta.close();
    await rui.close();
  }, hostTimeout(420_000));

  it("Rui shares it with Marta from the header's Share: her face shows there, she is told once in her inbox and can chat", async () => {
    const rui = await openAs("rui", DESKTOP);
    await rui.ready();
    await rui.openBot(quotes.id);
    await rui.openShare();
    expect(await rui.evaluate<string>("document.querySelector('[data-share-bot] [data-share-general]').dataset.shareGeneral")).toBe("none");
    await rui.shot("04-rui-share-dialog-desktop");
    await rui.type('[data-share-bot] input[role="combobox"]', "Marta");
    await rui.until(`document.querySelector('[data-share-suggestion="${address("marta")}"]')`);
    await rui.evaluate(`document.querySelector('[data-share-suggestion="${address("marta")}"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); true`);
    await expect.poll(async () => (await botsOf("rui")).find((bot) => bot.id === quotes.id)?.access, { timeout: 30_000 }).toEqual({ everyone: "none", people: { [address("marta")]: "chat" } });
    await rui.closeShare();
    await expect.poll(rui.sharedWith, { timeout: 30_000 }).toBe("people");
    expect(await rui.faces(), "her face, named, beside Share").toEqual(["face:Marta"]);
    expect(await rui.fits(`[data-header-share] [data-access-face="${address("marta")}"]`)).toBe(true);
    await rui.shot("05-rui-shared-with-marta-desktop");
    await rui.choose("team");
    expect(await rui.listed(), "shared with someone, it is on the Team side now").toContain(quotes.id);
    await rui.choose("me");

    expect(await notices("marta")).toEqual([`Rui shared ${quotes.name} with you.`]);
    expect(await notices("ben"), "nobody else is told").toEqual([]);
    expect((await botsOf("ben")).some((bot) => bot.id === quotes.id), "and nobody else sees it").toBe(false);

    const marta = await openAs("marta", DESKTOP);
    await marta.ready();
    await marta.until(`document.querySelector('[data-sidebar-bot-row="${quotes.id}"]')`);
    const line = `document.body.innerText.includes(${JSON.stringify(`Rui shared ${quotes.name} with you.`)})`;
    if (!(await marta.evaluate<boolean>(line))) await marta.evaluate(`[...document.querySelectorAll('button')].find((button) => /inbox/i.test(button.getAttribute('aria-label') ?? button.textContent ?? ''))?.click(); true`);
    await marta.until(line);
    await marta.shot("06-marta-inbox-line-desktop");
    await marta.openBot(quotes.id);
    await expect.poll(marta.audience, { timeout: 30_000 }).toBe("me:Private · only you");
    await marta.say("What does a quote for ten seats cost?");
    await expect.poll(marta.sharedWith, { timeout: 30_000 }).toBe("added");
    expect(await marta.marker(), "she is told it is shared, never with whom").toBe("Only people added");
    expect(await marta.faces()).toEqual([]);
    await marta.shot("07-marta-chats-desktop");
    const mine = (await botsOf("marta")).find((bot) => bot.id === quotes.id)!;
    expect(mine.yourAccess).toBe("chat");
    expect(mine.access, "the server sends her no list").toBeUndefined();
    await marta.close();

    await rui.openBot(quotes.id);
    await rui.openShare();
    await rui.click('[data-share-bot] button[aria-label="General access"]');
    await rui.click('[role="menu"] [data-menu-key="everyone"]');
    await expect.poll(async () => (await botsOf("rui")).find((bot) => bot.id === quotes.id)?.access?.everyone, { timeout: 30_000 }).toBe("chat");
    await rui.closeShare();
    await expect.poll(rui.sharedWith, { timeout: 30_000 }).toBe("everyone");
    expect(await rui.marker()).toBe("Everyone in Acme");
    expect(await rui.faces(), "one mark, no faces").toEqual([]);
    await rui.shot("08-rui-shared-with-everyone-desktop");
    expect(await notices("ben"), "sharing with everyone tells nobody").toEqual([]);
    expect((await botsOf("ben")).find((bot) => bot.id === quotes.id)?.yourAccess).toBe("chat");
    await rui.close();
  }, hostTimeout(480_000));

  it("at phone width the header keeps the bot's name: faces fold into a count, and each mark still opens Share", async () => {
    const shared = await team.as(tokens.rui, "PUT", `/api/bots/${quotes.id}/access`, { everyone: "none", people: { [address("marta")]: "chat", [address("ben")]: "chat" } });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const rui = await openAs("rui", PHONE);
    await rui.ready();
    await rui.openList();
    await rui.click(`[data-sidebar-bot-row="${quotes.id}"]`);
    await rui.until("document.querySelector('textarea[placeholder^=\"Message\"]') && document.querySelector('[data-header-share]')");
    await expect.poll(rui.sharedWith, { timeout: 30_000 }).toBe("people");
    expect(await rui.faces(), "one count for the two people").toEqual(["more:Marta, Ben"]);
    expect(await rui.fits("[data-header-share]"), "who it is shared with and Share are on screen").toBe(true);
    expect(await rui.evaluate<boolean>(`[...document.querySelectorAll('main *')].some((node) => { const box = node.getBoundingClientRect();
      return node.children.length === 0 && node.textContent.trim() === ${JSON.stringify(quotes.name)} && node.scrollWidth <= node.clientWidth && box.width > 20 && box.right <= window.innerWidth; })`), "the bot's whole name is still shown").toBe(true);
    expect(await rui.evaluate<number>("document.scrollingElement.scrollWidth - window.innerWidth"), "no sideways scroll").toBeLessThanOrEqual(1);
    await rui.shot("09-rui-shared-with-two-phone");
    await rui.evaluate(`[...document.querySelectorAll('[data-header-share] [data-access-more]')].find((chip) => chip.getClientRects().length).click(); true`);
    await rui.until("document.querySelector('[data-share-bot]')");
    await rui.shot("10-rui-share-dialog-phone");
    await rui.closeShare();
    await rui.close();

    const marta = await openAs("marta", PHONE);
    await marta.ready();
    await marta.openList();
    await marta.click(`[data-sidebar-bot-row="${quotes.id}"]`);
    await marta.until("document.querySelector('[data-header-share] [data-shared-with-marker]')");
    expect(await marta.marker()).toBe("Only people added");
    expect(await marta.fits("[data-header-share]")).toBe(true);
    expect(await marta.evaluate<number>("document.scrollingElement.scrollWidth - window.innerWidth")).toBeLessThanOrEqual(1);
    await marta.shot("11-marta-shared-mark-phone");
    await marta.close();
  }, hostTimeout(420_000));

  it("the Templates form says who can use the new bot, preset to Just me; choosing Everyone in Acme shares it from the start", async () => {
    const rui = await openAs("rui", DESKTOP);
    await rui.ready();
    const addFromTemplates = async (everyone: boolean) => {
      const before = new Set((await botsOf("rui")).map((bot) => bot.id));
      await rui.click('button[aria-label="New or share"]');
      await rui.until(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].some((item) => /templates/i.test(item.textContent))`);
      await rui.evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((item) => /templates/i.test(item.textContent)).click(); true`);
      await rui.click("[data-ready-bot] button");
      await rui.until("document.querySelector('[data-new-bot-shared]')");
      expect(await rui.evaluate<string>("document.querySelector('[data-new-bot-shared]').dataset.newBotShared"), "preset to Just me").toBe("me");
      expect(await rui.evaluate<string[]>("[...document.querySelectorAll('[data-new-bot-shared] option')].map((option) => option.textContent)")).toEqual(["Just me", "Everyone in Acme"]);
      expect(await rui.evaluate<boolean>("Boolean(document.querySelector('[data-new-bot-visibility]'))"), "one choice, not two").toBe(false);
      if (everyone) {
        await rui.evaluate(`(() => { const select = document.querySelector('[data-new-bot-shared] select');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "everyone");
          select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
        await rui.until(`document.querySelector('[data-new-bot-shared]').dataset.newBotShared === "everyone"`);
      }
      await rui.shot(everyone ? "13-rui-form-everyone-desktop" : "12-rui-form-just-me-desktop");
      await rui.evaluate(`[...document.querySelectorAll('[role="dialog"][aria-label] button')].find((button) => button.textContent.trim() === "Create bot").click(); true`);
      await expect.poll(async () => (await botsOf("rui")).filter((bot) => !before.has(bot.id)).length, { timeout: 90_000, interval: 500 }).toBe(1);
      await rui.until("!document.querySelector('[data-new-bot-shared]')");
      return (await botsOf("rui")).find((bot) => !before.has(bot.id))!;
    };
    const mine = await addFromTemplates(false);
    expect(mine.access).toEqual({ everyone: "none", people: {} });
    expect((await botsOf("marta")).some((bot) => bot.id === mine.id)).toBe(false);
    const open = await addFromTemplates(true);
    expect(open.access).toEqual({ everyone: "chat", people: {} });
    expect((await botsOf("marta")).find((bot) => bot.id === open.id)?.yourAccess).toBe("chat");
    await rui.close();
  }, hostTimeout(480_000));

  it("/?connect=bots opens Settings → Bot access for an admin, and nothing for a User", async () => {
    for (const [size, name] of [[DESKTOP, "14-admin-bot-access-link-desktop"], [PHONE, "15-admin-bot-access-link-phone"]] as const) {
      const olive = await openAs("olive", size, "?connect=bots");
      await olive.until("document.querySelector('[data-access-overview]')");
      expect(await olive.evaluate<string>("location.search"), "the address is left clean").toBe("");
      expect(await olive.evaluate<string[]>("[...document.querySelectorAll('[data-access-row]')].map((row) => row.dataset.accessRow)")).toEqual(expect.arrayContaining([quotes.id, scout]));
      await olive.shot(name);
      await olive.close();
    }
    const marta = await openAs("marta", DESKTOP, "?connect=bots");
    await marta.ready();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await marta.evaluate<string>("location.search")).toBe("");
    expect(await marta.evaluate<boolean>("Boolean(document.querySelector('[data-access-overview]'))"), "a User is shown no Bot access").toBe(false);
    expect(await marta.words()).not.toContain("Bot access");
    await marta.shot("16-user-bot-access-link-does-nothing-desktop");
    await marta.close();
  }, hostTimeout(420_000));
});
