// "When you are away" end to end on a Team Cloud (docs/team-cloud.md): a stand-in Admin records what the Cloud asks it to
// email. Acme's Owner Cleo and a member Ben, a synthetic Claude CLI; a person with a live stream is here, anyone else is
// away. It proves what leaves the machine (names and hashes, never the words) and when, not how the Admin sends it.
// Disposable homes; nothing leaves this machine.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { TEAM_AWAY_ADMIN_PATH, type AwayRequest } from "./host/team-away.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const CLEO = { email: "cleo@acme.test", role: "owner" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const WINDOW_MS = 10_000;
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_REPLY_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/reply.txt";`;

type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; busy?: boolean; activity?: string };
const asked: { raw: string; body: AwayRequest; signed: boolean }[] = [];
let adminServer: Server, fx: CloudSendFixture, team: CloudTeamFixture;
let cleo = "", ben = "", scout: Bot;
const streams = new Map<string, AbortController>();

const notices = () => asked.flatMap((request) => request.body.notices);
const file = (name: string) => join(team.home, name);
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function turn(token: string, threadId: string, text: string, reply = "Done.") {
  writeFileSync(file("reply.txt"), reply);
  rmSync(file("dump.json"), { force: true });
  const sent = await team.as(token, "POST", `/api/bots/${scout.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(() => existsSync(file("dump.json")));
  await until(async () => (await bots(cleo)).every((bot) => !bot.busy && bot.activity !== "working")
    && ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as { role: string; text?: string }[]).some((row) => row.role === "bot" && row.text === reply));
}
async function here(name: string, token: string) {
  const abort = new AbortController();
  streams.set(name, abort);
  const response = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}` }, signal: abort.signal });
  void response.body!.pipeTo(new WritableStream()).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
}
function away(name: string) { streams.get(name)?.abort(); streams.delete(name); }

beforeAll(async () => {
  adminServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url !== TEAM_AWAY_ADMIN_PATH) { res.writeHead(404); res.end(JSON.stringify({ error: "Not found." })); return; }
      const raw = Buffer.concat(chunks).toString("utf8"), body = JSON.parse(raw) as AwayRequest;
      const headers = req.headers as Record<string, string>;
      asked.push({ raw, body, signed: /^v1=[\w-]{43}$/.test(headers["x-omb-cloud-signature"] ?? "") && headers["x-omb-cloud-machine"] === "0d9e8f7a-6b5c-4d3e-9f8a-7b6c5d4e3f2a" });
      res.writeHead(200);
      res.end(JSON.stringify({ v: 1, results: body.notices.map(({ id }) => ({ id, state: "sent" })) }));
    });
  });
  await new Promise<void>((resolve) => adminServer.listen(0, "127.0.0.1", resolve));
  fx = await launchCloudSendFixture({ onePasswordToken: "ops_fake-away", team: { id: "team-acme-1", name: "Acme", engine: ENGINE, env: {
    OMB_BOT_BOX: "0", FIXTURE_ADMIN_STAND_IN: `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`, OMB_TEAM_AWAY_WINDOW_MS: String(WINDOW_MS),
  } } });
  team = fx.team!;
  cleo = (await team.pair(CLEO)).token!;
  ben = (await team.pair(BEN)).token!;
  await bots(ben);
  const created = await team.as(cleo, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = created.body.bot as Bot;
}, hostTimeout(180_000));

afterAll(async () => {
  for (const abort of streams.values()) abort.abort();
  await fx?.close();
  await new Promise((resolve) => adminServer?.close(resolve));
});

it("Ben is away: Cleo's @Ben in Scout's shared chat asks for one email naming Cleo and Scout, never the words", async () => {
  await here("cleo", cleo);
  await turn(cleo, scout.mainThreadId ?? scout.threadId, "@Ben can you check the Globex numbers before Friday?");
  await until(() => notices().length === 1, 40_000);
  expect(asked.every((request) => request.signed)).toBe(true);
  expect(notices()).toEqual([{ id: expect.stringMatching(/^n_[\w-]{22}$/), to: BEN.email, items: [{ kind: "mention", key: expect.stringMatching(/^[0-9a-f]{64}$/), who: "Cleo", place: "Scout" }] }]);
  expect(asked.map((request) => request.raw).join("")).not.toMatch(/Globex|numbers|Friday/);
  await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2));
  expect(notices().filter((notice) => notice.to === CLEO.email), "Cleo was here when her request finished").toEqual([]);
}, hostTimeout(120_000));

it("Cleo is away: Ben's @Cleo from his own private chat says only that Ben wrote; her shared request finishing is in the same email", async () => {
  away("cleo");
  const own = await team.as(ben, "POST", `/api/bots/${scout.id}/tasks`, { title: "Ben and Scout" });
  expect(own.status, JSON.stringify(own.body)).toBe(201);
  await turn(ben, own.body.task.threadId as string, "@Cleo I am interviewing at Globex on Thursday, keep it quiet", "Noted.");
  await turn(cleo, scout.mainThreadId ?? scout.threadId, "Summarise the week for the board", "Here is the week.");
  await until(() => notices().some((notice) => notice.to === CLEO.email), 40_000);
  const [toCleo, ...more] = notices().filter((notice) => notice.to === CLEO.email);
  expect(more).toEqual([]);
  expect(toCleo).toEqual({ id: expect.stringMatching(/^n_[\w-]{22}$/), to: CLEO.email, items: [
    { kind: "mention", key: expect.stringMatching(/^[0-9a-f]{64}$/), who: "Ben", private: true },
    { kind: "finished", key: expect.stringMatching(/^[0-9a-f]{64}$/), who: "Scout" },
  ] });
  expect(asked.map((request) => request.raw).join("")).not.toMatch(/Globex|interviewing|Ben and Scout|Summarise|board/);
}, hostTimeout(120_000));

it("someone who is here gets nothing, and the switch in their profile reaches the Admin", async () => {
  await here("ben", ben);
  const before = notices().length;
  await turn(cleo, scout.mainThreadId ?? scout.threadId, "@Ben one more thing", "Sure.");
  await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2));
  expect(notices().slice(before).filter((notice) => notice.to === BEN.email)).toEqual([]);

  expect((await team.as(ben, "GET", "/api/me/away-emails")).body).toEqual({ on: true });
  expect((await team.as(ben, "PUT", "/api/me/away-emails", { on: false })).body).toEqual({ on: false });
  await until(() => asked.some((request) => request.body.prefs?.some((pref) => pref.to === BEN.email && !pref.on)), 10_000);
  expect((await team.as(ben, "GET", "/api/me/away-emails")).body).toEqual({ on: false });
}, hostTimeout(120_000));
