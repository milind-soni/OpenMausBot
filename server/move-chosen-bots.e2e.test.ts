// Moving some of this computer's bots to My Cloud, end to end: this computer's server and a Cloud home with main's own wiring
// between them, as the page's channels start it. The chosen bot goes with its chats and routine; the other stays and
// keeps answering here, nothing freezes, and more can move later. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture;
beforeAll(async () => { fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-chosen-${randomBytes(8).toString("hex")}`, env: { OMB_ENVIRONMENT_LABEL: "MacBook Air" } }); }, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

type Side = CloudSendFixture["local"];
type Bot = { id: string; name: string; threadId: string; hidden?: boolean; movedTo?: { state: string; team: { id: string } } };
const newBot = async (name: string) => (await fx.local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as Bot;
const listed = async (side: Side) => (await side("GET", "/api/bots")).body.bots as Bot[];
const rows = async (side: Side, threadId: string) => ((await side("GET", `/api/threads/${threadId}/messages?limit=500`)).body.messages as Array<{ id: string }>).map((row) => row.id);
const idle = async () => (await listed(fx.local)).every((entry) => !(entry as Bot & { busy?: boolean }).busy);
async function turn(bot: Bot, text: string) {
  const before = (await rows(fx.local, bot.threadId)).length;
  expect((await fx.local("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => await idle() && (await rows(fx.local, bot.threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const moves = () => { const file = join(dirname(fx.journalFile), "bot-moves.json"); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { moves: Array<{ phase: string; error?: string; bots: Bot[] }> } : { moves: [] }; };
const settled = () => expect.poll(() => moves().moves.every((move) => move.phase === "done"), { timeout: 120_000, interval: 250, message: JSON.stringify(moves()) }).toBe(true);

it("the chosen bot goes with its chats and routine; the other keeps answering here, nothing freezes, and more can go later", async () => {
  const go = await newBot("Goer"), stay = await newBot("Stayer"), later = await newBot("Later");
  await turn(go, "Hello there."); await turn(stay, "Hi."); await turn(later, "Hey.");
  expect((await fx.local("PUT", `/api/bots/${go.id}/memory/file`, { path: "MEMORY.md", text: "Likes short answers.\n" })).status).toBe(200);
  const made = (await fx.local("POST", "/api/routines", { name: "Daily", prompt: "Report.", botId: go.id, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 })).body;
  const daily = (made.routine ?? made).id as string;
  const room = (await fx.local("POST", "/api/groups", { name: "Launch", memberIds: [go.id, stay.id] })).body;
  const roomId = (room.group ?? room).id as string;
  fx.account.state = { ...fx.account.state, machine: { status: "ready", origin: fx.cloudBase, moves: true } };

  expect(await fx.call("cloud-send:bot-move-state", "local")).toEqual({ available: true, moving: [] });
  expect(() => fx.call("cloud-send:bot-move-state", "cloud")).toThrow(/only available on this computer's page/u);
  await fx.call("cloud-send:move-bots", "local", [go.id]);
  await settled();
  expect(moves().moves[0]!.bots.map((bot) => bot.id)).toEqual([go.id]);

  const there = await listed(fx.onCloud);
  expect(there.map((bot) => bot.id)).toContain(go.id);
  expect(there.map((bot) => bot.id), "the bot that stays is not on My Cloud").not.toContain(stay.id);
  expect(await rows(fx.onCloud, go.threadId)).toEqual(await rows(fx.local, go.threadId));
  expect((await fx.onCloud("GET", `/api/bots/${go.id}/memory/file?path=MEMORY.md`)).body.text, "its memory went with it").toContain("Likes short answers.");
  const routinesThere = (await fx.onCloud("GET", "/api/routines")).body.routines as Array<{ id: string; enabled: boolean }>;
  expect(routinesThere.find((routine) => routine.id === daily)?.enabled, "what was on here is on there").toBe(true);

  expect((await fx.local("GET", "/api/move/freeze")).body.frozen, "this computer never froze").toBe(false);
  expect(existsSync(fx.journalFile) ? JSON.parse(readFileSync(fx.journalFile, "utf8")) : null, "no one-time move ran").toBeNull();
  await turn(stay, "Still here?");
  const answer = await fx.local("POST", `/api/bots/${go.id}/messages`, { text: "Are you there?", threadId: go.threadId });
  expect(answer.status, JSON.stringify(answer.body)).toBe(409);
  const here = (await listed(fx.local)).find((bot) => bot.id === go.id)!;
  expect(here).toMatchObject({ hidden: true, movedTo: { state: "moved", team: { id: "my-cloud" } } });
  const routinesHere = (await fx.local("GET", "/api/routines")).body.routines as Array<{ id: string; enabled: boolean }>;
  expect(routinesHere.find((routine) => routine.id === daily)?.enabled, "it no longer runs here").toBe(false);
  const roomHere = ((await fx.local("GET", "/api/bots")).body.groups as Array<{ id: string; memberIds: string[] }>).find((group) => group.id === roomId);
  expect(roomHere?.memberIds, "the room goes on here without it").toEqual([stay.id]);
  expect(((await fx.onCloud("GET", "/api/bots")).body.groups as Array<{ id: string }>).map((group) => group.id), "a room with a bot left behind stays").not.toContain(roomId);
  expect((await fx.call<{ on: boolean }>("one-home:keep", "local")).on, "this computer stays home").toBe(true);

  await fx.call("cloud-send:move-bots", "local", [later.id]);
  await settled();
  expect((await listed(fx.onCloud)).map((bot) => bot.id)).toContain(later.id);
  await expect(fx.call("cloud-send:move-bots", "local", [go.id]), "one that moved can't be chosen again").rejects.toThrow();
  expect((await listed(fx.local)).find((bot) => bot.id === stay.id)?.movedTo).toBeUndefined();
}, hostTimeout(300_000));

it("Move everything later carries the rest, without touching the bots that already live on My Cloud", async () => {
  const before = (await listed(fx.local)).filter((bot) => bot.movedTo?.state === "moved").map((bot) => bot.id);
  expect(before.length).toBeGreaterThan(0);
  await fx.call("cloud-send:move-everything", "local");
  const journal = () => (existsSync(fx.journalFile) ? JSON.parse(readFileSync(fx.journalFile, "utf8")) as { phase?: string } | null : null);
  await expect.poll(async () => { await fx.oneHome.kick(); return journal()?.phase; }, { timeout: 200_000, interval: 500 }).toBe("done");
  const there = await listed(fx.onCloud);
  for (const id of before) expect(there.find((bot) => bot.id === id)?.hidden, "it stays a working bot there, not an archived one").toBeFalsy();
  expect((await fx.local("GET", "/api/move/freeze")).body.frozen, "now everything has gone").toBe(true);
}, hostTimeout(300_000));
