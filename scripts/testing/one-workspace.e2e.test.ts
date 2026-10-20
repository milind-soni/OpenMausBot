// This computer and My Cloud as one workspace, end to end: two real servers (this computer's and a Cloud home, bots sent
// between them by the real Send to My Cloud) with main's own wiring reading each for the other's page
// (one-workspace-fixture.ts). Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { OneWorkspaceView } from "../../shared/one-workspace.ts";
import { openChatLink } from "../../src/components/ThreadRefs.tsx";
import { automationsByBot, mergeWorkspace } from "../../src/lib/one-workspace.ts";
import { initialState, type Action, type AppState, type Bot, type Group } from "../../src/state/store.tsx";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";
import { seedOneWorkspace, wireOneWorkspace, type OneWorkspaceWiring } from "./one-workspace-fixture.ts";
import { ROSTER_FRESH_MS } from "../../electron/one-workspace.mjs";
import { freePortBlock } from "../../server/testing/ports.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";

const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let fx: CloudSendFixture;
let one: OneWorkspaceWiring;
let ids: Awaited<ReturnType<typeof seedOneWorkspace>>;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-one-${randomBytes(12).toString("hex")}` });
  ids = await seedOneWorkspace(fx, DOT);
  one = wireOneWorkspace(fx);
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

const storeOf = async (side: "local" | "onCloud"): Promise<{ bots: Bot[]; groups: Group[]; sections: string[] }> => (await fx[side]("GET", "/api/bots?messages=0")).body;
/** What a page shows: its own store's rows plus the other side's, by id. */
function rows(view: OneWorkspaceView, own: { bots: Bot[]; groups: Group[]; sections: string[] }) {
  const merged = mergeWorkspace(view, own);
  const shown = [...own.bots.filter((bot) => !bot.hidden && !merged.hidden.has(bot.id)), ...own.groups.filter((group) => !group.dm && !merged.hidden.has(group.id)), ...merged.bots, ...merged.rooms];
  return { merged, ids: shown.map((item) => item.id), homes: Object.fromEntries(shown.map((item) => [item.id, merged.homes.get(item.id)?.side])) };
}

it("shows every bot and room of both sides once, each with its home, on this computer's page and on My Cloud's", async () => {
  const fromLocal = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(fromLocal.other).toMatchObject({ side: "cloud", state: "ready" });
  expect(fromLocal.other.bots.map((bot) => bot.name).sort()).toEqual(["Atlas", "Ember", "Kit", "Miso"]);
  const here = rows(fromLocal, await storeOf("local"));
  const everything = Object.values(ids).sort();
  expect([...here.ids].sort()).toEqual(everything);
  expect(new Set(here.ids).size).toBe(here.ids.length);
  expect(here.homes).toEqual({ [ids.ember]: "computer", [ids.juno]: "computer", [ids.miso]: "cloud", [ids.atlas]: "cloud", [ids.kit]: "cloud", [ids.launch]: "cloud" });
  expect(here.merged.homes.get(ids.ember)).toEqual({ side: "computer", twin: true });
  expect(here.merged.sections).toEqual(["Ops"]);

  const fromCloud = await one.call<OneWorkspaceView>("one-workspace:view", "cloud");
  expect(fromCloud.other).toMatchObject({ side: "computer", state: "ready" });
  const there = rows(fromCloud, await storeOf("onCloud"));
  expect([...there.ids].sort()).toEqual(everything);
  expect(new Set(there.ids).size).toBe(there.ids.length);
  expect(there.homes).toEqual(here.homes);
});

it("reads My Cloud in the background with the window's own sign-in, and hands a page only what a row shows", async () => {
  const view = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(one.cloudCalls.length).toBeGreaterThan(0);
  for (const call of one.cloudCalls) {
    expect(call.headers["x-omb-background"]).toBe("1");
    expect(call.headers.authorization).toBeUndefined();
  }
  const ember = view.other.bots.find((bot) => bot.id === ids.ember)!;
  expect(ember.avatarUrl).toBe(`data:image/png;base64,${DOT.toString("base64")}`);
  const text = JSON.stringify(view);
  for (const secret of ["You are Atlas", "You are Miso", "You are Ember", "modelSelection", "soul", fx.owner, fx.ownerCapability]) expect(text).not.toContain(secret);
});

it("opening a Cloud bot moves the window to My Cloud, whose page opens it from My Cloud's own server; this computer's page opens its own the same way", async () => {
  await one.call("one-workspace:view", "local");
  await expect(one.call("one-workspace:open", "local", { side: "cloud", id: ids.juno })).rejects.toThrow(/no longer on My Cloud/);
  await expect(one.call("one-workspace:open", null, { side: "cloud", id: ids.atlas })).rejects.toThrow(/only available/);
  expect(one.went).toEqual([]);

  await one.call("one-workspace:open", "local", { side: "cloud", id: ids.atlas });
  expect(one.went).toEqual(["cloud"]);
  expect(await one.call("one-workspace:take", "local")).toBeNull();
  const link = await one.call<string>("one-workspace:take", "cloud");
  expect(link).toBe(`openmausbot://bot/${ids.atlas}`);
  // My Cloud's page opens the link against My Cloud's own bots, as useExternalChatLinks does after hydrating.
  const cloud = await storeOf("onCloud");
  const actions: Action[] = [];
  const page: AppState = { ...initialState, bots: cloud.bots.map((bot) => ({ ...bot, messages: [] })), groups: cloud.groups.map((group) => ({ ...group, messages: [] })), hydrated: true };
  expect(openChatLink((action) => actions.push(action), link, page, false)).toBe(true);
  expect(actions[0]).toEqual({ type: "select", id: ids.atlas });
  expect((await storeOf("local")).bots.some((bot) => bot.id === ids.atlas)).toBe(false);

  await one.call("one-workspace:open", "local", { side: "cloud", id: ids.launch });
  expect(await one.call("one-workspace:take", "cloud")).toBe(`openmausbot://bot/${ids.launch}`);

  await one.call("one-workspace:view", "cloud");
  await one.call("one-workspace:open", "cloud", { side: "computer", id: ids.juno });
  expect(one.went).toEqual(["cloud", "cloud", "local"]);
  expect(await one.call("one-workspace:take", "local")).toBe(`openmausbot://bot/${ids.juno}`);
});

