// The small team fixes, end to end on a Team Cloud with the synthetic Claude CLI playing scripted plans through the real
// agents tools: a bot that cannot reach a bot shared with other people is told who looks after it; a lent computer is
// refused in the team's one honest line; a personal place takes the person's team as a place its bots can name; a rule
// blocking an MCP server applies to the next thing each bot does; the Owner's export carries nothing of a member's alone; and
// a question left for a day is mentioned in the person's inbox chat, on a fake clock. It proves what the engine was sent and
// what each person sees, not a model's judgement.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { TEAM_POLICY_ADMIN_PATH, teamPolicyFingerprint } from "./cloud-team-policy.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { stagedWorkspaceData, stageWorkspaceBackup } from "./workspace-backup.ts";

const ADA = { email: "ada@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const TEAM_LINE = "Acme's bots never use anyone's own computer; they use Acme's cloud computer.";
const SECRET = "Zebrafinch42";
const SHARED = "Okapi77";
const PASSWORD = "correct horse battery staple";
const clockDir = mkdtempSync(join(tmpdir(), "omb-wait-clock-"));
const CLOCK = join(clockDir, "offset");
writeFileSync(CLOCK, "0");

type Bot = { id: string; name: string; threadId: string };
type Evidence = { step?: { tool?: string; arguments?: Record<string, unknown> }; response?: { result?: { isError?: boolean; content?: Array<{ text: string }> } } };
type Turn = { botId: string; turnIndex: number; threadId?: string; system: string; prompt: unknown; evidence: Evidence[] };

const admin = { answer: { status: 200, body: { policy: null } as unknown }, reports: [] as Array<{ loaded: { fingerprint: string } | null }>, version: 0 };
let adminServer: Server, gateway: FakeHttpMcp, broker: BrokerFake, fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", mira = "";
let support: Bot, sales: Bot;
let mirasChat = "";

const planPath = () => join(team.home, "plan.json");
const turns = (): Turn[] => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn) : [];
const plan = (value: Record<string, unknown>) => writeFileSync(planPath(), JSON.stringify(value));
const create = async (body: Record<string, unknown>) => {
  const created = await team.as(ada, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const settled = async () => {
  const bots = (await team.as(ada, "GET", "/api/bots?messages=0")).body.bots as Array<{ busy?: boolean; waitingForTeammates?: boolean; tasks?: Array<{ busy?: boolean; waitingForTeammates?: boolean }> }>;
  return bots.every((one) => !one.busy && !(one.tasks ?? []).some((task) => task.busy || task.waitingForTeammates));
};
const rows = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ role: string; kind: string; text?: string }>;
/** Mira's line to Support in her private chat, through to Support's scripted reply. */
async function miraAsks(text: string, reply: string): Promise<void> {
  const before = turns().length;
  const sent = await team.as(mira, "POST", `/api/bots/${support.id}/messages`, { text, threadId: mirasChat });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => (await rows(mira, mirasChat)).some((row) => row.role === "bot" && row.text === reply), { timeout: 60_000 }).toBe(true);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);
  await expect.poll(() => turns().length > before, { timeout: 10_000 }).toBe(true);
}
function publish(limits: Record<string, unknown> | null): string | null {
  if (!limits) { admin.answer = { status: 200, body: { policy: null } }; return null; }
  const document = { schema: 1, limits };
  const policy = { version: ++admin.version, fingerprint: teamPolicyFingerprint(document), document };
  admin.answer = { status: 200, body: { policy } };
  return policy.fingerprint;
}
async function rules(limits: Record<string, unknown> | null): Promise<void> {
  const fingerprint = publish(limits);
  const nudge = await team.signed("POST", "/api/cloud/team/policy-changed", {});
  expect(nudge.status, JSON.stringify(nudge.body)).toBe(200);
  await expect.poll(() => admin.reports.at(-1)?.loaded?.fingerprint ?? null, { timeout: 15_000, interval: 50 }).toBe(fingerprint);
}

