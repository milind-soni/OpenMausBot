import { canManage, canReach } from "./peer-roster.ts";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOVE_BOT_FIELDS, moveKindsRoute, type MoveKindsDeps } from "./cloud-send-kinds.ts";
import { chiefLevel, readTeamRolesWith } from "./chief-level.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { defaultBotPatchRefusal, ensureDefaultBot, placeMausBotUnused, unusedStarter } from "./default-bot.ts";
import * as mdb from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";
import { availableTools, catalogProfileFromEnv } from "./drivers/agents-catalog.ts";
import { createBrief } from "./host/brief.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const placeMausBots = (store: Store) => store.bots.filter((bot) => bot.defaultBot && !bot.defaultBot.person);
const intros = (store: Store, bot: BotRecord) => (bot.tasks ?? []).flatMap((task) => store.messagesFor(task.threadId)).filter((message) => message.helperIntro);
const boot = (store: Store) => ensureDefaultBot(store, { dataDir: DATA_DIR });
/** Who the daily brief comes from, as the server picks it. */
const briefChief = (store: Store) => createBrief({ store, dataDir: DATA_DIR, hosted: false, watching: () => true, mainThread: (id) => store.bot(id)?.threadId,
  threadBusy: () => false, notify: () => {}, runs: () => [], needsYou: () => [], engineName: () => "Claude", hostTimeZone: () => "UTC", language: () => undefined, session: () => null,
  address: () => undefined, failRun: () => {}, keep: () => {}, items: () => null }).chief();
/** A new install from before MausBot was marked: its first bot was MausBot in silver, made its Chief. */
function seededBefore(store: Store): BotRecord {
  const seeded = store.createBot({ name: "MausBot", color: "silver" });
  store.setChiefOfStaff(seeded.id);
  return seeded;
}

