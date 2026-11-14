// What a Team Cloud refuses at the door: a request whose body never finishes arriving (ended with a 408 within the
// deadline, while an event stream, which has no body, stays open past it), names that do not fit on one line, message
// text that is not a string, and a member's webhook requests; and its refusals are plain sentences.
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";

import { CLOUD_HOST, launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { BODY_DEADLINE_MS } from "./body-deadline.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", ada = "";
let bot: { id: string; mainThreadId: string; color: string };

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", env: { OMB_WEBHOOK_PUBLIC_URL: `https://${CLOUD_HOST}` } } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  ada = (await team.pair(ADA)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it("refuses a room name with a null byte or a line break, as a bot's name is refused", async () => {
  for (const name of ["weird-grp-\u0000x", "weird-grp-a\nb"]) {
    const created = await team.as(owner, "POST", "/api/groups", { name, memberIds: [bot.id] });
    expect(created, JSON.stringify(name)).toMatchObject({ status: 400, body: { error: "room name must fit on one line" } });
  }
  const room = await team.as(owner, "POST", "/api/groups", { name: "Kitchen", memberIds: [bot.id] });
  expect(room.status).toBe(201);
  expect(await team.as(owner, "PATCH", `/api/groups/${room.body.group.id}`, { name: "a\nb" })).toMatchObject({ status: 400, body: { error: "room name must fit on one line" } });
}, hostTimeout(60_000));

it("takes message text only as a string without a null byte", async () => {
  const send = (text: unknown) => team.as(owner, "POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.mainThreadId });
  expect(await send(123)).toMatchObject({ status: 400, body: { error: "text must be a string" } });
  expect(await send("a\u0000b")).toMatchObject({ status: 400, body: { error: "text must not contain a null byte" } });
  const room = await team.as(owner, "POST", "/api/groups", { name: "Den", memberIds: [bot.id] });
  expect(await team.as(owner, "POST", `/api/groups/${room.body.group.id}/messages`, { text: 123 })).toMatchObject({ status: 400, body: { error: "text must be a string" } });
}, hostTimeout(60_000));

it("answers a bad new bot with a plain sentence", async () => {
  const created = await team.as(owner, "POST", "/api/bots", { name: "x".repeat(101) });
  expect(created).toMatchObject({ status: 400, body: { error: "name must be at most 100 characters" } });
  expect(await team.as(owner, "POST", "/api/bots", { description: "x".repeat(4001) })).toMatchObject({ status: 400, body: { error: "description must be at most 4000 characters" } });
}, hostTimeout(60_000));

it("records a team bot's rename, colour and instructions in the admin activity", async () => {
  // A new bot's colour is picked at random: change it to one it doesn't have.
  const color = bot.color === "blue" ? "green" : "blue";
  expect((await team.as(owner, "PATCH", `/api/bots/${bot.id}`, { name: "Scout 2", color })).status).toBe(200);
  expect((await team.as(owner, "PATCH", `/api/bots/${bot.id}/profile`, { soul: "Be brief." })).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const entries = (await team.as(owner, "GET", "/api/admin-activity?what=bot")).body.entries as Array<{ action?: string; changed?: string[] }>;
  const changed = entries.filter((entry) => entry.action === "bot.update").flatMap((entry) => entry.changed ?? []);
  expect(changed).toEqual(expect.arrayContaining(["name", "color", "soul"]));
}, hostTimeout(60_000));

it("lets a member read the webhook list, which carries no credential, and keeps creating one an admin's", async () => {
  const list = await team.as(ada, "GET", "/api/webhooks");
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).not.toMatch(/omb_wh_|secret/i);
  // As cloud-home-start runs it, the address it shows is the Cloud's public one, never the loopback listener.
  expect(list.body.ingress.baseUrl).toBe(`https://${CLOUD_HOST}`);
  expect(JSON.stringify(list.body)).not.toContain("127.0.0.1");
  expect((await team.as(ada, "POST", "/api/webhooks", { name: "Mine" })).status).toBe(403);
}, hostTimeout(60_000));

it("ends a sign-in request whose body stops arriving with a 408, and leaves an event stream open", async () => {
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${owner}`, accept: "text/event-stream" } });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  let streamEnded = false;
  void (async () => { for (;;) if ((await reader.read()).done) { streamEnded = true; return; } })().catch(() => { streamEnded = true; });

  const { port, hostname } = new URL(team.base);
  const started = Date.now();
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`POST /api/auth/pair HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{"co`);
    });
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString("utf8"); });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
  expect(answer).toMatch(/^HTTP\/1\.1 408/);
  expect(Date.now() - started).toBeLessThan(BODY_DEADLINE_MS + 15_000);
  expect(streamEnded).toBe(false);
  await reader.cancel();
}, hostTimeout(BODY_DEADLINE_MS + 60_000));
