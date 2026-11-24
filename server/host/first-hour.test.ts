import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutineRun } from "../routines.ts";
import { Store, type Message } from "../store.ts";
import { createFirstHour, firstName, greetingMessage, LOOK_DRAFTS, LOOK_RETRY_MS, lookPrompt, OFFER_UNASKED_MS, type FirstHourDeps } from "./first-hour.ts";
import { createValueLedger } from "./value-ledger.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { start?: string; connected?: { gmail?: boolean; googlecalendar?: boolean } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-first-hour-"));
  dirs.push(dir);
  let now = Date.parse(options.start ?? "2026-10-27T15:00:00Z");
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  // The store keeps its bots in the data folder all these tests share: each new Cloud starts with none.
  for (const id of store.bots.map((bot) => bot.id)) store.deleteBot(id);
  const chief = store.createBot({ name: "MausBot" }, { seedMessages: false });
  store.setChiefOfStaff(chief.id);
  const thread = () => store.bot(chief.id)!.threadId;
  store.appendMessage(thread(), greetingMessage(chief, {}, undefined));
  const world = {
    person: {} as { name?: string; email?: string }, language: undefined as string | undefined, zone: "UTC",
    connected: { gmail: false, googlecalendar: false, ...options.connected }, briefOn: false, phones: 0, busy: false,
    pushed: [] as string[], turns: [] as Array<{ text: string; threadId: string }>, welcomeDone: 0, runs: [] as RoutineRun[],
    reply: "This week: Standup Tue 10:00." as string | null,
    briefCard: undefined as { threadId: string; messageId: string } | undefined,
    /** While set, the first look's turn runs until this is called. */
    held: null as null | (() => void), hold: false,
    /** A move into the Cloud is running; the next first look's start throws this. */
    moving: false, refuse: null as null | Error, chiefId: chief.id, stopped: false,
    /** Runs as a first look's turn starts. */
    onTurn: undefined as undefined | (() => void),
    /** How the next first look's turn fails: without a reply, or as a failed turn. */
    failure: undefined as undefined | { text: string; stopReason?: string },
  };
  const ledger = createValueLedger({ dataDir: dir, now: () => now });
  const deps: FirstHourDeps = {
    store, dataDir: dir, now: () => now, chief: () => store.bot(world.chiefId), mainThread: (botId) => store.bot(botId)?.threadId, threadBusy: () => world.busy,
    person: () => world.person, language: () => world.language, timeZone: () => world.zone,
    apps: { reachable: () => true, connected: async () => ({ ...world.connected }), card: async (slug) => ({ label: slug === "gmail" ? "Gmail" : "Google Calendar", description: "" }) },
    briefOn: () => world.briefOn, ensureBrief: () => { world.briefOn = true; }, briefCard: () => world.briefCard, phones: () => world.phones,
    moving: () => world.moving, stopped: () => world.stopped,
    startTurn: async (_botId, text, opts) => {
      world.turns.push({ text, threadId: opts.threadId });
      world.onTurn?.();
      if (world.refuse) throw world.refuse;
      const end = () => {
        if (world.reply) store.appendMessage(opts.threadId, { role: "bot", kind: "text", text: world.reply, turnId: "look" });
        opts.onSettled(world.failure ? { ok: false, text: world.failure.text, failure: world.failure } : { ok: world.reply !== null, text: world.reply ?? "" });
      };
      if (world.hold) world.held = end;
      else end();
    },
    notify: (_bot, _thread, body) => world.pushed.push(body), wrote: () => {}, welcomeDone: () => { world.welcomeDone += 1; },
    runs: () => world.runs, ledger,
  };
  const make = () => {
    const made = createFirstHour(deps);
    store.onChange((change) => {
      if (change.type === "message") made.message(change.threadId, change.message);
      else if (change.type === "message.patch") made.patched(change.threadId, change.message);
    });
    return made;
  };
  const rows = (): Message[] => store.messagesFor(thread());
  const texts = () => rows().filter((row) => row.role === "bot" && row.kind === "text").map((row) => row.text);
  const cards = () => rows().filter((row) => row.kind === "connector");
  const write = (text: string) => store.appendMessage(thread(), { role: "user", kind: "text", text });
  const reply = (text: string) => store.appendMessage(thread(), { role: "bot", kind: "text", text });
  /** The Chief's first answer, as the server's turns write and end it. */
  const answer = async (fh: ReturnType<typeof make>, text = "My inbox is a mess.") => {
    write(text);
    reply("On it.");
    fh.turnCompleted(thread(), true);
    fh.tick();
    await settle();
    await settle();
  };
  return { store, chief, thread, world, ledger, make, rows, texts, cards, write, reply, answer, advance: (ms: number) => { now += ms; }, set: (iso: string) => { now = Date.parse(iso); }, now: () => now };
}

