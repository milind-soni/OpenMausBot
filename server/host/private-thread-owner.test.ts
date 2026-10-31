import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "../../shared/notification.ts";
import * as atomic from "../atomic.ts";
import { audienceIncludes, memberAudience } from "../audience.ts";
import { DATA_DIR } from "../config.ts";
import { createMemoryUpkeep } from "../memory-upkeep.ts";
import type { RequestAuth } from "../request-auth.ts";
import { personKey } from "../person-key.ts";
import { Store, type BotRecord } from "../store.ts";
import { ThreadStarters } from "../thread-starters.ts";
import { workspaceDir } from "../workspace.ts";
import { privateHandBack } from "./acting-person.ts";
import { createCloudTeamHost } from "./cloud-team-host.ts";
import { createTeamMessages } from "./team-messages.ts";

const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const CARL = { email: "carl@acme.test", role: "owner" as const };
const key = (email: string) => personKey({ id: "", email });
const stopped: Array<() => void> = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => { for (const stop of stopped.splice(0)) stop(); vi.restoreAllMocks(); });

function fixture() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot({ name: "Scout", createdBy: BOB.email });
  store.setChiefOfStaff(bot.id);
  const origin = store.createTask(bot.id, "Ada's plans", false)!.threadId;
  const ownersDir = join(DATA_DIR, "owners");
  mkdirSync(ownersDir);
  const file = join(ownersDir, "thread-starters.json");
  new ThreadStarters(file).set(origin, key(ADA.email));
  const open = (engineHomes?: Parameters<typeof createCloudTeamHost>[0]["engineHomes"]) => {
    const starters = new ThreadStarters(file);
    const current = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const host = createCloudTeamHost({ team: { id: "acme", name: "Acme" }, dataDir: DATA_DIR, store: current, starters, markers: new Set(), engineHomes });
    const notified: Notification[] = [];
    const sees = (email: string, threadId: string) => audienceIncludes(host.audienceOf(threadId), { person: key(email), admin: true, seesRoom: () => true });
    const team = createTeamMessages({
      team: { id: "acme", name: "Acme" }, dataDir: DATA_DIR, store: current, starters,
      audienceOf: host.audienceOf, personName: () => undefined,
      people: { everyone: () => [ADA, BOB, CARL].map((person) => ({ ...person, firstSeenAt: 1, lastSeenAt: 1 })) },
      sees: (person) => ({ bot: () => true, thread: (threadId) => sees(person.email, threadId) }),
      notify: (notification) => { notified.push(notification); },
      inbox: { askedPerson: () => null, continueTurn: () => {} },
    });
    stopped.push(team.stop);
    return { store: current, starters, host, team, notified, sees };
  };
  return { ...open(), botId: bot.id, main: bot.threadId, origin, file, ownersDir, open };
}

function legacyFixture(records: "homes" | "items" | "both" | "relays" = "both") {
  const f = fixture();
  f.team.stop();
  f.store.createBot({ name: "Mira" });
  f.store.createBot({ name: "Cleo" });
  const botsFile = join(DATA_DIR, "bots.json");
  const bots = JSON.parse(readFileSync(botsFile, "utf8")) as BotRecord[];
  const destinations = bots.flatMap((bot, index) => Array.from({ length: 20 }, (_, number) => {
    const threadId = `legacy-${index}-${number}`;
    bot.tasks!.push({ ...bot.tasks![0]!, threadId, title: "Legacy inbox" });
    return { botId: bot.id, threadId, person: key(`${threadId}@acme.test`) };
  }));
  const homes = records === "items" || records === "relays" ? {} : Object.fromEntries(destinations.map(({ person, botId, threadId }) => [person, { botId, threadId }]));
  const items = records === "homes" || records === "relays" ? [] : destinations.map((at) => ({ ...at, id: at.threadId, kind: "message", from: "Ada", text: "Private date", at: 1 }));
  writeFileSync(botsFile, JSON.stringify(bots));
  writeFileSync(join(DATA_DIR, "person-inbox.json"), JSON.stringify({ version: 1, homes, items }));
  if (records === "relays") writeFileSync(join(DATA_DIR, "team-messages.json"), JSON.stringify({ version: 1,
    relays: destinations.map(({ botId, threadId, person }) => ({ botId, threadId, originThreadId: f.origin, from: null, fromName: "Scout", to: person, at: 1 })),
    waiting: [{ id: "shared-mention", person: key(ADA.email), botId: f.botId, threadId: f.main, from: "Scout", text: "Shared update", at: 1 }],
  }));
  new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  return { ...f, botsFile, destinations };
}

