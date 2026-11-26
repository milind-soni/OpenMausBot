// The Team Board on a real Team Cloud: Olive (the Owner) and three Members. Desk is in the Launch room everyone sees;
// Payroll is shared with Mira to chat and Cara to view, so its Pay desk room is Mira's and Cara's to see and Ben's not at
// all. The board answers 404 until Olive switches it on; a member's item opens a room thread with their line and starts
// no turn; nobody who cannot see the room hears of its items; needs ready what waits on them; and a personal Cloud has
// no board. The engine is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { BoardItem, BoardItemFrame } from "../shared/board.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const CARA = { email: "cara@acme.test", role: "member" as const };

type Room = { id: string; threadId: string };
type Line = { role: string; text?: string; sender?: { name: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", mira = "", ben = "", cara = "";
let launch: Room, payDesk: Room;

const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Line[];
const idle = async () => ((await team.as(olive, "GET", "/api/bots")).body.bots as Array<{ busy?: boolean; activity?: string }>)
  .every((bot) => !bot.busy && bot.activity !== "working");
const board = async (token: string, query = "") => {
  const listed = await team.as(token, "GET", `/api/board${query}`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.items as BoardItem[];
};
const add = async (token: string, body: Record<string, unknown>) => {
  const made = await team.as(token, "POST", "/api/board/items", body);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.item as BoardItem;
};
const patch = (token: string, threadId: string, body: Record<string, unknown>) => team.as(token, "PATCH", `/api/board/items/${threadId}`, body);

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One person's live stream: every board frame it was sent. */
async function listen(token: string) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await until(() => text.includes("\"hello\""));
  const frames = () => [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]!) as { kind: string })
    .filter((frame): frame is BoardItemFrame => frame.kind === "board.item");
  return { frames, close: async () => { controller.abort(); await done; } };
}