beforeAll(async () => {
  adminServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      expect(req.url).toBe(TEAM_POLICY_ADMIN_PATH);
      admin.reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(admin.answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(admin.answer.body));
    });
  });
  await new Promise<void>((resolve) => adminServer.listen(0, "127.0.0.1", resolve));
  gateway = await startFakeHttpMcp({ tools: [{ name: "lookup_order", inputSchema: { type: "object", properties: {} } }], callResult: () => ({ content: [{ type: "text", text: "ok" }] }) });
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, broker, team: { id: "team-acme-3", name: "Acme", engine: ENGINE,
    env: { OMB_BOT_BOX: "0", OMB_TEST_WAIT_CLOCK: CLOCK, NODE_OPTIONS: `--import=${new URL("./testing/wait-clock-hooks.mjs", import.meta.url).href}`, FIXTURE_ADMIN_STAND_IN: `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}` } } });
  team = fx.team!;
  ada = (await team.pair(ADA)).token!;
  mira = (await team.pair(MIRA)).token!;
  expect((await team.as(ada, "PUT", "/api/me", { name: "Ada" })).status).toBe(200);
  expect((await team.as(mira, "PUT", "/api/me", { name: "Mira" })).status).toBe(200);
  support = await create({ name: "Support", title: "Support", section: "Support", reportsTo: ADA.email });
  sales = await create({ name: "Sales", title: "Sales", section: "Sales", reportsTo: ADA.email });
  // Sales is shared with nobody but Ada: "Only people added", with no one added.
  const shared = await team.as(ada, "PUT", `/api/bots/${sales.id}/access`, { everyone: "none", people: {} });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  expect((await team.as(ada, "POST", "/api/mcp/servers", { name: "orders", type: "http", url: gateway.url })).status).toBe(201);
  expect((await team.as(ada, "PATCH", "/api/mcp/servers/orders", { enabled: true })).status).toBe(200);
  const opened = await team.as(mira, "POST", `/api/bots/${support.id}/tasks`, { title: "Numbers" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  mirasChat = opened.body.task.threadId;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await gateway?.close();
  await broker?.close();
  await new Promise((resolve) => adminServer?.close(resolve));
  rmSync(clockDir, { recursive: true, force: true });
});

it("a bot shared with other people: Support is told that Ada looks after Sales, and Mira hears it in plain words", async () => {
  await rules(null);
  const reply = "Sales isn't shared here; ask Ada, who looks after it.";
  plan({ [support.id]: { turns: [
    { steps: [
      { expectError: true, arguments: { bot_ids: ["Sales"], message: "Pull the Q3 numbers for Mira.", reason: "Mira needs Sales' data" } },
      { expectError: true, arguments: { bot_ids: [sales.id], message: "Pull the Q3 numbers for Mira.", reason: "Mira needs Sales' data" } },
    ], reply },
    { reply: "Hello again." },
    { reply: "Still here." },
    { writeFiles: { "secret-notes.md": `Mira's ${SECRET}` }, steps: [{ tool: "memory_update", arguments: { action: "prefer", text: `Mira's ${SECRET} preference` } }], reply: `Noted ${SECRET}.` },
  ] } });
  await miraAsks("Get me the Q3 numbers from Sales.", reply);
  const asked = turns().find((turn) => turn.botId === support.id && turn.turnIndex === 0)!;
  const refusals = asked.evidence.filter((entry) => Array.isArray(entry.step?.arguments?.bot_ids)).map((entry) => entry.response!.result!);
  expect(refusals).toHaveLength(2);
  for (const refused of refusals) {
    expect(refused.isError).toBe(true);
    expect(refused.content![0]!.text).toContain("Sales is shared with different people from Support, so nothing was sent.");
    expect(refused.content![0]!.text).toContain("Sales isn't shared here; ask Ada, who looks after it.");
  }
  // Sales did no work, and Mira still cannot see it.
  expect(turns().some((turn) => turn.botId === sales.id)).toBe(false);
  expect(((await team.as(mira, "GET", "/api/bots?messages=0")).body.bots as Bot[]).map((bot) => bot.name)).not.toContain("Sales");
  expect((await rows(mira, mirasChat)).some((row) => row.role === "bot" && row.text === reply)).toBe(true);
}, hostTimeout(120_000));