describe("a new Cloud the person's own bots came to", () => {
  const ONE = "Hi Sam! Coder is here now and keeps working while your computer is off. I'm MausBot, your Chief of Staff on this Cloud: carry on with Coder as before, or tell me what else you want off your plate.";

  it("greets them with the bot that moved in, never offers the inbox unasked, and lets the Chief offer it only when asked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.world.person = { name: "Sam Lee" };
    s.store.createBot({ name: "Coder" }, { seedMessages: false });
    fh.arrived();
    expect(s.texts()).toEqual([ONE]);
    await vi.advanceTimersByTimeAsync(OFFER_UNASKED_MS);
    vi.useRealTimers();
    fh.tick();
    await s.answer(fh, "Is Coder still on my repo?");
    expect(s.cards()).toEqual([]);
    expect(s.texts().some((text) => text?.includes("connect Gmail"))).toBe(false);
    s.advance(25 * HOUR);
    fh.tick();
    expect(s.texts().some((text) => text?.startsWith("So far"))).toBe(false);
    expect(fh.health()!.ms.movedIn).toBe(0);
    expect(fh.health()!.ms.offered).toBeUndefined();
    fh.stop();
  });

  it("tells the Chief the bots are there and that the inbox waits until the person brings it up", () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.store.createBot({ name: "Coder" }, { seedMessages: false });
    s.store.createBot({ name: "Writer" }, { seedMessages: false });
    fh.tick();
    expect(s.texts()[0]).toBe("Hi! Coder and Writer are here now and keep working while your computer is off. I'm MausBot, your Chief of Staff on this Cloud: carry on with them as before, or tell me what else you want off your plate.");
    s.store.createBot({ name: "Scout" }, { seedMessages: false });
    fh.tick();
    expect(s.texts()[0]).toMatch(/^Hi! Your 3 bots are here now and keep working while your computer is off\./u);
    const prompt = fh.prompt(s.chief.id, s.thread());
    expect(prompt).toMatch(/Their own bots (?:Coder|Writer|Scout), (?:Coder|Writer|Scout), (?:Coder|Writer|Scout) are here too/u);
    expect(prompt).toContain("If they bring up their email or calendar, you may offer to connect Gmail and Google Calendar then.");
    expect(prompt).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
    expect(prompt).not.toContain("morning brief is on");
  });

  it("holds the unasked offer while a move runs: a bot that arrives gets the greeting, a move that brings none lets the offer come", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const moved = setup();
    const a = moved.make();
    a.begin();
    moved.world.moving = true;
    a.arrived();
    await vi.advanceTimersByTimeAsync(OFFER_UNASKED_MS);
    expect(moved.cards()).toEqual([]);
    moved.store.createBot({ name: "Coder" }, { seedMessages: false });
    moved.world.moving = false;
    a.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(moved.cards()).toEqual([]);
    expect(moved.texts()[0]).toMatch(/^Hi! Coder is here now/u);
    a.stop();
    const empty = setup();
    const b = empty.make();
    b.begin();
    empty.world.moving = true;
    b.arrived();
    await vi.advanceTimersByTimeAsync(OFFER_UNASKED_MS);
    b.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(empty.cards()).toEqual([]);
    empty.world.moving = false;
    b.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(empty.cards()).toHaveLength(2);
    b.stop();
  });

  it("names the bots that came, not the computer's own MausBot that came with them, and stops rewriting the greeting after the first day", () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.store.createBot({ name: "MausBot (MacBook)" }, { seedMessages: false });
    s.store.createBot({ name: "Coder" }, { seedMessages: false });
    fh.tick();
    expect(s.texts()[0]).toMatch(/^Hi! Coder is here now/u);
    s.advance(25 * HOUR);
    s.store.createBot({ name: "Writer" }, { seedMessages: false });
    s.world.language = "de";
    fh.tick();
    fh.arrived();
    fh.stop();
    expect(s.texts()[0]).toMatch(/^Hi! Coder is here now/u);
  });

  it("changes nothing for a bot that comes after the first day", () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.advance(25 * HOUR);
    s.store.createBot({ name: "Coder" }, { seedMessages: false });
    fh.arrived();
    fh.tick();
    fh.stop();
    expect(s.texts()[0]).toMatch(/^Hi! I'm MausBot/u);
    expect(fh.health()!.ms.movedIn).toBeUndefined();
  });

  it("changes nothing for a bot made after the inbox was offered", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    expect(s.cards()).toHaveLength(2);
    s.store.createBot({ name: "Coder" }, { seedMessages: false });
    fh.arrived();
    fh.tick();
    fh.stop();
    expect(s.texts()[0]).toMatch(/^Hi! I'm MausBot/u);
    expect(fh.health()!.ms.movedIn).toBeUndefined();
  });

  it("leaves a Chief that arrived by a move alone: nothing posted in its chat and no first-day words for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    const arrived = s.store.createBot({ name: "MausBot (MacBook)" }, { seedMessages: false });
    s.store.setChiefOfStaff(arrived.id);
    s.world.chiefId = arrived.id;
    fh.arrived();
    await vi.advanceTimersByTimeAsync(OFFER_UNASKED_MS);
    fh.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.store.messagesFor(arrived.threadId)).toEqual([]);
    expect(fh.prompt(arrived.id, arrived.threadId)).toBe("");
    // The computer's own MausBot is no news in the greeting: it stays as it was, and no inbox offer comes.
    expect(s.texts()[0]).toMatch(/^Hi! I'm MausBot/u);
    expect(fh.health()!.ms.movedIn).toBe(0);
    fh.stop();
  });
});

