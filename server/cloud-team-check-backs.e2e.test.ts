// A check-back on a Team Cloud: Ben asks Scout in his private chat, Scout sets a check-back, and at its time Scout's
// turn runs in that same private chat for Ben's request, with nobody pressing anything. Cleo, the owner, can't read the
// chat or its line.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const CLEO = { email: "cleo@acme.test", role: "owner" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const BEN_KEY = personKey({ id: "", email: BEN.email });
const ENGINE = `const { existsSync } = process.getBuiltinModule("node:fs");
const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_DUMP = dir + "/dump.json";
process.env.FAKE_CLAUDE_REPLY_FILE = dir + "/reply.txt";
if (existsSync(dir + "/hang-mode")) { process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = dir + "/release"; }`;
const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;

type Row = { id: string; role: string; kind: string; text?: string; checkBack?: { id: string; status: string; note: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let cleo = "", ben = "";

const file = (name: string) => join(team.home, name);
const dump = () => { try { return JSON.parse(readFileSync(file("dump.json"), "utf8")); } catch { return null; } };
const prompt = (): string => JSON.stringify(dump()?.prompt ?? "");

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting\n${fx.logs().slice(-4_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-cb", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  writeFileSync(file("reply.txt"), "Noted.");
  cleo = (await team.pair(CLEO)).token!;
  ben = (await team.pair(BEN)).token!;
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it("runs Ben's private check-back in his chat, for his request, with no human action, and keeps it from Cleo", async () => {
  const made = await team.as(cleo, "POST", "/api/bots", { visibility: "everyone", name: "Scout" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const scout = made.body.bot as { id: string };
  const opened = await team.as(ben, "POST", `/api/bots/${scout.id}/tasks`, { title: "Payroll" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const benThread = opened.body.task.threadId as string;

  writeFileSync(file("hang-mode"), "");
  rmSync(file("release"), { force: true });
  rmSync(file("dump.json"), { force: true });
  const sent = await team.as(ben, "POST", `/api/bots/${scout.id}/messages`, { text: "Send the payroll export, then check at 4 it reached the bank", threadId: benThread });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  let token = "";
  await until(() => { token = dump()?.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN ?? ""; return Boolean(token) && prompt().includes("payroll export"); }, 30_000);
  const set = await fetch(`${team.base}/api/internal/check-backs`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ when: "in 1 minute", note: "see the payroll export reached the bank" }) });
  expect(set.status, await set.clone().text()).toBe(201);

  const stored = JSON.parse(readFileSync(join(team.home, ".openmausbot", "check-backs.json"), "utf8")).checkBacks;
  expect(stored).toMatchObject([{ botId: scout.id, threadId: benThread, origin: { kind: "user", person: BEN_KEY } }]);

  rmSync(file("hang-mode"), { force: true });
  writeFileSync(file("release"), "");
  const lines = async (token: string) => {
    const answer = await team.as(token, "GET", `/api/threads/${benThread}/messages?limit=200`);
    return { status: answer.status, rows: ((answer.body.messages ?? []) as Row[]).filter((row) => row.checkBack) };
  };
  expect((await lines(ben)).rows.map((row) => row.checkBack!.status)).toEqual(["pending"]);
  const cleoSees = await lines(cleo);
  expect(cleoSees.status === 200 ? cleoSees.rows : []).toEqual([]);

  await until(async () => !((await team.as(ben, "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; busy?: boolean }>).find((bot) => bot.id === scout.id)?.busy, 30_000);
  rmSync(file("release"), { force: true });
  writeFileSync(file("hang-mode"), "");

  await until(() => prompt().includes("What to check: see the payroll export reached the bank"), 100_000);
  await until(async () => (await lines(ben)).rows.some((row) => row.checkBack!.status === "started"), 30_000);
  const woken = dump()?.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN as string;
  const next = await fetch(`${team.base}/api/internal/check-backs`, { method: "POST", headers: { authorization: `Bearer ${woken}`, "content-type": "application/json" },
    body: JSON.stringify({ when: "in 3 hours", note: "look once more" }) });
  expect(next.status, `the woken turn runs as Ben's request: ${await next.clone().text()}`).toBe(201);
  expect(JSON.parse(readFileSync(join(team.home, ".openmausbot", "check-backs.json"), "utf8")).checkBacks)
    .toMatchObject([{ threadId: benThread, note: "look once more", origin: { kind: "user", person: BEN_KEY } }]);
  const rows = (await team.as(ben, "GET", `/api/threads/${benThread}/messages?limit=200`)).body.messages as Row[];
  expect(rows.filter((row) => row.role === "user" && String(row.text ?? "").includes("[Check back:"))).toEqual([]);
  rmSync(file("hang-mode"), { force: true });
  writeFileSync(file("release"), "");
  const later = await lines(cleo);
  expect(later.status === 200 ? later.rows : []).toEqual([]);
  const cleoTasks = ((await team.as(cleo, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks?: Array<{ threadId: string }> }>)
    .find((bot) => bot.id === scout.id)?.tasks ?? [];
  expect(cleoTasks.some((task) => task.threadId === benThread)).toBe(false);
}, hostTimeout(240_000));