describe("private message ownership", () => {
  it("reuses handed-on work only for its owner and keeps private results out of shared chats", () => {
    const f = fixture();
    const openedBy = { botId: f.botId, name: "Scout", kind: "work" as const, threadId: f.main, at: 1 };
    const orphan = f.store.createTask(f.botId, "Legacy private work", false, undefined, openedBy)!;
    f.store.backfillPrivateTasks([{ botId: f.botId, threadId: orphan.threadId }]);
    const own = f.store.createTask(f.botId, "Ada's handed-on work", false, undefined, openedBy)!;
    f.starters.set(own.threadId, key(ADA.email));
    const shared = f.store.createTask(f.botId, "Shared work", false, undefined, openedBy)!;
    expect(f.store.workThread(f.botId, f.botId, f.main, false, (task) => f.starters.get(task.threadId) === key(ADA.email))?.threadId).toBe(own.threadId);
    expect(f.store.workThread(f.botId, f.botId, f.main)?.threadId).toBe(shared.threadId);
    const restarted = f.open();
    expect(restarted.host.audienceOf(shared.threadId)).toBe("team");
    for (const threadId of [orphan.threadId, own.threadId]) {
      expect(restarted.sees(BOB.email, threadId)).toBe(false);
      expect(restarted.sees(CARL.email, threadId)).toBe(false);
      const outcome = { ok: true, text: "Private result", evidence: { text: "Private observation" } };
      const child = restarted.host.privateTo(threadId);
      expect(child).not.toBeNull();
      expect(privateHandBack(outcome, { child, parent: restarted.host.privateTo(f.main), bot: "Scout", person: "Ada" }))
        .toEqual({ ok: true, text: "Done. The result is in Scout's chat with Ada." });
      expect(privateHandBack(outcome, { child, parent: child, bot: "Scout", person: "Ada" })).toEqual(outcome);
    }
    expect(restarted.sees(ADA.email, own.threadId)).toBe(true);
    expect(restarted.sees(ADA.email, orphan.threadId)).toBe(false);
  });

  it.each([false, true])("finishes private memory capture and learns About you only for an owner (owned: %s)", async (owned) => {
    const f = fixture();
    const task = f.store.createTask(f.botId, "Private preferences", false)!;
    f.store.patchTask(f.botId, task.threadId, { private: true });
    if (owned) f.starters.set(task.threadId, key(ADA.email));
    expect(f.host.audienceOf(task.threadId)).toBe(owned ? memberAudience(key(ADA.email)) : `member:unowned-${task.threadId}`);
    const layer = f.host.layer(f.botId, task.threadId);
    f.host.people.write(key(ADA.email), "Existing preference");
    const write = vi.spyOn(f.host.people, "write");
    const plan = vi.fn((current: string) => ({ next: `${current}\nThe person is vegetarian`, count: 1 }));
    const upkeep = createMemoryUpkeep({
      bots: () => f.store.bots,
      bot: (id) => f.store.bot(f.host.baseBotId(id)) ?? undefined,
      engine: () => ({ generateText: async () => JSON.stringify([
        { text: "The person is vegetarian", kind: "preference", evidence: "I'm vegetarian", aboutUser: true, confidence: 0.9 },
      ]) }),
      busy: () => false,
      addToAboutMe: (from) => f.host.learnAbout(from.botId, plan),
      sourceLabel: () => 'chat "Private preferences"',
      quietMs: () => 60_000,
      tidyHour: () => 3,
    });
    stopped.push(() => upkeep.stop());
    await expect(upkeep.capture({ botId: layer, threadId: task.threadId, turns: [
      { person: "I'm vegetarian", bot: "I will remember your dietary preference.", owner: f.host.ownTurn(task.threadId) },
    ] })).resolves.toMatchObject({ added: 1, topics: 0, aboutMe: owned ? 1 : 0 });
    expect(upkeep.status(layer).lastCapture?.aboutMe).toBe(owned ? 1 : 0);
    expect(readFileSync(join(workspaceDir(layer), "MEMORY.md"), "utf8")).toContain("The person is vegetarian");
    expect(existsSync(join(DATA_DIR, "people", `unowned-${task.threadId}`))).toBe(false);
    if (owned) {
      expect(plan).toHaveBeenCalledWith("Existing preference");
      expect(write).toHaveBeenCalledWith(key(ADA.email), "Existing preference\nThe person is vegetarian");
    } else {
      expect(plan).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }
    expect(f.host.people.read(key(ADA.email))).toBe(owned ? "Existing preference\nThe person is vegetarian" : "Existing preference");
  });

  it.each(["homes", "items", "both", "relays"] as const)("backfills many legacy destinations from %s with one registry save and needs no save after restart", (records) => {
    const f = legacyFixture(records);
    const save = vi.spyOn(atomic, "writeFileAtomicIfChanged");
    const restarted = f.open();
    expect(save.mock.calls.filter(([file]) => file === f.botsFile)).toHaveLength(1);
    for (const at of f.destinations) {
      expect(restarted.store.taskByThread(at.botId, at.threadId)?.private).toBe(true);
      expect(restarted.starters.get(at.threadId)).toBeUndefined();
    }
    expect(restarted.host.audienceOf(f.main)).toBe("team");
    restarted.team.stop();
    f.open().team.stop();
    expect(save.mock.calls.filter(([file]) => file === f.botsFile)).toHaveLength(1);
    rmSync(join(DATA_DIR, "person-inbox.json"));
    if (records === "relays") rmSync(join(DATA_DIR, "team-messages.json"));
    const again = f.open();
    for (const at of f.destinations) expect(again.host.audienceOf(at.threadId)).toBe(`member:unowned-${at.threadId}`);
    expect(save.mock.calls.filter(([file]) => file === f.botsFile)).toHaveLength(1);
  });

  it("classifies old relay destinations before migration and retains their evidence across a failed backfill", () => {
    const f = legacyFixture("relays");
    const file = join(DATA_DIR, "team-messages.json");
    const before = readFileSync(file, "utf8");
    const write = atomic.writeFileAtomicIfChanged;
    const save = vi.spyOn(atomic, "writeFileAtomicIfChanged").mockImplementation((file, ...args) => {
      if (file === f.botsFile) throw new Error("synthetic registry save failure");
      return write(file, ...args);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let migrationAudience: string | undefined;
    const restarted = f.open({ start: ({ audienceOf }) => { migrationAudience = audienceOf(f.destinations[0]!.threadId); } });
    expect(migrationAudience).toBe(`member:unowned-${f.destinations[0]!.threadId}`);
    for (const at of f.destinations) for (const person of [ADA, BOB, CARL]) expect(restarted.sees(person.email, at.threadId)).toBe(false);
    expect(restarted.host.audienceOf(f.main)).toBe("team");
    expect(restarted.host.audienceOf(f.origin)).toBe(memberAudience(key(ADA.email)));
    restarted.team.stop();
    expect(readFileSync(file, "utf8")).toBe(before);
    save.mockRestore();
    const again = f.open();
    expect(again.store.privateTasksSaved).toBe(true);
    for (const at of f.destinations) expect(again.store.taskByThread(at.botId, at.threadId)?.private).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it.each(["{not json", "[]", '{"version":1,"relays":[{"threadId":"partial"}],"waiting":[]}'])("keeps the host up and uncertain threads closed over invalid legacy relay evidence (%s)", (contents) => {
    const f = legacyFixture("relays");
    const file = join(DATA_DIR, "team-messages.json");
    writeFileSync(file, contents);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = f.open();
    const asides = readdirSync(DATA_DIR).filter((name) => name.startsWith("team-messages.json.unreadable-"));
    expect(asides).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, asides[0]!), "utf8")).toBe(contents);
    expect(warn.mock.calls.flat().join(" ")).toContain("team-messages.json");
    for (const at of f.destinations) expect(started.sees(CARL.email, at.threadId)).toBe(false);
    expect(started.host.audienceOf(f.main)).toBe("team");
    started.team.stop();
    const restarted = f.open();
    for (const at of f.destinations) expect(restarted.sees(CARL.email, at.threadId)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["person-inbox.json", "team-messages.json"])("keeps classification closed when the directory containing %s cannot be listed", (name) => {
    const f = legacyFixture();
    rmSync(join(DATA_DIR, "person-inbox.json"));
    writeFileSync(join(DATA_DIR, `${name}.unreadable-1`), "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    chmodSync(DATA_DIR, 0o300);
    try {
      const host = createCloudTeamHost({ team: { id: "acme", name: "Acme" }, dataDir: DATA_DIR, store, starters: f.starters, markers: new Set() });
      expect(host.audienceOf(f.destinations[0]!.threadId)).toBe(`member:unowned-${f.destinations[0]!.threadId}`);
      expect(host.audienceOf(f.main)).toBe("team");
    } finally { chmodSync(DATA_DIR, 0o700); }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["person-inbox.json", "team-messages.json"])("preserves damaged %s evidence when moving it aside fails and a later save succeeds", (name) => {
    const f = legacyFixture(name === "team-messages.json" ? "relays" : "both");
    const file = join(DATA_DIR, name);
    writeFileSync(file, "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chmodSync(DATA_DIR, 0o500);
    let started: ReturnType<typeof f.open>;
    try { started = f.open(); } finally { chmodSync(DATA_DIR, 0o700); }
    expect(readFileSync(file, "utf8")).toBe("{not json");
    expect(started.team.pass(f.botId, f.origin, "Bob", "Private update").status).toBe(200);
    if (name === "team-messages.json") expect(readFileSync(file, "utf8")).toBe("{not json");
    started.team.stop();
    const again = f.open();
    const asides = readdirSync(DATA_DIR).filter((entry) => entry.startsWith(`${name}.unreadable-`));
    expect(asides).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, asides[0]!), "utf8")).toBe("{not json");
    for (const at of f.destinations) expect(again.sees(CARL.email, at.threadId)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps unreadable legacy relay bytes aside and carries on with private threads", () => {
    const f = legacyFixture("relays");
    const file = join(DATA_DIR, "team-messages.json");
    const before = readFileSync(file, "utf8");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chmodSync(file, 0o000);
    let started: ReturnType<typeof f.open>;
    try { started = f.open(); } finally {
      if (existsSync(file)) chmodSync(file, 0o600);
      for (const name of readdirSync(DATA_DIR).filter((name) => name.startsWith("team-messages.json.unreadable-"))) chmodSync(join(DATA_DIR, name), 0o600);
    }
    const asides = readdirSync(DATA_DIR).filter((name) => name.startsWith("team-messages.json.unreadable-"));
    expect(asides).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, asides[0]!), "utf8")).toBe(before);
    for (const at of f.destinations) expect(started.sees(CARL.email, at.threadId)).toBe(false);
    expect(started.team.pass(f.botId, f.origin, "Bob", "Private update").status).toBe(200);
  });

  it.each(["{not json", "[]"])("starts over an unreadable inbox file, keeps it aside, and keeps the legacy destinations closed until it is dealt with (%s)", (contents) => {
    const f = legacyFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(DATA_DIR, "person-inbox.json"), contents);
    const started = f.open();
    const aside = readdirSync(DATA_DIR).filter((name) => name.startsWith("person-inbox.json.unreadable-"));
    expect(aside, "the bad file is moved aside, not overwritten").toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, aside[0]!), "utf8")).toBe(contents);
    expect(warn.mock.calls.flat().join(" ")).toContain("person-inbox.json");
    for (const at of f.destinations) expect(started.host.audienceOf(at.threadId), "unclassifiable without the evidence: closed to everyone").toBe(`member:unowned-${at.threadId}`);
    expect(started.host.audienceOf(f.main), "a bot's main thread needs no inbox evidence").toBe("team");
    started.team.stop();
    const restarted = f.open();
    for (const at of f.destinations) expect(restarted.host.audienceOf(at.threadId), "still closed while the unreadable file sits aside").toBe(`member:unowned-${at.threadId}`);
    rmSync(join(DATA_DIR, aside[0]!));
    restarted.team.stop();
    expect(f.open().host.audienceOf(f.destinations[0]!.threadId), "removing the aside is the operator accepting the evidence is gone").toBe("team");
  });

  it("keeps every legacy destination denied in memory and logs a failed registry save", () => {
    const f = legacyFixture();
    const write = atomic.writeFileAtomicIfChanged;
    const save = vi.spyOn(atomic, "writeFileAtomicIfChanged").mockImplementation((file, ...args) => {
      if (file === f.botsFile) throw new Error("synthetic registry save failure");
      return write(file, ...args);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restarted = f.open();
    expect(save.mock.calls.filter(([file]) => file === f.botsFile)).toHaveLength(1);
    for (const at of f.destinations) {
      expect(restarted.store.taskByThread(at.botId, at.threadId)?.private).toBe(true);
      for (const person of [ADA, BOB, CARL]) expect(restarted.sees(person.email, at.threadId)).toBe(false);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not save"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("synthetic registry save failure"));
  });

  it.each([false, true])("keeps item-only legacy inboxes private across expiry and restart after a failed save (registry recovers: %s)", (recovers) => {
    const f = legacyFixture("items");
    const stateFile = join(DATA_DIR, "person-inbox.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.items.push({ id: "ada-waiting", person: key(ADA.email), botId: f.botId, threadId: f.origin, kind: "message", from: "Bob", text: "Update", at: Date.now() });
    writeFileSync(stateFile, JSON.stringify(state));
    let failSave = true;
    const write = atomic.writeFileAtomicIfChanged;
    vi.spyOn(atomic, "writeFileAtomicIfChanged").mockImplementation((file, ...args) => {
      if (file === f.botsFile && failSave) throw new Error("synthetic registry save failure");
      return write(file, ...args);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const restarted = f.open();
    for (const at of f.destinations) expect(restarted.store.taskByThread(at.botId, at.threadId)?.private).toBe(true);
    if (recovers) {
      failSave = false;
      restarted.store.patchTask(f.botId, f.main, { unread: true });
    }
    restarted.team.inbox.seen(key(ADA.email), f.origin);
    restarted.team.stop();
    failSave = false;
    const again = f.open();
    for (const at of f.destinations) {
      expect(again.host.audienceOf(at.threadId)).toBe(`member:unowned-${at.threadId}`);
      for (const person of [ADA, BOB, CARL]) expect(again.sees(person.email, at.threadId)).toBe(false);
    }
    expect(JSON.parse(readFileSync(stateFile, "utf8")).items).toHaveLength(recovers ? 1 : f.destinations.length + 1);
  });

  it("flushes a deferred read when the following registry save succeeds and keeps it read after restart", () => {
    const f = legacyFixture("items");
    const stateFile = join(DATA_DIR, "person-inbox.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.items.push({ id: "ada-waiting", person: key(ADA.email), botId: f.botId, threadId: f.origin, kind: "message", from: "Bob", text: "Update", at: Date.now() });
    const before = JSON.stringify(state);
    writeFileSync(stateFile, before);
    let failSave = true;
    const write = atomic.writeFileAtomicIfChanged;
    vi.spyOn(atomic, "writeFileAtomicIfChanged").mockImplementation((file, ...args) => {
      if (file === f.botsFile && failSave) throw new Error("synthetic registry save failure");
      return write(file, ...args);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const restarted = f.open();
    const auth = { kind: "session", session: { id: "ada", email: ADA.email } } as RequestAuth;
    expect(restarted.team.needsYou(auth)).toHaveLength(1);
    restarted.team.seen(auth, f.origin);
    expect(() => restarted.store.patchTask(f.botId, f.origin, { unread: false })).toThrow();
    expect(readFileSync(stateFile, "utf8")).toBe(before);
    expect(restarted.store.privateTasksSaved).toBe(false);
    failSave = false;
    restarted.team.seen(auth, f.origin);
    restarted.store.patchTask(f.botId, f.origin, { unread: false });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).items).toEqual([expect.objectContaining({ id: "ada-waiting", seen: true })]);
    restarted.team.stop();
    const again = f.open();
    expect(again.team.needsYou(auth)).toEqual([]);
    for (const at of f.destinations) expect(again.sees(BOB.email, at.threadId)).toBe(false);
  });

  it.each(["homes", "items"])("isolates an untouched ownerless legacy inbox from %s before engine-home migration", (records) => {
    const f = fixture();
    const shared = f.store.createTask(f.botId, "Shared work", false)!.threadId;
    expect(f.team.pass(f.botId, f.origin, "Bob", "Private launch date").status).toBe(200);
    const target = f.store.tasks(f.botId).find((task) => task.title === "Inbox")!.threadId;
    f.team.stop();
    const botsFile = join(DATA_DIR, "bots.json");
    const bots = JSON.parse(readFileSync(botsFile, "utf8")) as Array<{ tasks: Array<{ threadId: string; private?: true }> }>;
    for (const bot of bots) for (const task of bot.tasks) if (task.threadId === target) delete task.private;
    writeFileSync(botsFile, JSON.stringify(bots));
    const owners = JSON.parse(readFileSync(f.file, "utf8"));
    delete owners[target];
    writeFileSync(f.file, JSON.stringify(owners));
    const inboxFile = join(DATA_DIR, "person-inbox.json");
    const inbox = JSON.parse(readFileSync(inboxFile, "utf8"));
    if (records === "homes") inbox.items = [];
    else inbox.homes = {};
    writeFileSync(inboxFile, JSON.stringify(inbox));
    let migratedAudience: string | undefined;
    const restarted = f.open({ start: ({ audienceOf }) => { migratedAudience = audienceOf(target); } });
    expect(migratedAudience).toBe(`member:unowned-${target}`);
    expect(restarted.starters.get(target)).toBeUndefined();
    expect(restarted.store.taskByThread(f.botId, target)?.private).toBe(true);
    expect(restarted.host.audienceOf(f.main)).toBe("team");
    expect(restarted.host.audienceOf(shared)).toBe("team");
    expect(restarted.host.audienceOf(f.origin)).toBe(memberAudience(key(ADA.email)));
    for (const person of [ADA, BOB, CARL]) expect(restarted.sees(person.email, target), person.email).toBe(false);
    expect(restarted.store.messagesFor(target).map((message) => message.text)).toEqual(["Private launch date"]);
    restarted.team.stop();
    rmSync(inboxFile);
    expect(f.open().host.audienceOf(target)).toBe(`member:unowned-${target}`);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rolls back the provisional thread on EACCES, publishes nothing, and can retry", () => {
    const f = fixture();
    const before = f.store.tasks(f.botId).map((task) => task.threadId);
    chmodSync(f.ownersDir, 0o500);
    try {
      expect(() => f.team.pass(f.botId, f.origin, "Bob", "Private launch date")).toThrow(expect.objectContaining({ code: "EACCES" }));
      expect(f.store.tasks(f.botId).map((task) => task.threadId)).toEqual(before);
      expect(f.store.messagesFor(f.origin)).toEqual([]);
      expect(f.notified).toEqual([]);
    } finally {
      chmodSync(f.ownersDir, 0o700);
    }
    expect(f.open().store.tasks(f.botId).map((task) => task.threadId)).toEqual(before);
    expect(f.team.pass(f.botId, f.origin, "Bob", "Private launch date").status).toBe(200);
    const target = f.store.tasks(f.botId).find((task) => task.title === "Inbox")!.threadId;
    const restarted = f.open();
    expect(restarted.starters.get(target)).toBe(key(BOB.email));
    expect(restarted.store.messagesFor(target).map((message) => message.text)).toEqual(["Private launch date"]);
    expect(restarted.sees(BOB.email, target)).toBe(true);
    expect(restarted.sees(CARL.email, target)).toBe(false);
  });

  it.each([false, true])("keeps a private thread hidden after its owner is lost on disk (legacy: %s)", (legacy) => {
    const f = fixture();
    expect(f.team.pass(f.botId, f.origin, "Bob", "Private launch date").status).toBe(200);
    const target = f.store.tasks(f.botId).find((task) => task.title === "Inbox")!.threadId;
    if (legacy) {
      const botsFile = join(DATA_DIR, "bots.json");
      const bots = JSON.parse(readFileSync(botsFile, "utf8")) as Array<{ tasks: Array<{ threadId: string; private?: true }> }>;
      for (const bot of bots) for (const task of bot.tasks) if (task.threadId === target) delete task.private;
      writeFileSync(botsFile, JSON.stringify(bots));
      expect(f.open().team.pass(f.botId, f.origin, "Bob", "Private legacy follow-up").status).toBe(200);
    }
    const owners = JSON.parse(readFileSync(f.file, "utf8"));
    delete owners[target];
    writeFileSync(f.file, JSON.stringify(owners));
    const restarted = f.open();
    expect(restarted.host.audienceOf(f.main)).toBe("team");
    expect(restarted.host.audienceOf(f.origin)).toBe(memberAudience(key(ADA.email)));
    for (const person of [ADA, BOB, CARL]) expect(restarted.sees(person.email, target), person.email).toBe(false);
    expect(restarted.store.messagesFor(target).map((message) => message.text)).toEqual([
      "Private launch date", ...(legacy ? ["Private legacy follow-up"] : []),
    ]);
    expect(restarted.team.pass(f.botId, f.origin, "Bob", "Another private date").status).toBe(200);
    expect(restarted.store.messagesFor(target)).toHaveLength(legacy ? 2 : 1);
    expect(restarted.store.tasks(f.botId).filter((task) => task.title === "Inbox")).toHaveLength(2);
  });
});