it("a lent computer: a team's bot hears the team's one line, not a personal Cloud's words", async () => {
  const bearer = await team.capability(support.id, mirasChat);
  const seen = await fetch(`${team.base}/api/internal/shared-computers`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(seen.status).toBe(200);
  const body = (await seen.json()) as { computers: unknown[]; unavailable?: string; say?: string };
  expect(body.computers).toEqual([]);
  expect(body.say).toBe(TEAM_LINE);
  expect(body.unavailable).toBe(TEAM_LINE);

  const environment = await fetch(`${team.base}/.well-known/openmausbot/environment`, { headers: fx.edge });
  const environmentId = ((await environment.json()) as { environmentId: string }).environmentId;
  const lent = await team.as(ada, "POST", "/api/shared-computers/connect",
    { id: randomUUID(), name: "Ada's Mac", environmentId, folders: [], terminal: true, computer: true, platform: "darwin" },
    { "x-omb-computer-secret": createHash("sha256").update("ada-mac").digest("hex") });
  expect(lent.status, JSON.stringify(lent.body)).toBe(200);
  const used = await fetch(`${team.base}/api/internal/shared-computers`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "list_files", computer_id: randomUUID(), path: "/" }) });
  const answer = await used.text();
  expect(used.status, answer).toBe(403);
  expect(answer).toContain(TEAM_LINE);
  expect(answer).not.toMatch(/conversations you start|your Mac/);
}, hostTimeout(60_000));

it("a personal place takes the person's team as a place whose bots it can name; a team's place takes no such word", async () => {
  const told = { v: 1, self: { name: "This computer", kind: "computer" }, places: [{ name: "Acme", kind: "team", bots: ["Sales", "Support"] }] };
  const put = await fx.local("PUT", "/api/places/elsewhere", told);
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  expect((await fx.local("GET", "/api/places/elsewhere")).body).toMatchObject(told);
  expect((await team.as(ada, "PUT", "/api/places/elsewhere", told)).status).toBe(403);
}, hostTimeout(60_000));

it("a rule blocking an MCP server applies to the next thing each bot does, with no restart", async () => {
  const before = turns().filter((turn) => turn.botId === support.id).length;
  await miraAsks("Anything new?", "Hello again.");
  const withServer = turns().filter((turn) => turn.botId === support.id)[before]!;
  expect(withServer.system).toContain('"orders"');
  await rules({ allowedMcpServers: ["approved"] });
  await miraAsks("And now?", "Still here.");
  const without = turns().filter((turn) => turn.botId === support.id)[before + 1]!;
  expect(without.system).not.toContain('"orders"');
  expect(((await team.as(mira, "GET", "/api/config")).body.managedPolicy as { organizationName: string }).organizationName).toBe("Acme");
  await rules(null);
}, hostTimeout(120_000));

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

it("the Owner's export carries the team's chats and nothing of a member's alone, in any file", async () => {
  await miraAsks(`Keep this between us: ${SECRET}.`, `Noted ${SECRET}.`);
  plan({ [support.id]: { turns: [...Array.from({ length: turns().filter((turn) => turn.botId === support.id).length }, () => ({ reply: "x" })), { reply: `Shared ${SHARED}.` }] } });
  const main = await team.as(ada, "POST", `/api/bots/${support.id}/messages`, { text: `Team note: ${SHARED}.`, threadId: support.threadId });
  expect(main.status, JSON.stringify(main.body)).toBe(202);
  await expect.poll(async () => (await rows(ada, support.threadId)).some((row) => row.text === `Shared ${SHARED}.`), { timeout: 60_000 }).toBe(true);
  await expect.poll(settled, { timeout: 20_000 }).toBe(true);

  const made = await team.as(ada, "POST", "/api/workspace-backup/export", { password: PASSWORD });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const download = await fetch(`${team.base}/api/workspace-backup/download/${made.body.id}`, { headers: { ...fx.edge, authorization: `Bearer ${ada}` } });
  expect(download.status).toBe(200);
  const unpack = mkdtempSync(join(tmpdir(), "omb-team-export-"));
  try {
    const archive = join(unpack, "export.ombbackup");
    writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
    const staged = await stageWorkspaceBackup(unpack, archive, { password: PASSWORD, currentAppVersion: made.body.summary.appVersion });
    const { data } = stagedWorkspaceData(unpack, staged.id);
    const said = (word: string) => filesUnder(data).filter((path) => readFileSync(path).toString("latin1").toLowerCase().includes(word.toLowerCase())).map((path) => path.slice(data.length + 1));
    expect(said(SECRET)).toEqual([]);
    expect(said(SHARED)).toContain("messages.db");
    expect(made.body.summary.warnings.join(" ")).toContain("are not in this export");
  } finally {
    rmSync(unpack, { recursive: true, force: true });
  }
  expect(JSON.stringify(await rows(mira, mirasChat))).toContain(SECRET);
}, hostTimeout(180_000));

