// Who is here on a Team Cloud (docs/team-cloud.md "Who is here"). A real Team Cloud with the Owner, an Admin and Bob, a
// member, each with the event stream open: everyone learns who is here and who went, the people in a shared chat or a
// group chat see each other there, and Bob's private chat is never named to anyone, the Owner
// and the Admin included: not on a stream, not in the people list, not as a count. A bot only the Owner may use keeps
// Bob out of its shared chat's list as well.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const DEE = { email: "dee@acme.test", role: "member" as const };
const GRACE_MS = 400;

type Frame = { kind: string; email?: string; here?: boolean; threadId?: string; people?: string[] };
type Person = { email: string; here?: boolean };

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", bob = "";
let scout: { id: string; mainThreadId: string }, payroll: { id: string; mainThreadId: string };
let bobThread = "", roomThread = "";
const streams: Record<string, Awaited<ReturnType<typeof listen>>> = {};

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
/** An open event stream as one person: every frame it was sent, the ones without an id included. */
async function listen(token: string) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await until(() => text.includes("\"hello\""), 10_000);
  const frames = () => [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]!) as Frame);
  return { text: () => text, frames, mark: () => text.length, since: (mark: number) => text.slice(mark), close: async () => { controller.abort(); await done; } };
}
const here = (token: string, threadId: string | null) => team.as(token, "POST", "/api/presence/here", { tab: "w1", threadId });
const peopleOf = async (token: string) => (await team.as(token, "GET", "/api/team/people")).body.people as Person[];
const lastList = (who: string, threadId: string) => streams[who]!.frames().filter((frame) => frame.kind === "thread.presence" && frame.threadId === threadId).at(-1)?.people;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", env: { OMB_TEAM_PRESENCE_GRACE_MS: String(GRACE_MS) } } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  bob = (await team.pair(BOB)).token!;
  const made = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  scout = made.body.bot;
  const other = await team.as(owner, "POST", "/api/bots", { name: "Payroll" });
  expect(other.status, JSON.stringify(other.body)).toBe(201);
  payroll = other.body.bot;
  expect((await team.as(owner, "PUT", `/api/bots/${payroll.id}/access`, { everyone: "none", people: {} })).status).toBe(200);
  const opened = await team.as(bob, "POST", `/api/bots/${scout.id}/tasks`, { title: "Bob's plans" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  bobThread = opened.body.task.threadId;
  const room = await team.as(owner, "POST", "/api/groups", { name: "Launch", memberIds: [scout.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  roomThread = room.body.group.threadId;
  streams.owner = await listen(owner);
  streams.admin = await listen(admin);
  streams.bob = await listen(bob);
}, hostTimeout(120_000));

afterAll(async () => {
  for (const stream of Object.values(streams)) await stream.close();
  await fx?.close();
});

it("everyone signed in sees who is here", async () => {
  await until(async () => (await peopleOf(owner)).every((person) => person.here === true));
  const seen = await peopleOf(bob);
  expect(seen.map((person) => [person.email, person.here])).toEqual(expect.arrayContaining([[OWNER.email, true], [ADMIN.email, true], [BOB.email, true]]));
  await until(() => streams.owner!.frames().some((frame) => frame.kind === "team.presence" && frame.email === BOB.email && frame.here === true));
}, hostTimeout(60_000));

it("the people in a shared chat see each other there; Bob's private chat is named to nobody", async () => {
  expect((await here(owner, scout.mainThreadId)).status).toBe(200);
  expect((await here(admin, scout.mainThreadId)).status).toBe(200);
  const bobPrivate = await here(bob, bobThread);
  expect(bobPrivate.status).toBe(200);
  expect(bobPrivate.body).toEqual({ ok: true });
  await until(() => lastList("owner", scout.mainThreadId)?.length === 2);
  expect(lastList("owner", scout.mainThreadId)).toEqual([ADMIN.email, OWNER.email]);
  expect(lastList("admin", scout.mainThreadId)).toEqual([ADMIN.email, OWNER.email]);

  // Bob joins the shared chat, and everyone in it sees all three.
  await here(bob, scout.mainThreadId);
  await until(() => lastList("owner", scout.mainThreadId)?.length === 3 && lastList("bob", scout.mainThreadId)?.length === 3);
  expect(lastList("admin", scout.mainThreadId)).toEqual([ADMIN.email, BOB.email, OWNER.email]);

  // Back to his private chat: the shared chat just loses him.
  const mark = { owner: streams.owner!.mark(), admin: streams.admin!.mark() };
  await here(bob, bobThread);
  await until(() => lastList("owner", scout.mainThreadId)?.length === 2);
  expect(lastList("owner", scout.mainThreadId)).toEqual([ADMIN.email, OWNER.email]);
  for (const who of ["owner", "admin"] as const) {
    const after = streams[who]!.since(mark[who]);
    expect(after, who).not.toContain(bobThread);
    for (const frame of streams[who]!.frames().filter((one) => one.kind === "thread.presence")) expect(frame.threadId, who).not.toBe(bobThread);
  }
  for (const who of ["owner", "admin"] as const) expect(streams[who]!.text(), who).not.toContain(bobThread);
  // Not even to Bob: a private chat is no conversation here, only "here".
  expect(streams.bob!.frames().filter((frame) => frame.threadId === bobThread)).toEqual([]);
  const listed = JSON.stringify(await team.as(admin, "GET", "/api/team/people"));
  expect(listed).not.toContain(bobThread);
  expect(listed).not.toContain(scout.id);
  expect(Object.keys((await peopleOf(admin)).find((person) => person.email === BOB.email)!).sort()).toEqual(["email", "here", "name", "role"]);
}, hostTimeout(60_000));

it("a group chat's list reaches the people in it, and a bot Bob may not use keeps him out of its chat", async () => {
  await here(owner, roomThread);
  await here(bob, roomThread);
  await until(() => lastList("bob", roomThread)?.length === 2);
  expect(lastList("owner", roomThread)).toEqual([BOB.email, OWNER.email]);

  await here(owner, payroll.mainThreadId);
  const refused = await here(bob, payroll.mainThreadId);
  expect(refused.status).toBe(404);
  await until(() => lastList("owner", payroll.mainThreadId) !== undefined);
  expect(lastList("owner", payroll.mainThreadId)).toEqual([OWNER.email]);
  expect(streams.bob!.text()).not.toContain(payroll.mainThreadId);
}, hostTimeout(60_000));

it("someone who goes away is gone after the grace", async () => {
  await here(bob, null);
  await streams.bob!.close();
  delete streams.bob;
  await until(() => streams.owner!.frames().some((frame) => frame.kind === "team.presence" && frame.email === BOB.email && frame.here === false));
  const bobNow = (await peopleOf(owner)).find((person) => person.email === BOB.email)!;
  expect(bobNow).toEqual({ email: BOB.email, name: "Bob", role: "member", here: false });
}, hostTimeout(60_000));

it("someone joining the team tells every app to read the people again", async () => {
  const mark = streams.owner!.mark();
  expect((await team.pair(DEE)).token).toBeTruthy();
  await until(() => streams.owner!.since(mark).includes("\"team.people\""));
  expect((await peopleOf(owner)).map((person) => person.email)).toContain(DEE.email);
}, hostTimeout(60_000));