it("after Send everything every bot is on both sides with the same id: each shows once at home, chats there with the history shown, and what My Cloud's copy has of its own opens there", async () => {
  type Turnable = { id: string; busy?: boolean; threadId: string; messages?: Array<{ id: string; text?: string }> };
  const bots = async (side: "local" | "onCloud") => (await fx[side]("GET", "/api/bots?messages=200")).body.bots as Turnable[];
  const settled = async (side: "local" | "onCloud", id: string) => {
    for (let tries = 0; tries < 200; tries++) {
      if ((await bots(side)).find((bot) => bot.id === id)?.busy === false) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${id} never settled on ${side}`);
  };
  const said = (bot: Turnable | undefined, text: string) => bot?.messages?.find((message) => message.text === text);

  // Juno has a history here; Send everything takes every bot, chats included, under the same ids.
  expect((await fx.local("POST", `/api/bots/${ids.juno}/messages`, { text: "Draft the weekly notes." })).status).toBe(202);
  await settled("local", ids.juno);
  const everything = await fx.call<{ result: { bots: string[]; failed: unknown[] } }>("cloud-send:send", "local", {});
  expect(everything.result.failed).toEqual([]);
  const cloudJuno = (await bots("onCloud")).find((bot) => bot.id === ids.juno);
  expect(said(cloudJuno, "Draft the weekly notes.")?.id).toBe(said((await bots("local")).find((bot) => bot.id === ids.juno), "Draft the weekly notes.")?.id);

  const wire = wireOneWorkspace(fx, { file: join(fx.root, "twins.json") });
  const fromLocal = await wire.call<OneWorkspaceView>("one-workspace:view", "local");
  const shown = rows(fromLocal, await storeOf("local"));
  expect([...shown.ids].sort()).toEqual(Object.values(ids).sort());
  expect(new Set(shown.ids).size).toBe(shown.ids.length);
  expect(shown.merged.homes.get(ids.juno)).toEqual({ side: "computer", twin: true });
  expect(shown.merged.homes.get(ids.ember)).toEqual({ side: "computer", twin: true });
  expect(shown.merged.twinWork.size).toBe(0);

  // Juno's row is this computer's: a message lands here, in the history the row shows, and reaches My Cloud's copy
  // only with the next send, under the same id.
  expect((await fx.local("POST", `/api/bots/${ids.juno}/messages`, { text: "Add the release date." })).status).toBe(202);
  await settled("local", ids.juno);
  const here = (await bots("local")).find((bot) => bot.id === ids.juno);
  expect([said(here, "Draft the weekly notes."), said(here, "Add the release date.")].every(Boolean)).toBe(true);
  expect(said((await bots("onCloud")).find((bot) => bot.id === ids.juno), "Add the release date.")).toBeUndefined();
  await fx.call("cloud-send:send", "local", {});
  expect(said((await bots("onCloud")).find((bot) => bot.id === ids.juno), "Add the release date.")?.id).toBe(said(here, "Add the release date.")?.id);

  // Something of My Cloud's own: a chat from the phone and a routine, both made there. Routines stay where they were made.
  const phone = (await fx.onCloud("POST", `/api/bots/${ids.juno}/tasks`, { title: "From my phone" })).body.task.threadId as string;
  expect((await fx.onCloud("POST", `/api/bots/${ids.juno}/messages`, { text: "Remind me at five.", threadId: phone })).status).toBe(202);
  await settled("onCloud", ids.juno);
  expect((await fx.onCloud("POST", "/api/routines", { name: "Nightly notes", prompt: "Write tonight's notes.", botId: ids.juno,
    schedule: { type: "interval", everyMinutes: 1_440, anchorAt: Date.now() + 86_400_000 } })).status).toBe(201);
  const routinesOf = async (side: "local" | "onCloud") => ((await fx[side]("GET", "/api/routines")).body.routines as Array<{ botId: string }>).filter((routine) => routine.botId === ids.juno);
  expect([(await routinesOf("onCloud")).length, (await routinesOf("local")).length]).toEqual([1, 0]);

  const later = wireOneWorkspace(fx, { file: join(fx.root, "twins-later.json") });
  const again = rows(await later.call<OneWorkspaceView>("one-workspace:view", "local"), await storeOf("local"));
  expect(again.ids.filter((id) => id === ids.juno)).toHaveLength(1);
  expect(again.merged.twinWork.get(ids.juno)).toMatchObject({ side: "cloud", chats: 1, automations: 1, threadId: phone });
  await later.call("one-workspace:open", "local", { side: "cloud", id: ids.juno, threadId: phone });
  const link = await later.call<string>("one-workspace:take", "cloud");
  expect(link).toBe(`openmausbot://thread/${phone}?bot=${ids.juno}`);
  const cloud = await storeOf("onCloud");
  const actions: Action[] = [];
  const page: AppState = { ...initialState, bots: cloud.bots.map((bot) => ({ ...bot, messages: [] })), groups: cloud.groups.map((group) => ({ ...group, messages: [] })), hydrated: true };
  expect(openChatLink((action) => actions.push(action), link, page, true)).toBe(true);
  expect(actions).toContainEqual(expect.objectContaining({ threadId: phone }));

  // My Cloud's page shows the same one row, this computer's Juno, with the same line under it.
  const cloudRoutines = (await fx.onCloud("GET", "/api/routines")).body.routines as Array<{ botId: string; enabled: boolean }>;
  const fromCloud = mergeWorkspace(await later.call<OneWorkspaceView>("one-workspace:view", "cloud"),
    { ...cloud, automations: automationsByBot(cloudRoutines, []) });
  expect(fromCloud.hidden.has(ids.juno)).toBe(true);
  expect(fromCloud.homes.get(ids.juno)).toEqual({ side: "computer", twin: true });
  expect(fromCloud.twinWork.get(ids.juno)).toMatchObject({ side: "cloud", chats: 1, automations: 1, threadId: phone });

  // Even with My Cloud's Juno open on My Cloud's page (from a notification, say), the row stays this computer's Juno,
  // and opening it goes home at that same chat.
  const openOnCloud = mergeWorkspace(await later.call<OneWorkspaceView>("one-workspace:view", "cloud"), { ...cloud, selectedId: ids.juno });
  const cloudJunoThread = cloud.bots.find((bot) => bot.id === ids.juno)!.threadId;
  expect(openOnCloud.hidden.has(ids.juno)).toBe(true);
  expect(openOnCloud.opened).toEqual(cloudJunoThread === here?.threadId ? { id: ids.juno, threadId: cloudJunoThread } : { id: ids.juno });

  // A phone message into the chat both copies have (the same conversation id) is never invisible here: the line counts
  // the messages only My Cloud has there and opens My Cloud at that chat.
  const shared = here!.threadId;
  expect((await fx.onCloud("POST", `/api/bots/${ids.juno}/messages`, { text: "(from my phone) Also add the venue.", threadId: shared })).status).toBe(202);
  await settled("onCloud", ids.juno);
  const phoneFile = join(fx.root, "twins-phone.json");
  const phoneLater = wireOneWorkspace(fx, { file: phoneFile });
  const onlyThere = async (wiring: OneWorkspaceWiring) => rows(await wiring.call<OneWorkspaceView>("one-workspace:view", "local"), await storeOf("local")).merged.twinWork.get(ids.juno);
  expect(await onlyThere(phoneLater)).toMatchObject({ side: "cloud", chats: 1, unshared: 2, automations: 1 });
  await phoneLater.call("one-workspace:open", "local", { side: "cloud", id: ids.juno, threadId: shared });
  expect(await phoneLater.call<string>("one-workspace:take", "cloud")).toBe(`openmausbot://thread/${shared}?bot=${ids.juno}`);
  // Nothing of it came to this computer's chat: Phase 1 only shows where it is.
  expect(said((await bots("local")).find((bot) => bot.id === ids.juno), "(from my phone) Also add the venue.")).toBeUndefined();

  // This computer replies in that chat afterwards: the two phone messages still count.
  expect((await fx.local("POST", `/api/bots/${ids.juno}/messages`, { text: "Use the town hall.", threadId: shared })).status).toBe(202);
  await settled("local", ids.juno);
  await new Promise((resolve) => setTimeout(resolve, ROSTER_FRESH_MS));
  expect(await onlyThere(phoneLater)).toMatchObject({ unshared: 2 });
  // Right after a send copies the reply to My Cloud, both copies' newest message is the same: still two, and after a restart.
  const inShared = async (side: "local" | "onCloud") => ((await fx[side]("GET", `/api/threads/${shared}/messages?limit=200`)).body.messages as Array<{ id: string; text?: string; at: number }>);
  const sent = await fx.call<{ result: { failed: unknown[] } }>("cloud-send:send", "local", {});
  expect(sent.result.failed).toEqual([]);
  const [hereNow, thereNow] = [await inShared("local"), await inShared("onCloud")];
  expect(thereNow.find((row) => row.text === "Use the town hall.")?.id).toBe(hereNow.find((row) => row.text === "Use the town hall.")?.id);
  const newestAt = async (side: "local" | "onCloud") => (await storeOf(side)).bots.find((bot) => bot.id === ids.juno)?.tasks?.find((task) => task.threadId === shared)?.updatedAt;
  expect(await newestAt("onCloud")).toBe(await newestAt("local"));
  await new Promise((resolve) => setTimeout(resolve, ROSTER_FRESH_MS));
  expect(await onlyThere(phoneLater)).toMatchObject({ unshared: 2 });
  expect(await onlyThere(wireOneWorkspace(fx, { file: phoneFile }))).toMatchObject({ unshared: 2 });
}, hostTimeout(150_000));

it("an unreachable or asleep My Cloud keeps its bots (an asleep one is never called), then and after a restart", async () => {
  // Whatever the tests before sent there: the roster main holds is My Cloud's as it is now.
  const cloudNames = (await storeOf("onCloud")).bots.filter((bot) => !bot.hidden).map((bot) => bot.name).sort();
  const names = (view: OneWorkspaceView) => view.other.bots.map((bot) => bot.name).sort();
  for (let tries = 0; tries < 60 && JSON.stringify(names(await one.call<OneWorkspaceView>("one-workspace:view", "local"))) !== JSON.stringify(cloudNames); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  one.network.down = true;
  await new Promise((resolve) => setTimeout(resolve, ROSTER_FRESH_MS + 100));
  const offline = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(offline.other.state).toBe("unreachable");
  expect(names(offline)).toEqual(cloudNames);
  expect(mergeWorkspace(offline, await storeOf("local")).bots.map((bot) => bot.name).sort()).toEqual(["Atlas", "Kit", "Miso"]);

  one.network.down = false;
  one.power.asleepNow = true;
  const before = one.cloudCalls.length;
  const asleep = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(one.cloudCalls.length).toBe(before);
  expect(asleep.other.state).toBe("asleep");
  expect(names(asleep)).toEqual(cloudNames);
  // Opening one is what wakes it.
  await one.call("one-workspace:open", "local", { side: "cloud", id: ids.kit });
  expect(one.went.at(-1)).toBe("cloud");

  const restarted = wireOneWorkspace(fx);
  restarted.power.asleepNow = true;
  const atLaunch = await restarted.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(restarted.cloudCalls).toEqual([]);
  expect(atLaunch.other.state).toBe("asleep");
  expect(names(atLaunch)).toEqual(cloudNames);

  const never = wireOneWorkspace(fx, { cloudOrigin: `http://127.0.0.1:${await freePortBlock([0])}`, file: join(fx.root, "never-read.json") });
  expect((await never.call<OneWorkspaceView>("one-workspace:view", "local")).other).toMatchObject({ state: "unreachable", bots: [] });
}, hostTimeout(30_000));