describe("MausBot, every person's helper", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
  afterEach(() => readTeamRolesWith(() => null));

  it("gives a fresh install one MausBot, its Chief, in chrome, introduced once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    boot(store);
    boot(store);
    const again = new Store(selection);
    again.seedIfEmpty();
    boot(again);
    expect(again.bots).toHaveLength(1);
    const maus = placeMausBots(again)[0]!;
    expect(maus).toMatchObject({ name: "MausBot", color: "chrome", chiefOfStaff: true, defaultBot: {} });
    expect(intros(again, maus)).toHaveLength(1);
  });

  it("leaves a Team Cloud member's MausBot uncrowned: it reaches no bot everyone sees, so a crown would promise work it can't hand on", () => {
    const store = new Store(selection);
    store.seedIfEmpty({ defaultBot: false });
    const own = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "ada@acme.test", team: "Acme" })!;
    expect(own.chiefOfStaff).toBeFalsy();
    const fox = store.createBot({ name: "Fox", reportsTo: "ada@acme.test" } as never);
    expect(canReach(own, fox)).toBe(false);
    expect(canManage(own, fox)).toBe(false);
  });

  it("gives an existing install without one a MausBot once on update, beside its Chief, which stays exactly as it was", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Pixel" });
    store.setChiefOfStaff(chief.id);
    store.createBot({ name: "Writer", title: "Writer", soul: "Write." });
    const before = structuredClone(store.bot(chief.id));
    const maus = boot(store)!;
    expect(maus).toMatchObject({ name: "MausBot", color: "chrome", defaultBot: {} });
    expect(maus.chiefOfStaff).toBeFalsy();
    expect(chiefLevel(maus)).toBe(true);
    expect(store.bot(chief.id)).toEqual(before);
    expect(intros(store, maus)).toHaveLength(1);
    const restarted = new Store(selection);
    boot(restarted);
    expect(placeMausBots(restarted).map((bot) => bot.id)).toEqual([maus.id]);
    expect(restarted.bots).toHaveLength(3);
    expect(restarted.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id)).toEqual([chief.id]);
  });

  it("adopts a new install's renamed MausBot with its history instead of making another, and puts the intro on top of a new conversation", () => {
    const store = new Store(selection);
    const seeded = seededBefore(store);
    const first = seeded.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "Book my flights." });
    store.patchBot(seeded.id, { name: "Jarvis" });
    const history = store.messagesFor(first).map((message) => message.id);
    store.createBot({ name: "Writer" });
    const adopted = boot(store)!;
    expect(adopted.id).toBe(seeded.id);
    expect(adopted).toMatchObject({ name: "Jarvis", color: "chrome", chiefOfStaff: true, defaultBot: {} });
    expect(store.bots).toHaveLength(2);
    expect(history).toHaveLength(2);
    expect(store.messagesFor(first).map((message) => message.id)).toEqual(history);
    expect(adopted.threadId).not.toBe(first);
    expect(store.messagesFor(adopted.threadId).map((message) => message.helperIntro)).toEqual([true]);
    boot(new Store(selection));
    expect(intros(new Store(selection), new Store(selection).bot(seeded.id)!)).toHaveLength(1);
  });

  it("keeps the colour the person gave an adopted MausBot", () => {
    const store = new Store(selection);
    const seeded = seededBefore(store);
    store.patchBot(seeded.id, { color: "blue" });
    expect(boot(store)).toMatchObject({ id: seeded.id, color: "blue" });
  });

  it("makes MausBot the Chief of a place that has none, so the brief has someone to come from", () => {
    const store = new Store(selection);
    store.createBot({ name: "Pixel" });
    const maus = boot(store)!;
    expect(store.bot(maus.id)?.chiefOfStaff).toBe(true);
    expect(briefChief(store)?.id).toBe(maus.id);
    expect(intros(store, maus)[0]?.text).toContain("Hey! I'm MausBot. I'm new here. I'm here to be your Chief of Staff. I can manage your other bots.");
  });

  it("makes an adopted MausBot the Chief when its place has none left", () => {
    const store = new Store(selection);
    const seeded = seededBefore(store);
    store.setChiefOfStaff(null);
    expect(store.bot(seeded.id)?.chiefOfStaff).toBeFalsy();
    expect(boot(store)?.id).toBe(seeded.id);
    expect(store.bot(seeded.id)?.chiefOfStaff).toBe(true);
    expect(briefChief(store)?.id).toBe(seeded.id);
  });

  it("leaves a place's own Chief as the Chief, and the brief comes from MausBot, which says so", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Clive" });
    store.setChiefOfStaff(chief.id);
    const maus = boot(store)!;
    expect(store.bot(maus.id)?.chiefOfStaff).toBeFalsy();
    expect(briefChief(store)?.id).toBe(maus.id);
    expect(intros(store, maus)[0]?.text).toContain("your helper for everything here");
    expect(intros(store, maus)[0]?.text).toContain("keep an eye on your day");
    expect(intros(store, maus)[0]?.text).not.toContain("Chief of Staff");
  });

  it("keeps a MausBot Chief hidden from the sidebar working as the Chief", () => {
    const store = new Store(selection);
    const maus = boot(store)!;
    store.patchBot(maus.id, { sidebarHidden: true });
    const restarted = new Store(selection);
    boot(restarted);
    expect(restarted.bot(maus.id)).toMatchObject({ chiefOfStaff: true, sidebarHidden: true });
    expect(briefChief(restarted)?.id).toBe(maus.id);
  });

  it("knows a renamed MausBot by its mark: no second one on update, Chief tools kept", () => {
    const store = new Store(selection);
    store.createBot({ name: "Writer" });
    const chief = store.createBot({ name: "Clive" });
    store.setChiefOfStaff(chief.id);
    const maus = boot(store)!;
    store.patchBot(maus.id, { name: "Jarvis", color: "blue" });
    const restarted = new Store(selection);
    boot(restarted);
    expect(placeMausBots(restarted).map((bot) => [bot.id, bot.name])).toEqual([[maus.id, "Jarvis"]]);
    expect(chiefLevel(restarted.bot(maus.id))).toBe(true);
    expect(restarted.bots).toHaveLength(3);
  });

  it("never takes a first bot that is not a new install's MausBot: it gets a MausBot beside it", () => {
    const store = new Store(selection);
    const pixel = store.createBot({ name: "Pixel" });
    const maus = boot(store)!;
    expect(maus.id).not.toBe(pixel.id);
    expect(store.bot(pixel.id)?.defaultBot).toBeUndefined();
  });

  it("introduces itself once: not again after the asks were answered or dismissed, nor after a restart", () => {
    const store = new Store(selection);
    const maus = boot(store)!;
    const [intro] = intros(store, maus);
    expect(intro?.card?.options).toHaveLength(4);
    store.appendMessage(maus.threadId, { role: "user", kind: "text", text: "What can you do?" });
    expect(store.messagesFor(maus.threadId).find((message) => message.id === intro!.id)?.card?.dismissed).toBe(true);
    for (let restart = 0; restart < 2; restart++) boot(new Store(selection));
    const after = new Store(selection);
    expect(intros(after, after.bot(maus.id)!)).toHaveLength(1);
  });

  it("never counts its intro as something that needs the person", () => {
    const store = new Store(selection);
    const maus = boot(store)!;
    expect(intros(store, maus)).toHaveLength(1);
    expect(mdb.attentionRows(0).filter((row) => row.kind === "options")).toEqual([]);
  });

  it("is hidden, never deleted or archived, and a hidden MausBot is never made again", () => {
    const store = new Store(selection);
    const maus = boot(store)!;
    const other = store.createBot({ name: "Writer" });
    expect(() => store.deleteBot(maus.id)).toThrow(/MausBot can't be deleted or archived/);
    expect(store.bot(maus.id)).toBeTruthy();
    expect(defaultBotPatchRefusal(maus, { hidden: true })).toMatch(/Show MausBot in the sidebar/);
    expect(defaultBotPatchRefusal(other, { sidebarHidden: true })).toMatch(/Only MausBot/);
    expect(defaultBotPatchRefusal(maus, { sidebarHidden: "yes" })).toBe("sidebarHidden must be true or false");
    expect(defaultBotPatchRefusal(maus, { sidebarHidden: true })).toBeNull();
    store.patchBot(maus.id, { sidebarHidden: true });
    const restarted = new Store(selection);
    boot(restarted);
    expect(placeMausBots(restarted).map((bot) => [bot.id, bot.sidebarHidden])).toEqual([[maus.id, true]]);
    restarted.patchBot(maus.id, { sidebarHidden: false });
    expect(new Store(selection).bot(maus.id)?.sidebarHidden).toBe(false);
  });

  it("is never made twice for one place, even once its mark is gone", () => {
    const store = new Store(selection);
    const maus = boot(store)!;
    store.patchBot(maus.id, { defaultBot: undefined });
    expect(boot(store)).toBeNull();
    expect(store.bots).toHaveLength(1);
  });

  it("keeps the oldest when two are marked", () => {
    const store = new Store(selection);
    const first = boot(store)!;
    const second = store.createBot({ name: "MausBot 2" });
    store.patchBot(second.id, { defaultBot: {} });
    expect(boot(store)?.id).toBe(first.id);
    expect(placeMausBots(store).map((bot) => bot.id)).toEqual([first.id]);
  });

  it("gives each Team Cloud member their own private MausBot, and the team no MausBot of its own", () => {
    const store = new Store(selection);
    store.seedIfEmpty({ defaultBot: false });
    expect(store.bots).toHaveLength(1);
    expect(store.bots[0]).toMatchObject({ chiefOfStaff: true });
    expect(store.bots[0]?.defaultBot).toBeUndefined();
    const ada = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "Ada@Example.com", team: "Acme" })!;
    const bea = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "bea@example.com", team: "Acme" })!;
    expect(ensureDefaultBot(store, { dataDir: DATA_DIR, person: "ada@example.com", team: "Acme" })?.id).toBe(ada.id);
    expect(ada).toMatchObject({ name: "MausBot", defaultBot: { person: "ada@example.com" }, visibility: { people: ["ada@example.com"] } });
    expect(bea).toMatchObject({ defaultBot: { person: "bea@example.com" }, visibility: { people: ["bea@example.com"] } });
    expect(ada.chiefOfStaff).toBeFalsy();
    expect(intros(store, ada)[0]?.text).toContain("On Acme, I'm here for you and look after your own bots.");
    expect(intros(store, ada)[0]?.text).not.toContain("keep an eye on your day");
    expect(store.bots).toHaveLength(3);
  });

  it("holds a Chief's tools, never more than its member: a User's MausBot holds none", () => {
    const store = new Store(selection);
    const place = boot(store)!;
    const member = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "user@example.com", team: "Acme" })!;
    const admin = ensureDefaultBot(store, { dataDir: DATA_DIR, person: "admin@example.com", team: "Acme" })!;
    const tools = (bot: BotRecord) => availableTools(catalogProfileFromEnv({ OMB_CHIEF_OF_STAFF: chiefLevel(bot) ? "1" : "0", OMB_BOT_ID: bot.id })).map((tool) => tool.name);
    expect(tools(place)).toEqual(expect.arrayContaining(["create_bot", "propose_team_setup", "retry_thread", "manage_room"]));
    expect([chiefLevel(member), chiefLevel(admin)]).toEqual([false, false]);
    readTeamRolesWith((email) => email === "admin@example.com" ? "admin" : email === "user@example.com" ? "member" : null);
    expect([chiefLevel(member), chiefLevel(admin)]).toEqual([false, true]);
    expect(tools(member)).not.toContain("create_bot");
    expect(tools(admin)).toContain("create_bot");
  });

  it("counts the place's MausBot unused only while it is the fresh starter nobody wrote to", () => {
    const fresh = new Store(selection);
    fresh.seedIfEmpty();
    const seed = boot(fresh)!;
    expect(placeMausBotUnused(fresh, DATA_DIR)).toBe(true);
    expect(unusedStarter(fresh, DATA_DIR)?.id).toBe(seed.id);
    fresh.appendMessage(seed.threadId, { role: "user", kind: "text", text: "hi" });
    expect(placeMausBotUnused(fresh, DATA_DIR)).toBe(false);
  });

  it("counts a MausBot with its own soul as used", () => {
    const other = new Store(selection);
    other.seedIfEmpty();
    const second = boot(other)!;
    other.patchBot(second.id, { soul: "Mine" });
    expect(placeMausBotUnused(other, DATA_DIR)).toBe(false);
  });

  describe("moves", () => {
    const OWNER = { person: "p_owner0000000000000000", name: "Amit" };
    const deps = (store: Store): MoveKindsDeps => ({ dataDir: DATA_DIR, store, routines: () => null, calls: () => null, webhooks: () => null, appEvents: () => null,
      claudeCodeSkills: () => [], instanceExists: () => true, owner: () => OWNER, ownRoutine: () => {} } as unknown as MoveKindsDeps);
    async function arriveWith(store: Store, id: string, record: Record<string, unknown>, extra: Record<string, unknown> = {}) {
      let answered: { status: number; body: unknown } = { status: 0, body: undefined };
      await moveKindsRoute(deps(store), { path: "/api/cloud-send/kind", method: "PUT", url: new URL("http://127.0.0.1/api/cloud-send/kind"), auth: {} as never, req: {} as never,
        res: { setHeader() {} } as never, json: ((_res: unknown, code: number, body: unknown) => { answered = { status: code, body }; }) as never,
        readBody: (async () => ({ v: 1, key: `bot:${id}`, dataDir: "/Users/amit/.openmausbot", record, ...extra })) as never });
      return answered;
    }
    const arrive = async (store: Store, id: string, record: Record<string, unknown>) => (await arriveWith(store, id, record)).status;
    const fields = (bot: Record<string, unknown>) => Object.fromEntries(MOVE_BOT_FIELDS.map((name) => [name, bot[name] ?? null]));

    it("leaves My Cloud exactly one MausBot when this computer's arrives: My Cloud's unused one is archived, whatever order the Chief comes in", async () => {
      const cloud = new Store(selection);
      cloud.seedIfEmpty();
      boot(cloud);
      const starter = placeMausBots(cloud)[0]!;
      const arrivingMaus = cloud.createBot({ name: "MausBot" }, { id: "desk-maus-000001", seedMessages: false });
      expect(await arrive(cloud, arrivingMaus.id, fields({ defaultBot: {}, sidebarHidden: true, welcomed: true }))).toBe(200);
      expect(placeMausBots(cloud).map((bot) => bot.id)).toEqual([arrivingMaus.id]);
      expect(cloud.bot(arrivingMaus.id)).toMatchObject({ sidebarHidden: true, welcomed: true });
      expect(cloud.bot(starter.id)).toMatchObject({ chiefOfStaff: true });
      expect(cloud.bot(starter.id)?.hidden).toBeFalsy();
      const pixel = cloud.createBot({ name: "Pixel" }, { id: "desk-chief-00001", seedMessages: false });
      expect(await arrive(cloud, pixel.id, fields({ chiefOfStaff: true }))).toBe(200);
      expect(cloud.bot(starter.id)).toMatchObject({ hidden: true });
      expect(cloud.bot(starter.id)?.defaultBot).toBeUndefined();
      expect(cloud.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id)).toEqual([pixel.id]);
      expect(placeMausBots(cloud).map((bot) => bot.id)).toEqual([arrivingMaus.id]);
    });

    it("still makes one MausBot on My Cloud when this computer's arrives renamed and with its own picture", async () => {
      const cloud = new Store(selection);
      cloud.seedIfEmpty();
      boot(cloud);
      const starter = placeMausBots(cloud)[0]!;
      cloud.patchBot(starter.id, { name: "Starter" });
      const arriving = cloud.createBot({ name: "Jarvis" }, { id: "desk-maus-000003", seedMessages: false });
      cloud.patchBot(arriving.id, { avatarUrl: "/api/attachments/jarvis.png", avatarCrop: "circle" });
      expect(await arrive(cloud, arriving.id, fields({ defaultBot: {}, welcomed: true }))).toBe(200);
      expect(placeMausBots(cloud).map((bot) => [bot.id, bot.name, bot.avatarUrl])).toEqual([[arriving.id, "Jarvis", "/api/attachments/jarvis.png"]]);
      expect(cloud.bot(starter.id)?.defaultBot).toBeUndefined();
    });

    it("keeps a My Cloud MausBot someone already used as an ordinary bot", async () => {
      const cloud = new Store(selection);
      const theirs = boot(cloud)!;
      cloud.appendMessage(theirs.threadId, { role: "user", kind: "text", text: "Hi" });
      const arriving = cloud.createBot({ name: "MausBot" }, { id: "desk-maus-000002", seedMessages: false });
      expect(await arrive(cloud, arriving.id, fields({ defaultBot: {} }))).toBe(200);
      expect(placeMausBots(cloud).map((bot) => bot.id)).toEqual([arriving.id]);
      expect(cloud.bot(theirs.id)?.hidden).toBeFalsy();
    });

    it("comes home to exactly the one MausBot My Cloud had, and makes none", () => {
      const cloud = new Store(selection);
      cloud.seedIfEmpty();
      const mausOnCloud = boot(cloud)!;
      cloud.patchBot(mausOnCloud.id, { name: "Jarvis", sidebarHidden: true });
      const backup = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
      for (const file of ["bots.json", "default-bot.json"]) rmSync(join(DATA_DIR, file), { force: true });
      const desk = new Store(selection);
      desk.seedIfEmpty();
      boot(desk);
      rmSync(join(DATA_DIR, "bots.json"));
      writeFileSync(join(DATA_DIR, "bots.json"), backup);
      const home = new Store(selection);
      home.seedIfEmpty();
      boot(home);
      expect(home.bots.map((bot) => bot.id)).toEqual([mausOnCloud.id]);
      expect(placeMausBots(home)[0]).toMatchObject({ name: "Jarvis", sidebarHidden: true });
    });

    describe("mainIfUnused", () => {
      const phoneMaus = { defaultBot: {}, chiefOfStaff: true, managedSections: ["phone-section"] };
      const place = () => { const cloud = new Store(selection); cloud.seedIfEmpty(); const seed = boot(cloud)!; return { cloud, seed, arriving: cloud.createBot({ name: "MausBot" }, { id: "pocket-maus-000001", seedMessages: false }) }; };

      it("a phone's MausBot becomes the main bot over an unused starter, and says so", async () => {
        const { cloud, seed, arriving } = place();
        expect(await arriveWith(cloud, arriving.id, phoneMaus, { mainIfUnused: true })).toEqual({ status: 200, body: { v: 1, ok: true, mainBot: true } });
        expect(cloud.bot(arriving.id)?.defaultBot).toEqual({});
        expect(cloud.bot(arriving.id)?.managedSections).toEqual(["phone-section"]);
        expect(cloud.bot(seed.id)).toMatchObject({ hidden: true });
        expect(cloud.bot(seed.id)?.defaultBot).toBeUndefined();
        expect(await arriveWith(cloud, arriving.id, phoneMaus, { mainIfUnused: true })).toEqual({ status: 200, body: { v: 1, ok: true, mainBot: true } });
        expect(cloud.bot(arriving.id)).toMatchObject({ defaultBot: {}, chiefOfStaff: true });
      });

      it("a phone's MausBot arrives beside a MausBot someone uses, which stays main and Chief with its sections", async () => {
        const { cloud, seed, arriving } = place();
        cloud.patchBot(seed.id, { managedSections: ["mine"] });
        cloud.appendMessage(seed.threadId, { role: "user", kind: "text", text: "Hi" });
        expect(await arriveWith(cloud, arriving.id, phoneMaus, { mainIfUnused: true })).toEqual({ status: 200, body: { v: 1, ok: true, mainBot: false } });
        expect(cloud.bot(seed.id)).toMatchObject({ defaultBot: {}, chiefOfStaff: true, managedSections: ["mine"] });
        expect(cloud.bot(seed.id)?.hidden).toBeFalsy();
        expect(cloud.bot(arriving.id)?.defaultBot).toBeUndefined();
        expect(cloud.bot(arriving.id)?.chiefOfStaff).toBeFalsy();
        expect(cloud.bot(arriving.id)?.managedSections).toBeUndefined();
      });

      it("a phone's Chief that is not MausBot takes nothing from a MausBot someone uses", async () => {
        const { cloud, seed } = place();
        cloud.patchBot(seed.id, { managedSections: ["mine"] });
        cloud.appendMessage(seed.threadId, { role: "user", kind: "text", text: "Hi" });
        const planner = cloud.createBot({ name: "Planner" }, { id: "pocket-planner-01", seedMessages: false });
        expect(await arriveWith(cloud, planner.id, { chiefOfStaff: true, managedSections: ["theirs"] }, { mainIfUnused: true })).toMatchObject({ status: 200 });
        expect(cloud.bot(seed.id)).toMatchObject({ chiefOfStaff: true, managedSections: ["mine"] });
        expect(cloud.bot(planner.id)?.chiefOfStaff).toBeFalsy();
        expect(cloud.bot(planner.id)?.managedSections).toBeUndefined();
      });

      it("a phone's MausBot that arrives beside keeps no hidden or welcomed mark, and a resend changes nothing", async () => {
        const { cloud, seed, arriving } = place();
        cloud.appendMessage(seed.threadId, { role: "user", kind: "text", text: "Hi" });
        const record = { ...phoneMaus, sidebarHidden: true, welcomed: true };
        for (let again = 0; again < 2; again++) {
          expect(await arriveWith(cloud, arriving.id, record, { mainIfUnused: true })).toEqual({ status: 200, body: { v: 1, ok: true, mainBot: false } });
          expect(cloud.bot(arriving.id)?.sidebarHidden).toBeUndefined();
          expect(cloud.bot(arriving.id)?.welcomed).toBeUndefined();
          expect(cloud.bot(arriving.id)?.defaultBot).toBeUndefined();
          expect(cloud.bot(seed.id)).toMatchObject({ defaultBot: {}, chiefOfStaff: true });
        }
      });

      it("a phone's MausBot takes main over an unused starter but not Chief from a Chief someone uses", async () => {
        const { cloud, seed, arriving } = place();
        const jarvis = cloud.createBot({ name: "Jarvis" }, { id: "desk-jarvis-0001", seedMessages: false });
        cloud.setChiefOfStaff(jarvis.id);
        cloud.patchBot(jarvis.id, { managedSections: ["mine"] });
        for (let again = 0; again < 2; again++) {
          expect(await arriveWith(cloud, arriving.id, phoneMaus, { mainIfUnused: true })).toEqual({ status: 200, body: { v: 1, ok: true, mainBot: true } });
          expect(cloud.bot(arriving.id)?.defaultBot).toEqual({});
          expect(cloud.bot(arriving.id)?.chiefOfStaff).toBeFalsy();
          expect(cloud.bot(arriving.id)?.managedSections).toBeUndefined();
          expect(cloud.bot(jarvis.id)).toMatchObject({ chiefOfStaff: true, managedSections: ["mine"] });
        }
        expect(cloud.bot(seed.id)?.defaultBot).toBeUndefined();
      });

      it("a department Chief made after the unused starter does not stop a phone's MausBot taking the place's Chief", async () => {
        const { cloud, seed, arriving } = place();
        cloud.createBot({ name: "Sales" }, { id: "desk-sales-000001", seedMessages: false });
        cloud.patchBot("desk-sales-000001", { section: "Sales" });
        cloud.setChiefOfStaff("desk-sales-000001");
        expect(await arriveWith(cloud, arriving.id, phoneMaus, { mainIfUnused: true })).toEqual({ status: 200, body: { v: 1, ok: true, mainBot: true } });
        expect(cloud.bot(arriving.id)).toMatchObject({ defaultBot: {}, chiefOfStaff: true, managedSections: ["phone-section"] });
        expect(cloud.bot(seed.id)).toMatchObject({ hidden: true });
        expect(cloud.bot(seed.id)?.chiefOfStaff).toBeFalsy();
        expect(cloud.bot("desk-sales-000001")?.chiefOfStaff).toBe(true);
      });

      it("a hidden place Chief someone uses keeps Chief and its sections when a phone's MausBot takes main", async () => {
        const { cloud, arriving } = place();
        const jarvis = cloud.createBot({ name: "Jarvis" }, { id: "desk-jarvis-0002", seedMessages: false });
        cloud.setChiefOfStaff(jarvis.id);
        cloud.patchBot(jarvis.id, { managedSections: ["mine"], hidden: true });
        expect(await arriveWith(cloud, arriving.id, phoneMaus, { mainIfUnused: true })).toMatchObject({ body: { mainBot: true } });
        expect(cloud.bot(jarvis.id)).toMatchObject({ chiefOfStaff: true, managedSections: ["mine"] });
        expect(cloud.bot(arriving.id)?.chiefOfStaff).toBeFalsy();
      });

      it("without mainIfUnused, an arriving MausBot takes over as before", async () => {
        const { cloud, seed, arriving } = place();
        cloud.appendMessage(seed.threadId, { role: "user", kind: "text", text: "Hi" });
        expect(await arriveWith(cloud, arriving.id, phoneMaus)).toEqual({ status: 200, body: { v: 1, ok: true, mainBot: true } });
        expect(cloud.bot(arriving.id)?.defaultBot).toEqual({});
      });
    });
  });
});
