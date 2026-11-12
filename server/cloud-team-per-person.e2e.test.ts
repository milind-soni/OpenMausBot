// What each person on a Team Cloud keeps for themselves though the team shares the thing it is about (docs/team-cloud.md):
// a bot's Shared chat's unread mark, a notification's read mark, and the order of their bots.
// A real Team Cloud with the Owner, an Admin and two Users (Ada and Cleo), paired with the Admin's signed claims: one
// person reading, marking or reordering changes nothing for another, and their streams hear only their own. The engine
// is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";`;

type Task = { threadId: string; unread?: boolean; lastReadMessageId?: string };
type Bot = { id: string; mainThreadId: string; busy?: boolean; activity?: string; unread?: boolean; tasks: Task[] };
type Note = { id: string; kind: string; threadId: string; read: boolean };

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", ada = "", cleo = "";
let scout: Bot, pilot: Bot;

const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
const mainChat = async (token: string) => (await bots(token)).find((bot) => bot.id === scout.id)!.tasks.find((task) => task.threadId === scout.mainThreadId)!;
const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as unknown[];
const idle = async (token: string) => (await bots(token)).every((bot) => bot.activity !== "working" && !bot.busy);
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** One line in Scout's Shared chat and its reply. */
async function turn(token: string, text: string) {
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = (await messages(token, scout.mainThreadId)).length;
  const sent = await team.as(token, "POST", `/api/bots/${scout.id}/messages`, { text, threadId: scout.mainThreadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => await idle(token) && (await messages(token, scout.mainThreadId)).length >= before + 2 && existsSync(join(team.home, "dump.json")));
}
/** One person's live stream: every frame it was sent. */
async function listen(token: string) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await until(() => text.includes("\"hello\""), 10_000);
  const frames = () => text.split("\n\n").flatMap((part) => {
    const data = part.split("\n").find((line) => line.startsWith("data: "));
    try { return data ? [JSON.parse(data.slice(6)) as Record<string, any>] : []; } catch { return []; }
  }).filter((frame) => frame.kind !== "hello");
  return { frames, close: async () => { controller.abort(); await done; } };
}
/** Long enough for a frame fanned out in the same pass as one that arrived to have arrived too. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  cleo = (await team.pair(CLEO)).token!;
  for (const name of ["Scout", "Pilot"]) {
    const created = await team.as(owner, "POST", "/api/bots", { name, visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (name === "Scout") scout = created.body.bot; else pilot = created.body.bot;
  }
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("the Shared chat's unread mark is each person's own: reading or marking it changes it for nobody else", async () => {
  await turn(owner, "Morning, Scout.");
  for (const token of [ada, cleo, admin]) expect((await mainChat(token)).unread).toBe(true);
  const cleosBefore = await mainChat(cleo);
  const read = await team.as(ada, "POST", `/api/bots/${scout.id}/read`, { threadId: scout.mainThreadId });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect((read.body.bot as Bot).tasks.find((task) => task.threadId === scout.mainThreadId)!.unread).toBe(false);
  expect((await mainChat(ada)).unread).toBe(false);
  for (const token of [cleo, admin]) expect((await mainChat(token)).unread, "Ada reading is Ada's alone").toBe(true);
  const cleosAfter = await mainChat(cleo);
  expect({ unread: cleosAfter.unread, lastReadMessageId: cleosAfter.lastReadMessageId }, "nothing of Ada's read reaches Cleo's copy")
    .toEqual({ unread: cleosBefore.unread, lastReadMessageId: cleosBefore.lastReadMessageId });
  // The bot's next reply is new to Ada again.
  await turn(cleo, "And the afternoon?");
  expect((await mainChat(ada)).unread).toBe(true);
  // Marking it unread is hers alone too, and Cleo reading leaves Ada's mark.
  for (const token of [ada, cleo]) expect((await team.as(token, "POST", `/api/bots/${scout.id}/read`, { threadId: scout.mainThreadId })).status).toBe(200);
  const marked = await team.as(ada, "PATCH", `/api/bots/${scout.id}`, { unread: true });
  expect(marked.status, JSON.stringify(marked.body)).toBe(200);
  expect((await mainChat(ada)).unread).toBe(true);
  expect((await mainChat(cleo)).unread, "Ada marking it unread is Ada's alone").toBe(false);
  expect((await team.as(cleo, "POST", `/api/bots/${scout.id}/read`, { threadId: scout.mainThreadId })).status).toBe(200);
  expect((await mainChat(ada)).unread, "Cleo reading leaves Ada's mark").toBe(true);
}, hostTimeout(120_000));

it("a person's read of the Shared chat reaches their own streams only", async () => {
  await turn(owner, "Anything new?");
  const adas = await listen(ada), cleos = await listen(cleo);
  try {
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/read`, { threadId: scout.mainThreadId })).status).toBe(200);
    const scoutFrames = (frames: Array<Record<string, any>>) => frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === scout.id);
    await until(() => scoutFrames(adas.frames()).some((frame) => frame.bot.tasks?.find((task: Task) => task.threadId === scout.mainThreadId)?.unread === false), 10_000);
    await settle();
    expect(scoutFrames(cleos.frames()), "Ada's read never reaches Cleo's stream").toEqual([]);
    expect((await mainChat(cleo)).unread).toBe(true);
  } finally {
    await adas.close();
    await cleos.close();
  }
}, hostTimeout(90_000));

it("reading a notification of the Shared chat is each person's own, and only their streams hear it", async () => {
  const feed = async (token: string) => ((await team.as(token, "GET", "/api/notifications")).body.notifications as Note[])
    .filter((note) => note.threadId === scout.mainThreadId && note.kind === "done");
  const unreadIn = async (token: string) => (await feed(token)).filter((note) => !note.read).map((note) => note.id);
  await turn(owner, "Draft the weekly note.");
  await until(async () => (await unreadIn(ada)).length > 0);
  const [first] = await unreadIn(ada);
  for (const token of [cleo, admin, owner]) expect(await unreadIn(token)).toContain(first);
  expect((await team.as(ada, "POST", `/api/notifications/${first}/read`)).status).toBe(200);
  expect(await unreadIn(ada)).not.toContain(first);
  for (const token of [cleo, admin, owner]) expect(await unreadIn(token), "Ada reading it is Ada's alone").toContain(first);
  // Read all is the reader's own too.
  expect((await team.as(cleo, "POST", "/api/notifications/read-all")).status).toBe(200);
  expect(await unreadIn(cleo)).toEqual([]);
  expect(await unreadIn(admin)).toContain(first);
  // Opening the chat reads its notifications for the opener, and only the opener's streams hear it.
  await turn(owner, "And the monthly one.");
  await until(async () => (await unreadIn(cleo)).length > 0);
  const adas = await listen(ada), cleos = await listen(cleo);
  try {
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/read`, { threadId: scout.mainThreadId })).status).toBe(200);
    await until(() => adas.frames().some((frame) => frame.kind === "notifications.read"), 10_000);
    await settle();
    expect(cleos.frames().filter((frame) => frame.kind === "notifications.read"), "Ada's read never reaches Cleo's stream").toEqual([]);
    expect(await unreadIn(ada)).toEqual([]);
    expect((await unreadIn(cleo)).length, "Ada opening the chat leaves Cleo's unread").toBeGreaterThan(0);
  } finally {
    await adas.close();
    await cleos.close();
  }
}, hostTimeout(120_000));

it("each person orders their own bots; an Owner's or Admin's order is the team's default for whoever has not", async () => {
  const order = async (token: string) => (await bots(token)).map((bot) => bot.id).filter((id) => id === scout.id || id === pilot.id);
  const teams = await order(owner), flipped = [...teams].reverse();
  for (const token of [admin, ada, cleo]) expect(await order(token)).toEqual(teams);
  const cleos = await listen(cleo), adas = await listen(ada);
  try {
    const moved = await team.as(ada, "PUT", "/api/bots/order", { botIds: flipped });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((moved.body.botIds as string[]).filter((id) => id === scout.id || id === pilot.id)).toEqual(flipped);
    expect(await order(ada)).toEqual(flipped);
    for (const token of [owner, admin, cleo]) expect(await order(token), "Ada's order is Ada's alone").toEqual(teams);
    await until(() => adas.frames().some((frame) => frame.kind === "bots.order"), 10_000);
    await settle();
    expect(cleos.frames().filter((frame) => frame.kind === "bots.order"), "Ada's order never reaches Cleo's stream").toEqual([]);
  } finally {
    await cleos.close();
    await adas.close();
  }
  // The Owner sets the team's default: everyone who never ordered their own follows it, Ada keeps hers.
  expect((await team.as(owner, "PUT", "/api/bots/order", { botIds: flipped })).status).toBe(200);
  for (const token of [owner, admin, cleo]) expect(await order(token)).toEqual(flipped);
  expect((await team.as(admin, "PUT", "/api/bots/order", { botIds: teams })).status).toBe(200);
  for (const token of [owner, admin, cleo]) expect(await order(token), "an Admin's order is the default too").toEqual(teams);
  expect(await order(ada), "Ada keeps the order she chose").toEqual(flipped);
  // A bot made after she ordered hers takes its place in the team's order in her list too.
  const created = await team.as(owner, "POST", "/api/bots", { name: "Atlas", visibility: "everyone" });
  expect(created.status).toBe(201);
  const atlas = created.body.bot.id as string;
  const three = async (token: string) => (await bots(token)).map((bot) => bot.id).filter((id) => [scout.id, pilot.id, atlas].includes(id));
  const atlasAt = (await three(owner)).indexOf(atlas);
  expect(await three(cleo)).toEqual(await three(owner));
  expect((await three(ada)).indexOf(atlas)).toBe(atlasAt);
  expect((await three(ada)).filter((id) => id !== atlas)).toEqual(flipped);
}, hostTimeout(90_000));

it("a User's open chat counts as in front of them, and nobody can name another person's private chat as theirs", async () => {
  const opened = await team.as(ada, "POST", `/api/bots/${scout.id}/tasks`, { title: "Ada's notes" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const private_ = opened.body.task.threadId as string;
  expect((await team.as(ada, "POST", "/api/presence/active", { source: "desktop", threadId: private_ })).status).toBe(200);
  for (const token of [cleo, owner]) expect((await team.as(token, "POST", "/api/presence/active", { source: "desktop", threadId: private_ })).status).toBe(404);
}, hostTimeout(60_000));

it("when Ada leaves the team, her own order and her read marks go with her, and Cleo's stay", async () => {
  const dataDir = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);
  const adaKey = personKey({ id: "", email: ADA.email }), cleoKey = personKey({ id: "", email: CLEO.email });
  const readers = () => {
    const db = new DatabaseSync(dataDir("messages.db"), { readOnly: true });
    try {
      return (db.prepare("SELECT read_by FROM notification_log WHERE read_by IS NOT NULL").all() as Array<{ read_by: string }>).flatMap((row) => JSON.parse(row.read_by) as string[]);
    } finally {
      db.close();
    }
  };
  // Ada and Cleo both read the same notification, so a row lists them both.
  await turn(owner, "One more for the road.");
  for (const token of [ada, cleo]) expect((await team.as(token, "POST", "/api/notifications/read-all")).status).toBe(200);
  expect(readers()).toEqual(expect.arrayContaining([adaKey, cleoKey]));
  expect(readFileSync(dataDir("bot-orders.json"), "utf8")).toContain(adaKey);
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: ADA.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(readers(), "her read marks are gone").not.toContain(adaKey);
  expect(readers(), "Cleo's stay").toContain(cleoKey);
  expect(readFileSync(dataDir("bot-orders.json"), "utf8"), "her order is gone").not.toContain(adaKey);
  expect(readFileSync(dataDir("room-reads.json"), "utf8")).not.toContain(adaKey);
  expect((await team.as(cleo, "GET", "/api/notifications")).status).toBe(200);
}, hostTimeout(90_000));