describe("a new Cloud's first hour", () => {
  it("begins once, on the new Cloud only: its welcome steps end and the Chief opens", () => {
    const s = setup();
    const fh = s.make();
    expect(fh.active()).toBe(false);
    fh.begin();
    expect(fh.active()).toBe(true);
    expect(s.world.welcomeDone).toBe(1);
    expect(s.store.bot(s.chief.id)!.welcomed).toBe(true);
    const again = s.make();
    again.begin();
    expect(again.active()).toBe(true);
    expect(s.world.welcomeDone).toBe(1);
  });

  it("greets by name in the person's language once they arrive, only while nobody has answered", () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    expect(s.texts()[0]).toBe("Hi! I'm MausBot, your Chief of Staff. I live on the Cloud, so I keep working while your computer is off. What do you want off your plate?");
    s.world.person = { email: "sam.lee@example.test" };
    s.world.language = "de";
    fh.arrived();
    fh.stop();
    expect(s.texts()[0]).toBe("Hallo Sam! Ich bin MausBot, dein Chief of Staff. Ich lebe in deiner Cloud und arbeite weiter, auch wenn dein Computer aus ist. Was soll ich dir abnehmen?");
    s.write("Mein Postfach");
    s.world.language = "fr";
    fh.arrived();
    fh.stop();
    expect(s.texts()[0]).toMatch(/^Hallo Sam!/);
  });

  it("offers Gmail and Google Calendar once, after the Chief's first answer, with the reason first", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    expect(s.texts().at(-1)).toBe("So I can see what needs you today, connect Gmail and Google Calendar. It's one sign-in each. I only read and write drafts: nothing is sent, accepted or deleted without you.");
    expect(s.cards().map((card) => [card.connector!.slug, card.connector!.status])).toEqual([["gmail", "required"], ["googlecalendar", "required"]]);
    await s.answer(fh, "And my calendar?");
    expect(s.cards()).toHaveLength(2);
    expect(fh.health()!.ms.offered).toBeDefined();
  });

  it("offers it a second after the Chief's answer ends, not at the next check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.write("My inbox is a mess.");
    s.reply("On it.");
    fh.turnCompleted(s.thread(), true);
    expect(s.cards()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.cards()).toHaveLength(2);
  });

  it("offers it unasked when the person is here and has not written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    fh.arrived();
    await vi.advanceTimersByTimeAsync(OFFER_UNASKED_MS - 1_000);
    expect(s.cards()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.cards()).toHaveLength(2);
    fh.stop();
  });

  it("the moment Gmail is in, gives its first look in the Chief's chat, then says the brief once and offers the phone", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.world.person = { name: "Sam Lee" };
    await s.answer(fh);
    const gmail = s.cards().find((card) => card.connector!.slug === "gmail")!;
    s.store.patchMessage(s.thread(), gmail.id, { connector: { ...gmail.connector!, status: "connected" } });
    await settle();
    expect(s.world.turns).toHaveLength(1);
    expect(s.world.turns[0]!.text).toBe(lookPrompt({ apps: ["gmail"], name: "Sam" }));
    expect(s.world.turns[0]!.text).toContain(`at most ${LOOK_DRAFTS} emails`);
    expect(s.rows().some((row) => row.role === "user" && row.text?.includes("first look"))).toBe(false);
    expect(s.store.messagesFor(s.thread()).find((row) => row.id === gmail.id)!.connector).toMatchObject({ status: "connected", resumed: true });
    expect(s.world.pushed).toEqual(["Your first look is ready"]);
    fh.tick();
    expect(s.texts().slice(-2)).toEqual(["This week: Standup Tue 10:00.", "Every morning at 8 I'll send you a brief of what needs you."]);
    const phone = s.rows().at(-1)!;
    expect(phone).toMatchObject({ serverCard: true, kind: "widget" });
    expect(JSON.stringify(phone.widget!.root)).toContain('"onClickAction":{"type":"open_phone_pairing"}');
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("Every morning at 8"))).toHaveLength(1);
    expect(s.rows().filter((row) => row.serverCard)).toHaveLength(1);
    expect(fh.health()).toMatchObject({ apps: ["gmail"], look: "delivered" });
  });

  it("carries on without apps when the person sets the cards aside: no first look, no brief line, the phone offered", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    for (const card of s.cards()) s.store.patchMessage(s.thread(), card.id, { connector: { ...card.connector!, dismissed: true } });
    fh.tick();
    await settle();
    expect(s.world.turns).toEqual([]);
    expect(s.texts().some((text) => text?.startsWith("Every morning at 8"))).toBe(false);
    expect(s.rows().at(-1)!.widget?.root.title).toBe("Get me on your phone");
    expect(fh.health()!.ms.declined).toBeDefined();
  });

  it("tries a failed first look once more after a short wait, then says which apps are in and how to get the look, and still offers the phone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup({ connected: { googlecalendar: true } });
    const fh = s.make();
    fh.begin();
    s.world.reply = null;
    await s.answer(fh);
    expect(s.cards().map((card) => card.connector!.slug)).toEqual(["gmail"]);
    expect(s.world.turns).toHaveLength(1);
    expect(s.world.turns[0]!.text).toContain("just connected Google Calendar");
    const said = s.texts().length;
    fh.tick();
    await settle();
    expect(s.texts()).toHaveLength(said);
    expect(s.world.turns).toHaveLength(1);
    expect(fh.health()).toMatchObject({ lookFailure: "error", lookTries: 1 });
    expect(fh.health()!.look).toBeUndefined();
    s.advance(LOOK_RETRY_MS);
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(2);
    expect(s.texts()).toContain("Google Calendar is connected, but I couldn't take my first look just now. Ask me \"what needs me today?\" whenever you like and I'll look then.");
    expect(s.texts().some((text) => text?.includes("You're connected"))).toBe(false);
    fh.tick();
    expect(s.rows().at(-1)!.widget?.root.title).toBe("Get me on your phone");
    expect(fh.health()).toMatchObject({ look: "failed", lookFailure: "error", lookTries: 2 });
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("first hour: the first look failed"));
    expect(lines).toEqual([
      expect.stringMatching(/^first hour: the first look failed \(try 1 of 2, again in 60 s\): path=settled ok=false replied=false stalled=false stop=- code=- sinceBoot=\d+ sinceApp=0 ms=0 apps=googlecalendar rows=[\w,-]+ drafts=0 cause="-"$/u),
      expect.stringMatching(/^first hour: the first look failed \(try 2 of 2, the last\): path=settled ok=false replied=false/u),
    ]);
  });

  it("gets the first look on its second try when the first one could not start, and logs the cause in the system's words only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup({ connected: { gmail: true, googlecalendar: true } });
    const fh = s.make();
    fh.begin();
    s.world.refuse = Object.assign(new Error("this provider account is being updated — try again shortly (sam@example.test)"), { status: 409, code: "settling" });
    await s.answer(fh);
    expect(s.world.turns).toHaveLength(1);
    expect(fh.health()).toMatchObject({ lookFailure: "start", lookTries: 1 });
    expect(warn.mock.calls.map((call) => String(call[0])).find((line) => line.startsWith("first hour: the first look failed"))).toMatch(/path=start code=settling .* cause="this provider account is being updated — try again shortly \(<address>\)"$/u);
    s.world.refuse = null;
    s.advance(LOOK_RETRY_MS - 1_000);
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(1);
    s.advance(1_000);
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(2);
    expect(s.texts()).toContain("This week: Standup Tue 10:00.");
    expect(s.world.pushed).toEqual(["Your first look is ready"]);
    expect(fh.health()).toMatchObject({ look: "delivered", lookTries: 1 });
  });

  it("waits out a move into the Cloud: no look starts while it runs, and a try that fails during it is not counted", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    s.world.moving = true;
    const gmail = s.cards().find((card) => card.connector!.slug === "gmail")!;
    s.store.patchMessage(s.thread(), gmail.id, { connector: { ...gmail.connector!, status: "connected" } });
    fh.tick();
    await settle();
    expect(s.world.turns).toEqual([]);
    s.world.moving = false;
    s.world.reply = null;
    s.world.onTurn = () => { s.world.moving = true; };
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(1);
    expect(fh.health()!.lookTries).toBeUndefined();
    expect(fh.health()!.look).toBeUndefined();
    s.world.moving = false;
    s.world.onTurn = undefined;
    s.world.reply = "This week: Standup Tue 10:00.";
    s.advance(LOOK_RETRY_MS);
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(2);
    expect(fh.health()).toMatchObject({ look: "delivered" });
    expect(s.texts().some((text) => text?.includes("couldn't take my first look"))).toBe(false);
  });

  it("never starts again a first look the person stopped, and says nothing about it", async () => {
    const s = setup({ connected: { gmail: true } });
    const fh = s.make();
    fh.begin();
    s.world.reply = null;
    s.world.stopped = true;
    await s.answer(fh);
    expect(fh.health()).toMatchObject({ look: "failed", lookFailure: "stopped" });
    s.advance(LOOK_RETRY_MS);
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(1);
    expect(s.texts().some((text) => text?.includes("first look"))).toBe(false);
  });

  it("does not try again once the person has written in that chat since the first try failed", async () => {
    const s = setup({ connected: { gmail: true } });
    const fh = s.make();
    fh.begin();
    s.world.reply = null;
    await s.answer(fh);
    expect(fh.health()).toMatchObject({ lookTries: 1 });
    s.write("Never mind, look at my repo instead.");
    s.advance(LOOK_RETRY_MS);
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(1);
    expect(fh.health()).toMatchObject({ look: "failed" });
    expect(s.texts().some((text) => text?.includes("first look"))).toBe(false);
  });

  it("does not repeat a first look that already wrote a draft: a second try would start its three drafts over", async () => {
    const s = setup({ connected: { gmail: true } });
    const fh = s.make();
    fh.begin();
    s.world.reply = null;
    s.world.onTurn = () => { expect(fh.look(s.thread())!.draft({} as never)).toBe(true); };
    await s.answer(fh);
    expect(fh.health()).toMatchObject({ look: "failed", lookTries: 1 });
    s.advance(LOOK_RETRY_MS);
    fh.tick();
    await settle();
    expect(s.world.turns).toHaveLength(1);
    expect(s.texts().some((text) => text?.startsWith("Gmail is connected, but I couldn't take my first look"))).toBe(true);
  });

  it("does not try again when the bot is paused, and logs a failed turn's stop reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paused = setup({ connected: { gmail: true } });
    const first = paused.make();
    first.begin();
    paused.world.refuse = Object.assign(new Error("MausBot is paused."), { status: 409, code: "bot_paused" });
    await paused.answer(first);
    expect(first.health()).toMatchObject({ look: "failed", lookFailure: "start", lookTries: 1 });
    expect(paused.world.turns).toHaveLength(1);
    expect(paused.texts().some((text) => text?.includes("first look"))).toBe(false);
    const failing = setup({ connected: { gmail: true } });
    const second = failing.make();
    second.begin();
    failing.world.reply = null;
    failing.world.failure = { text: "Claude is signed out.", stopReason: "error" };
    await failing.answer(second);
    expect(second.health()).toMatchObject({ lookFailure: "error", lookTries: 1 });
    expect(warn.mock.calls.map((call) => String(call[0])).at(-1)).toMatch(/path=settled ok=false replied=false stalled=false stop=error code=- .* cause="Claude is signed out."$/u);
  });

  it("pushes the first look to a phone paired after it, once; otherwise the first morning brief says it is the first", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    const gmail = s.cards()[0]!;
    s.store.patchMessage(s.thread(), gmail.id, { connector: { ...gmail.connector!, status: "connected" } });
    await settle();
    s.world.phones = 1;
    fh.tick();
    fh.tick();
    expect(s.world.pushed).toEqual(["Your first look is ready", "Your first look is ready"]);
    expect(fh.morningPush("Your brief: 2 meetings")).toBe("Your first brief is ready");
    expect(fh.morningPush("Your brief: 2 meetings")).toBe("Your brief: 2 meetings");
  });

  it("fences the first look to three reply drafts, in the Chief's chat and only while it runs; both apps already in, no cards", async () => {
    const s = setup({ connected: { gmail: true, googlecalendar: true } });
    const fh = s.make();
    fh.begin();
    expect(fh.look(s.thread())).toBeNull();
    s.world.hold = true;
    await s.answer(fh);
    expect(s.cards()).toEqual([]);
    expect(s.world.turns[0]!.text).toContain("just connected Gmail and Google Calendar");
    const fence = fh.look(s.thread())!;
    expect(fh.look("another-chat")).toBeNull();
    expect([1, 2, 3, 4].map(() => fence.draft({ threadId: "t" }))).toEqual([true, true, true, false]);
    s.world.held!();
    expect(fh.look(s.thread())).toBeNull();
  });

  it("recaps on day two, from what was really done, with the time it gave back kept conservative", async () => {
    const s = setup({ start: "2026-10-27T15:00:00Z" });
    s.world.zone = "America/New_York";
    const fh = s.make();
    fh.begin();
    s.ledger.add("sorted", 40);
    s.ledger.add("drafted", 6);
    s.ledger.add("prepped", 4);
    s.set("2026-10-28T11:59:00Z");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    s.set("2026-10-28T12:00:00Z");
    fh.tick();
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual(["So far I've sorted 40 emails for your morning brief, drafted 6 replies and prepped 4 meetings: about 2 hours back."]);
    expect(fh.tally()).toEqual({ sorted: 40, drafted: 6, prepped: 4, routines: 0 });
  });

  it("points the recap's sorted count to the morning brief card in the same chat, and nowhere else", () => {
    const recapWith = (sorted: number, card: "here" | "none" | "elsewhere") => {
      const s = setup({ start: "2026-10-27T09:00:00Z" });
      const fh = s.make();
      fh.begin();
      const brief = s.store.appendMessage(s.thread(), { role: "bot", kind: "widget", text: "Your brief: 1 needs you", serverCard: true });
      if (card !== "none") s.world.briefCard = { threadId: card === "here" ? s.thread() : "another-chat", messageId: brief.id };
      if (sorted) s.ledger.add("sorted", sorted);
      s.ledger.add("drafted", 2);
      s.set("2026-10-28T09:00:00Z");
      fh.tick();
      return { recap: s.rows().findLast((row) => row.text?.startsWith("So far"))!, brief };
    };
    const linked = recapWith(12, "here");
    expect(linked.recap.text).toBe("So far I've sorted 12 emails for your morning brief and drafted 2 replies: about 20 minutes back.");
    expect(linked.recap.replyToId).toBe(linked.brief.id);
    expect(recapWith(12, "none").recap.replyToId).toBeUndefined();
    expect(recapWith(12, "elsewhere").recap.replyToId).toBeUndefined();
    expect(recapWith(0, "here").recap.replyToId).toBeUndefined();
  });

  it("holds the recap while the person's newest message is still unanswered, so it never reads as the answer", () => {
    const s = setup({ start: "2026-10-27T09:00:00Z" });
    const fh = s.make();
    fh.begin();
    s.ledger.add("sorted", 29);
    s.set("2026-10-28T09:00:00Z");
    s.write("Every couple in both movies and Friends");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    s.store.appendMessage(s.thread(), { role: "bot", kind: "text", text: "A server notice." });
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    s.store.appendMessage(s.thread(), { role: "bot", kind: "widget", text: "Pick one", turnId: "turn-1" });
    fh.tick();
    expect(s.texts().at(-1)).toBe("So far I've sorted 29 emails for your morning brief: about 30 minutes back.");
  });

  it("counts a routine's posted results in the recap, and says nothing at all when nothing was done", () => {
    const s = setup({ start: "2026-10-27T09:00:00Z" });
    const fh = s.make();
    fh.begin();
    s.set("2026-10-28T09:00:00Z");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    expect(fh.health()!.ms.recap).toBeDefined();

    const t = setup({ start: "2026-10-27T09:00:00Z" });
    const other = t.make();
    other.begin();
    t.ledger.add("drafted", 1);
    t.world.runs.push(
      { id: "r1", routineId: "news", routineName: "News", target: "bot", botId: t.chief.id, runOn: "maus", scheduledFor: 0, status: "completed", manual: false, createdAt: 0, finishedAt: t.now() + HOUR, report: { state: "posted", threadId: "x", messageId: "y" } },
      { id: "r2", routineId: "watch", routineName: "Keep an eye on my day", target: "bot", botId: t.chief.id, runOn: "maus", scheduledFor: 0, status: "completed", manual: false, createdAt: 0, finishedAt: t.now() + HOUR, deliver: "brief", report: { state: "posted", threadId: "x", messageId: "y" } },
      { id: "r3", routineId: "news", routineName: "News", target: "bot", botId: t.chief.id, runOn: "maus", scheduledFor: 0, status: "completed", manual: false, createdAt: 0, finishedAt: t.now() + HOUR, report: { state: "quiet" } },
    );
    t.set("2026-10-28T09:00:00Z");
    other.tick();
    expect(t.texts().filter((text) => text?.startsWith("So far"))).toEqual(["So far I've drafted 1 reply and ran 1 routine: about 10 minutes back."]);
  });

  it("tells the Chief about the first day in its own chat only, and only that day", () => {
    const s = setup();
    const fh = s.make();
    expect(fh.prompt(s.chief.id, s.thread())).toBe("");
    fh.begin();
    s.world.person = { name: "Sam Lee" };
    expect(fh.prompt(s.chief.id, s.thread())).toContain("This is Sam's first day with you on their new Cloud.");
    expect(fh.prompt(s.chief.id, s.thread())).toContain("never call COMPOSIO_MANAGE_CONNECTIONS");
    expect(fh.prompt(s.chief.id, "another-chat")).toBe("");
    s.advance(25 * HOUR);
    expect(fh.prompt(s.chief.id, s.thread())).toBe("");
  });
});

describe("the name it greets with", () => {
  it("is the profile's first name, else a plain address's, never a role address or a run-together one", () => {
    expect(firstName({ name: "  Sam Lee ", email: "x@y.test" })).toBe("Sam");
    expect(firstName({ email: "sam.lee@example.test" })).toBe("Sam");
    expect(firstName({ email: "maria_garcia@example.test" })).toBe("Maria");
    expect(firstName({ email: "ana@example.test" })).toBe("Ana");
    expect(firstName({ email: "info@example.test" })).toBeUndefined();
    expect(firstName({ email: "hello@example.test" })).toBeUndefined();
    expect(firstName({ email: "jsmith42@example.test" })).toBeUndefined();
    expect(firstName({ email: "johnathansmith@example.test" })).toBeUndefined();
    expect(firstName({})).toBeUndefined();
  });
});