beforeAll(async () => {
  // The dispatcher's quiet minutes after a start last hours here: this file is about items, and nothing takes them.
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-board-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-board", name: "Acme", env: { OMB_BOARD_TIME_SCALE: "1000" } } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  mira = (await team.pair(MIRA)).token!;
  ben = (await team.pair(BEN)).token!;
  cara = (await team.pair(CARA)).token!;
  const bot = async (name: string) => {
    const made = await team.as(olive, "POST", "/api/bots", { name, visibility: "everyone" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.bot as { id: string };
  };
  const desk = await bot("Desk");
  const payroll = await bot("Payroll");
  const shared = await team.as(olive, "PUT", `/api/bots/${payroll.id}/access`, { everyone: "none", people: { [MIRA.email]: "chat", [CARA.email]: "view" } });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  const room = async (name: string, memberIds: string[]) => {
    const made = await team.as(olive, "POST", "/api/groups", { name, memberIds, setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.group as Room;
  };
  launch = await room("Launch", [desk.id]);
  payDesk = await room("Pay desk", [payroll.id]);
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it("has no board until it is switched on, and the switch shows only here", async () => {
  expect((await team.as(mira, "GET", "/api/board")).status).toBe(404);
  expect((await team.as(mira, "POST", "/api/board/items", { groupId: launch.id, title: "Early" })).status).toBe(404);
  expect((await team.as(olive, "GET", "/api/config")).body.features.teamBoard).toBe(false);
  const on = await team.as(olive, "PATCH", "/api/config", { features: { teamBoard: true } });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  expect(on.body.features.teamBoard).toBe(true);
  expect((await team.as(mira, "GET", "/api/config")).body.features?.teamBoard).toBe(true);
  expect(await board(mira)).toEqual([]);
  expect((await fx.onCloud("GET", "/api/config")).body.features?.teamBoard).toBeUndefined();
}, hostTimeout(60_000));

it("a member's item opens a room thread with their line and starts no turn", async () => {
  const item = await add(mira, { groupId: launch.id, title: "Draft the launch post", text: "Please draft the launch post for Friday.", labels: { area: "marketing" } });
  expect(item).toMatchObject({ groupId: launch.id, title: "Draft the launch post", state: "ready", labels: { area: "marketing" }, attempts: 0, createdBy: { kind: "person" } });
  expect(item.threadId).not.toBe(launch.threadId);
  const lines = await messages(mira, item.threadId);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ role: "user", text: "Please draft the launch post for Friday." });
  expect(lines[0]!.sender?.name).toBeTruthy();
  const rooms = (await team.as(mira, "GET", "/api/bots?messages=0")).body.groups as Array<Room & { tasks?: Array<{ threadId: string; title: string }> }>;
  const room = rooms.find((one) => one.id === launch.id)!;
  expect(room.threadId, "the room's current thread stays where it was").toBe(launch.threadId);
  expect(room.tasks?.find((task) => task.threadId === item.threadId)?.title).toBe("Draft the launch post");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(await idle()).toBe(true);
  expect(await messages(mira, item.threadId)).toHaveLength(1);
  expect((await board(ben)).map((one) => one.threadId)).toEqual([item.threadId]);
}, hostTimeout(60_000));

it("someone who cannot see a room gets 404 and hears nothing of its items; a viewer may not write there", async () => {
  const miraStream = await listen(mira);
  const benStream = await listen(ben);
  try {
    expect((await team.as(ben, "POST", "/api/board/items", { groupId: payDesk.id, title: "Peek" })).status).toBe(404);
    const hidden = await add(mira, { groupId: payDesk.id, title: "Run November payroll" });
    await until(() => miraStream.frames().some((frame) => frame.threadId === hidden.threadId));
    const control = await add(mira, { groupId: launch.id, title: "Book the venue" });
    await until(() => benStream.frames().some((frame) => frame.threadId === control.threadId));
    expect(benStream.frames().filter((frame) => frame.groupId === payDesk.id || frame.threadId === hidden.threadId)).toEqual([]);
    expect((await board(ben)).map((one) => one.threadId)).not.toContain(hidden.threadId);
    expect((await board(ben, `?groupId=${payDesk.id}`))).toEqual([]);
    expect((await patch(ben, hidden.threadId, { move: "cancel" })).status).toBe(404);
    expect((await team.as(ben, "DELETE", `/api/board/items/${hidden.threadId}`)).status).toBe(404);
    expect((await team.as(ben, "POST", "/api/board/items", { groupId: payDesk.id, title: "Mine now", threadId: hidden.threadId })).status).toBe(404);
    expect((await board(cara, `?groupId=${payDesk.id}`)).map((one) => one.threadId)).toEqual([hidden.threadId]);
    const viewer = await team.as(cara, "POST", "/api/board/items", { groupId: payDesk.id, title: "Cara's" });
    expect(viewer.status, JSON.stringify(viewer.body)).toBe(403);
    expect((await patch(cara, hidden.threadId, { move: "cancel" })).status).toBe(403);
    expect((await board(olive)).map((one) => one.threadId)).toContain(hidden.threadId);
  } finally {
    await miraStream.close();
    await benStream.close();
  }
}, hostTimeout(60_000));

it("an item that needs another waits, and is ready once that one is done", async () => {
  const research = await add(mira, { groupId: launch.id, title: "Research venues" });
  const pick = await add(ben, { groupId: launch.id, title: "Pick a venue", needs: [research.threadId] });
  expect(pick.state).toBe("waiting");
  const loop = await patch(mira, research.threadId, { needs: [pick.threadId] });
  expect(loop.status).toBe(409);
  expect(loop.body.code).toBe("board_cycle");
  const done = await patch(mira, research.threadId, { move: "done", result: "Three venues shortlisted." });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.item).toMatchObject({ state: "done", result: "Three venues shortlisted." });
  expect((await board(ben)).find((one) => one.threadId === pick.threadId)?.state).toBe("ready");
}, hostTimeout(60_000));

it("cancel, reopen, a refused move, and an existing thread made an item", async () => {
  const item = await add(ben, { groupId: launch.id, title: "Order banners" });
  const cancelled = await patch(ben, item.threadId, { move: "cancel", result: "Not this time." });
  expect(cancelled.body.item).toMatchObject({ state: "cancelled", result: "Not this time." });
  expect((await patch(ben, item.threadId, { move: "release" })).body.code).toBe("board_bad_move");
  const reopened = await patch(mira, item.threadId, { move: "reopen", title: "Order two banners" });
  expect(reopened.body.item).toMatchObject({ state: "ready", attempts: 0, title: "Order two banners" });
  expect(reopened.body.item.result).toBeUndefined();
  expect((await patch(mira, item.threadId, { move: "launch" })).status).toBe(400);
  const again = await team.as(mira, "POST", "/api/board/items", { groupId: launch.id, title: "Twice", threadId: item.threadId });
  expect([again.status, again.body.code]).toEqual([409, "board_exists"]);
  const madeOf = await add(mira, { groupId: launch.id, title: "The room's own thread", threadId: launch.threadId });
  expect(madeOf.threadId).toBe(launch.threadId);
  expect((await team.as(mira, "POST", "/api/board/items", { groupId: payDesk.id, title: "Wrong room", threadId: item.threadId })).status).toBe(404);
}, hostTimeout(60_000));

it("DELETE removes the item and leaves its thread", async () => {
  const item = await add(mira, { groupId: launch.id, title: "Throwaway", text: "Keep this line." });
  const removed = await team.as(mira, "DELETE", `/api/board/items/${item.threadId}`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect((await board(mira)).map((one) => one.threadId)).not.toContain(item.threadId);
  expect((await messages(mira, item.threadId)).map((line) => line.text)).toEqual(["Keep this line."]);
  expect((await team.as(mira, "DELETE", `/api/board/items/${item.threadId}`)).status).toBe(404);
}, hostTimeout(60_000));

it("keeps the board across a restart and starts nothing on it", async () => {
  const before = await board(olive);
  await team.relaunch();
  expect(await board(olive)).toEqual(before);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(await idle()).toBe(true);
  const first = before.find((one) => one.title === "Draft the launch post")!;
  expect(await messages(olive, first.threadId)).toHaveLength(1);
}, hostTimeout(120_000));

it("a personal Cloud has no board", async () => {
  expect((await fx.onCloud("GET", "/api/board")).status).toBe(404);
  expect((await fx.onCloud("POST", "/api/board/items", { groupId: "x", title: "x" })).status).toBe(404);
}, hostTimeout(60_000));