it("a question left for a day is said in the person's own inbox chat, once the clock says so, and only there", async () => {
  const reporter = await create({ name: "Reporter", title: "Reports", section: "Support", reportsTo: MIRA.email });
  expect((await team.as(ada, "PATCH", `/api/bots/${reporter.id}`, { approvalMode: "ask" })).status).toBe(200);
  const bots = async () => (await team.as(mira, "GET", "/api/bots")).body.bots as Array<Bot & { defaultBot?: unknown; tasks?: Array<{ threadId: string; inbox?: true; openAsks?: number }> }>;
  // A User's own MausBot: no crown and no Chief's powers, and it cannot reach a bot shared with everyone.
  const own = (await bots()).find((bot) => bot.defaultBot) as Bot & { chiefOfStaff?: boolean };
  expect(MIRA.role).toBe("member");
  expect(own.chiefOfStaff).toBeFalsy();
  const saidLine = "Reporter still waits on your answer about the build, since yesterday.";
  plan({
    [reporter.id]: { turns: [{ approve: { tool_name: "Bash", input: { command: "rm -rf build" } }, reply: "Cleaned." }] },
    [own.id]: { turns: [{ reply: "Morning." }, { reply: saidLine }] },
  });
  const asked = await team.as(ada, "POST", `/api/bots/${reporter.id}/messages`, { text: "Clean the build", threadId: reporter.threadId });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await expect.poll(async () => (await bots()).find((bot) => bot.id === own.id)?.tasks?.find((task) => task.inbox)?.openAsks, { timeout: 60_000 }).toBe(1);
  const inbox = (await bots()).find((bot) => bot.id === own.id)!.tasks!.find((task) => task.inbox)!.threadId;
  const inboxTurns = () => turns().filter((turn) => turn.botId === own.id);
  const say = async (text: string, reply: string) => {
    expect((await team.as(mira, "POST", `/api/bots/${own.id}/messages`, { text, threadId: inbox })).status).toBe(202);
    await expect.poll(async () => (await rows(mira, inbox)).some((row) => row.role === "bot" && row.text === reply), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => inboxTurns().some((turn) => JSON.stringify(turn.prompt).includes(text)), { timeout: 10_000 }).toBe(true);
    return inboxTurns().find((turn) => JSON.stringify(turn.prompt).includes(text))!;
  };

  const fresh = await say("Good morning", "Morning.");
  expect(`${fresh.system}\n${JSON.stringify(fresh.prompt)}`).not.toContain("have waited on the person for more than a day");

  writeFileSync(CLOCK, String(25 * 60 * 60_000));
  const aged = await say("Anything for me?", saidLine);
  const told = `${aged.system}\n${JSON.stringify(aged.prompt)}`;
  expect(told).toContain("These have waited on the person for more than a day");
  expect(told).toContain("Reporter");
  expect(told).toContain("since yesterday");
  expect(told).toContain("not a card or a new question");
  // Its own source: the Chief's list is empty for this bot, and the line only says what waits and where.
  expect(told).not.toContain("Teammates you manage wait on the person's answer");
  const line = told.slice(told.indexOf("These have waited on the person"), told.indexOf("you cannot answer it for them"));
  expect(line).toContain("Each has its own line in this inbox");
  expect(line).not.toContain("coordinate_bots");

  // A line in Mira's chat, not a new card: still the one ask, and Ada cannot open her inbox.
  expect((await bots()).find((bot) => bot.id === own.id)!.tasks!.find((task) => task.inbox)!.openAsks).toBe(1);
  expect((await team.as(ada, "GET", `/api/threads/${inbox}/messages?limit=200`)).status).toBe(404);
}, hostTimeout(180_000));
