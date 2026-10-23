import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { createControlClient } from "./control-client.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { ownTurnText } from "./testing/room-handoff-agent.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RERUN_NOTE = "OpenMausBot restarted while your previous turn here was running";
const RERUN_CHIP = "Resuming after a restart";
const SECRET_PROVIDED = "OpenMausBot credential update: the user securely provided";
const CONNECTED = "OpenMausBot connection update: the user securely connected";
const STEP_CAP_CONTINUES = "stopped at the step limit";
const SEAT_FREE = "the computer this conversation waited for is free again";
const SIGNED_IN = "OpenMausBot sign-in update: the person finished signing in to";
const INTERRUPTED_OUTWARD = "Interrupted by an OpenMausBot restart after it already";
const SETTLED = "Your downstream room requests have settled.";
const REPORT_FROM_MIRA = "[OpenMausBot report from @Mira";

const jsonl = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

type Row = Record<string, any>;
interface RuntimeDb {
  assignments: Row[];
  events: Array<{ assignmentId: string; kind: string; detail?: string }>;
}

function readRuntimeDb(dataDir: string): RuntimeDb {
  const path = join(dataDir, "runtime.db");
  if (!existsSync(path)) return { assignments: [], events: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const assignments = (db.prepare("SELECT json FROM assignments ORDER BY created_at, id").all() as Array<{ json: string }>)
      .map((row) => JSON.parse(row.json) as Row);
    const events = (db.prepare("SELECT assignment_id, kind, detail FROM assignment_events ORDER BY id").all() as Array<{ assignment_id: string; kind: string; detail: string | null }>)
      .map((row) => ({ assignmentId: row.assignment_id, kind: row.kind, ...(row.detail == null ? {} : { detail: row.detail }) }));
    return { assignments, events };
  } finally {
    db.close();
  }
}

const chipText = (message: any): string => [message.tool?.name, message.tool?.output, message.text].filter(Boolean).join("\n");

type ModelAnswer = { say: string } | { call: true };
type ModelRequest = { lastUser: string; toolsSinceUser: number };

async function loopbackModel() {
  const requests: ModelRequest[] = [];
  let answer: (request: ModelRequest) => ModelAnswer = () => ({ say: "OK" });
  let callSerial = 0;
  const model = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "loop-model" }] })); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const sent = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> };
    const text = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map((part: any) => part?.text ?? "").join("\n") : "";
    const lastUserAt = sent.messages.map((message) => message.role).lastIndexOf("user");
    const request = { lastUser: lastUserAt < 0 ? "" : text(sent.messages[lastUserAt]!), toolsSinceUser: sent.messages.slice(lastUserAt + 1).filter((message) => message.role === "tool").length };
    requests.push(request);
    const tool = sent.tools?.find((candidate) => candidate.function.name.endsWith("list_bots"))?.function.name ?? "missing_tool";
    const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const reply = (out: ServerResponse, given: ModelAnswer) => {
      out.writeHead(200, { "content-type": "text/event-stream" });
      out.end("say" in given ? frame({ content: given.say }, "stop") + "data: [DONE]\n\n"
        : frame({ tool_calls: [{ index: 0, id: `call_${++callSerial}`, type: "function", function: { name: tool, arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n");
    };
    reply(res, answer(request));
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    requests,
    answer: (next: typeof answer) => { answer = next; },
    close: async () => { model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve())); },
  };
}

async function composioStub() {
  const connected = new Set<string>();
  const stub = createServer(async (req, res) => {
    const url = req.url ?? "";
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.startsWith("/api/v3.1/connected_accounts") || url.startsWith("/api/v3/toolkits")) return reply(200, { items: [] });
    if (url.startsWith("/api/v3.1/tool_router/session")) {
      if (req.headers["x-api-key"] !== "ak_good") return reply(401, { error: { message: "invalid project key" } });
      if (url.includes("/toolkits")) return reply(200, { items: [...connected].map((slug) => ({ slug, connected_account: { id: `ca_${slug}`, status: "ACTIVE" } })) });
      const body = raw ? JSON.parse(raw) : {};
      return reply(201, { session_id: "trs_roots_test", mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_roots_test/mcp" }, config: { user_id: body.user_id } });
    }
    return reply(404, { error: "unknown" });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  return {
    env: { OMB_COMPOSIO_API: `${origin}/api/v3.1`, OMB_COMPOSIO_TOOLKITS_API: `${origin}/api/v3` },
    connect: (slug: string) => connected.add(slug),
    close: async () => { stub.closeAllConnections(); await new Promise<void>((resolve) => stub.close(() => resolve())); },
  };
}

async function scenario(test: (f: any) => Promise<void>, options: { env?: Record<string, string>; fake?: Record<string, string>; scripted?: boolean } = {}) {
  const parentEnv: NodeJS.ProcessEnv = { ...process.env, ...options.fake };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined, { scripted: options.scripted !== false });
  const url = session.info.url;
  const dataDir = session.info.dataDir;
  let server: ChildProcess = session.child;
  let restarted = false;
  const restart = async (signal: NodeJS.Signals, extraEnv: Record<string, string> = {}) => {
    await waitForExit(server, { signal });
    const env = { ...verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), ...extraEnv };
    const log = openSync(session.info.logPath, "a", 0o600);
    server = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", log, log] });
    restarted = true;
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
  };
  try {
    // The launcher's environment is hermetic: a loopback backend the server must reach is given on a restart.
    if (options.env) await restart("SIGTERM", options.env);
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      const raw = await response.text();
      let parsed: any = raw;
      try { parsed = JSON.parse(raw); } catch {}
      return { status: response.status, body: parsed };
    };
    const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    const bot = async (name: string, section: string) => (await cli("new-bot", "--name", name, "--section", section)).bot;
    const clive = await bot("Clive", "Leadership");
    const planPath = join(dataDir, "room-plan.json");
    const plan: Record<string, { script: unknown[] }> = { [clive.id]: { script: [] } };
    const script = (botId: string, ...entries: unknown[]) => {
      (plan[botId] ??= { script: [] }).script.push(...entries);
      writeFileSync(planPath, JSON.stringify(plan));
    };
    writeFileSync(planPath, JSON.stringify(plan));

    const say = async (botId: string, threadId: string, text: string) => {
      const sent = await api("POST", `/api/bots/${botId}/messages`, { text, threadId });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      return sent.body;
    };
    const db = () => readRuntimeDb(dataDir);
    const roots = () => db().assignments.filter((row) => !row.parentId);
    const eventsOf = (id: string) => db().events.filter((event) => event.assignmentId === id).map((event) => event.kind);
    const turns = (botId?: string): any[] => jsonl(`${planPath}.evidence.jsonl`).filter((turn) => !botId || turn.botId === botId);
    const turn = (key: string) => turns().find((candidate) => candidate.planKey === key);
    const own = (record: any): string => ownTurnText(record?.prompt);
    const body = (record: any): string => own(record).replace(/^\s*Current time when this message was sent:[^\n]*\n+/, "");
    const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=300`)).body.messages ?? [];
    const chips = async (threadId: string, text: string) => (await messages(threadId)).filter((message) => chipText(message).includes(text));
    const said = async (threadId: string, text: string) => (await messages(threadId))
      .filter((message) => message.role === "bot" && message.kind === "text" && String(message.text).includes(text)).length;
    const final = async (threadId: string, text: string, timeout = 30_000) => {
      const ended = () => roots().find((row) => row.status === "failed" || row.status === "cancelled");
      await expect.poll(async () => (await said(threadId, text)) === 1 || ended() !== undefined, { timeout }).toBe(true);
      const root = ended();
      expect(await said(threadId, text), root ? `root ${root.status} (${root.outcome}): ${root.result}` : "").toBe(1);
    };
    const task = async (botId: string, threadId: string) => ((await api("GET", "/api/bots?messages=0")).body.bots as any[])
      .find((candidate) => candidate.id === botId)?.tasks.find((candidate: any) => candidate.threadId === threadId);
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const open = (name: string) => writeFileSync(gate(name), "open");
    const ready = (name: string) => join(dataDir, `${name}.ready`);
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const token = (server: "agents" | "composio" = "agents") => {
      const env = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).mcpConfig.mcpServers[server].env;
      return (server === "agents" ? env.OMB_COMMS_TOKEN : env.OMB_CONNECTOR_TOKEN) as string;
    };
    const internal = async (path: string, body: unknown, bearer: string) => {
      const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      await test({ api, cli, clive, dataDir, script, say, db, roots, eventsOf, turns, turn, own, body, messages, chips, said, final, task,
        gate, open, ready, settle, restart, token, internal });
    } catch (error) {
      const summary = {
        turns: turns().map((record) => ({ planKey: record.planKey, unplanned: record.unplanned, threadId: record.threadId, own: own(record).slice(0, 700) })),
        assignments: db().assignments.map(({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, cards, continuation }) =>
          ({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, cards, continuation })),
        events: db().events,
        chat: (await messages(clive.activeTaskId).catch(() => [])).map((message) => ({ role: message.role, kind: message.kind, text: message.text, tool: message.tool?.name })),
      };
      console.error(`runtime roots fixture state:\n${JSON.stringify(summary, null, 1)}`);
      throw error;
    }
    expect(turns().filter((record) => record.unplanned).map((record) => own(record).slice(0, 300))).toEqual([]);
  } finally {
    if (restarted) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

it("T1 records a person's turn as a root that runs and completes", () => scenario(async (f) => {
  const request = "T1-JOB: summarise the week's invoices and tell me the total.";
  f.script(f.clive.id, { key: "C0", match: ["T1-JOB"], readyFile: f.ready("c0"), gateFile: f.gate("c0"), reply: "T1-FINAL: the total is 42." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, request);
  await expect.poll(() => existsSync(f.ready("c0")), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("running");
  const running = f.roots()[0];
  expect(running).toMatchObject({ depth: 0, executions: 1, requester: { kind: "person", threadId: job, botId: f.clive.id },
    origin: { kind: "person", quote: expect.stringContaining("T1-JOB") }, assignee: { botId: f.clive.id, destination: { threadId: job } } });
  expect(running.brief).toContain("T1-JOB");
  expect(f.eventsOf(running.id)).toEqual(expect.arrayContaining(["enqueued", "started"]));
  f.open("c0");
  await f.final(job, "T1-FINAL");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  const root = f.roots()[0];
  expect(root).toMatchObject({ id: running.id, status: "completed", outcome: "done", executions: 1, restarts: 0, result: "T1-FINAL: the total is 42." });
  expect(f.roots()).toHaveLength(1);
  expect(f.eventsOf(root.id)).toEqual(expect.arrayContaining(["enqueued", "started", "settled"]));
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
}), hostTimeout(60_000));

it("T2 parks the root on a credential card and runs it again with the provided line", () => scenario(async (f) => {
  f.script(f.clive.id,
    { key: "C1", match: [SECRET_PROVIDED], reply: "T2-DONE: the model is set up." },
    { key: "C0", match: ["T2-JOB"], steps: [{ tool: "request_credential", arguments: { credential_id: "xaiApiKey", reason: "T2 fixture model" } }], reply: "T2-ASKED: waiting for the key." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T2-JOB: set up the Grok model; ask me for the key you need.");
  await f.final(job, "T2-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "secret");
  expect(card).toBeDefined();
  expect(card.secret).toMatchObject({ target: "xaiApiKey" });
  expect(card.secret.resumed).toBeUndefined();
  const parked = f.roots()[0];
  expect(parked).toMatchObject({ status: "needs_input", cards: [card.id], executions: 1 });
  expect(parked.question).toMatch(/provide/i);
  expect(f.eventsOf(parked.id)).toContain("parked");
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
  f.script(f.clive.id, { key: "C-TYPED", match: ["T2-TYPED"], reply: "T2-TYPED-DONE: hello back." });
  await f.say(f.clive.id, job, "T2-TYPED: hello while the card waits.");
  await f.final(job, "T2-TYPED-DONE");
  await expect.poll(() => f.roots().map((row: any) => row.status), { timeout: 15_000 }).toEqual(["needs_input", "completed"]);
  expect(f.roots()[0]).toMatchObject({ id: parked.id, cards: [card.id], executions: 1 });
  expect((await f.api("PUT", "/api/config", { xai: { key: "xai-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: job });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: true });
  await f.final(job, "T2-DONE");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roots()).toHaveLength(2);
  expect(f.roots()[0]).toMatchObject({ id: parked.id, status: "completed", outcome: "done", executions: 2, result: "T2-DONE: the model is set up." });
  expect(f.roots()[0].cards).toBeUndefined();
  expect(f.eventsOf(parked.id)).toEqual(expect.arrayContaining(["parked", "answered", "started", "settled"]));
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C-TYPED", "C1"]);
  const answered = f.body(f.turn("C1")).trimStart();
  expect(answered.startsWith(SECRET_PROVIDED), answered.slice(0, 200)).toBe(true);
  expect((await f.messages(job)).find((message: any) => message.id === card.id).secret).toMatchObject({ provided: true, resumed: true });
  const again = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: job });
  expect(again.status).toBe(200);
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C-TYPED", "C1"]);
  expect(f.roots()[0].executions).toBe(2);
}), hostTimeout(60_000));

it("T3 parks the root on connector cards and runs it again once when both connect", async () => {
  const composio = await composioStub();
  try {
    await scenario(async (f) => {
      expect((await f.api("PUT", "/api/config", { composio: { apiKey: "ak_good" } })).status).toBe(200);
      f.script(f.clive.id,
        { key: "C1", match: [CONNECTED, "Gmail", "Slack"], reply: "T3-DONE: mail and chat are wired." },
        { key: "C0", match: ["T3-JOB"], readyFile: f.ready("c0"), gateFile: f.gate("c0"), reply: "T3-ASKED: connect the apps." });
      const job = f.clive.activeTaskId;
      await f.say(f.clive.id, job, "T3-JOB: wire up my mail and chat.");
      await expect.poll(() => existsSync(f.ready("c0")), { timeout: 30_000 }).toBe(true);
      const requested = await f.internal("/api/internal/connectors/request", { botId: f.clive.id, threadId: job, resumeKey: "t3-resume-key-0001", items: ["gmail", "slack"] }, f.token("composio"));
      expect(requested.status, JSON.stringify(requested.body)).toBe(200);
      const [gmail, slack] = requested.body.messageIds as string[];
      f.open("c0");
      await f.final(job, "T3-ASKED");
      await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
      const parked = f.roots()[0];
      expect(parked.cards).toEqual([gmail, slack]);
      expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
      composio.connect("gmail");
      const first = await f.api("GET", `/api/bots/${f.clive.id}/connector-cards/${gmail}/status?threadId=${job}`);
      expect(first.body).toMatchObject({ connected: true });
      await f.settle(500);
      expect(f.roots()[0].status).toBe("needs_input");
      expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
      composio.connect("slack");
      const second = await f.api("GET", `/api/bots/${f.clive.id}/connector-cards/${slack}/status?threadId=${job}`);
      expect(second.body).toMatchObject({ connected: true });
      await f.final(job, "T3-DONE");
      await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
      expect(f.roots()).toHaveLength(1);
      expect(f.roots()[0]).toMatchObject({ id: parked.id, executions: 2, outcome: "done" });
      expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C1"]);
      const answered = f.body(f.turn("C1")).trimStart();
      expect(answered.startsWith(`${CONNECTED} Gmail, Slack.`), answered.slice(0, 200)).toBe(true);
      const cards = (await f.messages(job)).filter((message: any) => message.kind === "connector");
      expect(cards.map((message: any) => message.connector.resumed)).toEqual([true, true]);
      expect((await f.api("POST", `/api/bots/${f.clive.id}/connector-cards/${gmail}/resume`, { threadId: job })).body).toEqual({ resumed: true });
      await f.settle(500);
      expect(f.roots()[0].executions).toBe(2);
    }, { env: composio.env });
  } finally {
    await composio.close();
  }
}, hostTimeout(90_000));

it("T5 reruns a person's cut turn once after a restart, with the restart note first and the resuming chip", () => scenario(async (f) => {
  const request = "T5-JOB: migrate the invoices and report.";
  f.script(f.clive.id,
    { key: "C-RERUN", match: ["T5-JOB", RERUN_NOTE], reply: "T5-FINAL: migrated once." },
    { key: "C-CUT", match: ["T5-JOB"], readyFile: f.ready("cut"), gateFile: f.gate("cut"), reply: "never" });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, request);
  await expect.poll(() => existsSync(f.ready("cut")), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("running");
  const cut = f.roots()[0];

  await f.restart("SIGTERM");
  f.open("cut");

  await expect.poll(() => f.turns(f.clive.id).map((record: any) => record.planKey).at(-1), { timeout: 30_000 }).toBe("C-RERUN");
  const rerun = f.body(f.turn("C-RERUN")).trimStart();
  expect(rerun.startsWith(RERUN_NOTE), rerun.slice(0, 300)).toBe(true);
  expect(rerun).toContain("Continue the request you were working on");
  expect(rerun).toContain("T5-JOB");
  await f.final(job, "T5-FINAL");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ id: cut.id, status: "completed", outcome: "done", restarts: 1, executions: 2, result: "T5-FINAL: migrated once." });
  expect(f.eventsOf(cut.id)).toContain("restart_reconciled");
  expect(await f.chips(job, RERUN_CHIP)).toHaveLength(1);
  expect(await f.chips(job, "turn interrupted — OpenMausBot restarted")).toHaveLength(0);
  await f.settle(500);
  expect(f.turns(f.clive.id).filter((record: any) => record.planKey === "C-RERUN")).toHaveLength(1);
}), hostTimeout(90_000));

it("T6 continues a person's step-capped turn in place on the same root", async () => {
  const model = await loopbackModel();
  try {
    await scenario(async (f) => {
      const eli = (await f.cli("new-bot", "--name", "Eli", "--section", "Engineering")).bot;
      const compat = { key: "synthetic-fixture-key", url: model.url, model: "loop-model" };
      expect((await f.api("PATCH", "/api/config", { openaiCompat: compat })).status).toBe(200);
      await f.cli("set-model", "--bot", eli.id, "--instance", "openaiCompat", "--model", "loop-model");
      model.answer(({ lastUser }: ModelRequest) => lastUser.includes(STEP_CAP_CONTINUES) ? { say: "T6-DONE: finished the rest." } : { call: true });
      const job = eli.activeTaskId;
      await f.say(eli.id, job, "T6-JOB: build the export end to end.");
      await f.final(job, "T6-DONE", 90_000);
      await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
      expect(f.roots()).toHaveLength(1);
      const root = f.roots()[0];
      expect(root).toMatchObject({ status: "completed", outcome: "done", executions: 2, result: "T6-DONE: finished the rest." });
      expect(f.eventsOf(root.id)).toEqual(expect.arrayContaining(["started", "continued", "started", "settled"]));
      expect(model.requests.filter((sent) => sent.lastUser.includes("T6-JOB") && !sent.lastUser.includes(STEP_CAP_CONTINUES))).toHaveLength(64);
      const continued = model.requests.filter((sent) => sent.lastUser.includes(STEP_CAP_CONTINUES));
      expect(continued).toHaveLength(1);
      expect(continued[0]!.lastUser).toMatch(/Every step so far is listed in \S*handoffs\S*; read it before going on\./);
      const tasks = ((await f.api("GET", "/api/bots?messages=0")).body.bots as any[]).find((candidate) => candidate.id === eli.id).tasks as any[];
      expect(tasks.map((candidate) => candidate.title).filter((title: string) => title.startsWith("Continue:"))).toEqual([]);
      expect(tasks).toHaveLength(1);
    });
  } finally {
    await model.close();
  }
}, hostTimeout(150_000));

// The host fallback (an Auto turn on the person's own desktop) exists on macOS and Windows only.
const itHost = process.platform === "linux" ? it.skip : it;
itHost("T7 queues a root on the computer seat at the wait ceiling and continues it when the seat frees", async () => {
  const CEILING_MS = 1_500;
  const home = mkdtempSync(join(tmpdir(), "omb-runtime-roots-seat-"));
  const data = join(home, "data");
  const ui = join(home, "static");
  const stateFile = join(home, "vm.json");
  const dumpFile = join(home, "dump.json");
  const finishFile = join(home, "finish");
  let output = "";
  let child: ChildProcess | null = null;
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  const until = async <T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-3_000)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const dumpFor = (botId: string): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try { const sent = JSON.parse(readFileSync(dumpFile, "utf8")); return sent.mcpConfig?.mcpServers?.computer?.env?.OMB_CONTROL_URL?.includes(botId) ? sent : null; } catch { return null; }
  }, Boolean);
  const gate = (sent: any) => createControlClient({ url: sent.mcpConfig.mcpServers.computer.env.OMB_CONTROL_URL, token: sent.mcpConfig.mcpServers.computer.env.OMB_CONTROL_TOKEN }).state(true);
  const taskOf = (botId: string, threadId: string) => api("GET", "/api/bots?messages=0").then(({ body }) =>
    body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const roots = () => readRuntimeDb(data).assignments.filter((row) => !row.parentId);
  const eventsOf = (id: string) => readRuntimeDb(data).events.filter((event) => event.assignmentId === id).map((event) => event.kind);
  try {
    writeFileSync(stateFile, JSON.stringify({ noContainers: true }));
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Runtime roots</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    mkdirSync(join(home, "user-data"), { recursive: true });
    writeFileSync(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"), mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    } } }));
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
        OMB_USER_DATA: join(home, "user-data"), OMB_COMPUTER_CALL_WAIT_MS: "4000", OMB_COMPUTER_CALL_ACT_WITHIN_MS: "1000",
        OMB_COMPUTER_WAIT_MAX_MS: String(CEILING_MS),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", (chunk) => { output += chunk; });
    proc.stderr!.on("data", (chunk) => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);

    const { bot: holder } = await apiOk("POST", "/api/bots", { name: "Seat Holder" });
    const { task: held } = await apiOk("POST", `/api/bots/${holder.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${holder.id}/messages`, { text: "Hold the screen slowly.", threadId: held.threadId });
    await until(() => taskOf(holder.id, held.threadId), (task) => task?.busy === true);
    expect(await gate(await dumpFor(holder.id))).toEqual({ held: false, helpOpen: false });
    const { bot: waiter } = await apiOk("POST", "/api/bots", { name: "Seat Waiter" });
    const { task: wait } = await apiOk("POST", `/api/bots/${waiter.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${waiter.id}/messages`, { text: "T7-JOB: use the screen too.", threadId: wait.threadId });
    await until(() => taskOf(waiter.id, wait.threadId), (task) => task?.busy === true);
    const contested = await gate(await dumpFor(waiter.id));
    expect(contested.held).toBe(true);
    const root = (await until(() => roots().find((row) => row.assignee?.destination?.threadId === wait.threadId), (row) => row?.status === "queued"))!;
    expect(root).toMatchObject({ status: "queued", executions: 1, continuation: { note: expect.stringContaining(SEAT_FREE), count: 1 } });
    expect(eventsOf(root.id)).toContain("continued");
    await until(() => taskOf(waiter.id, wait.threadId), (task) => task?.activity === "parked.computer" && task.busy === false);
    const chat = (await api("GET", `/api/threads/${wait.threadId}/messages?limit=100`)).body.messages as any[];
    const parkedChip = chat.find((message) => chipText(message).includes("Parked — it continues automatically when the computer is free"));
    expect(parkedChip, JSON.stringify(chat.map(chipText))).toBeDefined();
    expect(chipText(parkedChip)).toContain("Seat Holder");
    const { bot: second } = await apiOk("POST", "/api/bots", { name: "Seat Second" });
    const { task: wait2 } = await apiOk("POST", `/api/bots/${second.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${second.id}/messages`, { text: "T7-JOB-2: use the screen as well.", threadId: wait2.threadId });
    await until(() => taskOf(second.id, wait2.threadId), (task) => task?.busy === true);
    expect((await gate(await dumpFor(second.id))).held).toBe(true);
    const root2 = (await until(() => roots().find((row) => row.assignee?.destination?.threadId === wait2.threadId), (row) => row?.status === "queued"))!;
    expect(root2).toMatchObject({ status: "queued", executions: 1, continuation: { note: expect.stringContaining(SEAT_FREE), count: 1 } });
    expect(root2.createdAt).toBeGreaterThan(root.createdAt);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(roots().filter((row) => row.id === root.id || row.id === root2.id).map((row) => row.status)).toEqual(["queued", "queued"]);
    for (const id of [root.id, root2.id]) expect(eventsOf(id).filter((kind) => ["settled", "cancelled", "budget", "refused"].includes(kind))).toEqual([]);
    writeFileSync(finishFile, "finish");
    await until(() => taskOf(holder.id, held.threadId), (task) => task?.busy === false);
    const continued = await until(() => roots().find((row) => row.id === root.id), (row) => row?.status === "completed", 45_000);
    expect(continued).toMatchObject({ status: "completed", outcome: "done", executions: 2 });
    expect(eventsOf(root.id)).toEqual(expect.arrayContaining(["started", "continued", "started", "settled"]));
    const continued2 = await until(() => roots().find((row) => row.id === root2.id), (row) => row?.status === "completed", 45_000);
    expect(continued2).toMatchObject({ status: "completed", outcome: "done" });
    const events = readRuntimeDb(data).events;
    const secondStart = (id: string) => events.findIndex((event, index) => event.assignmentId === id && event.kind === "started"
      && events.slice(0, index).some((prior) => prior.assignmentId === id && prior.kind === "started"));
    expect(secondStart(root.id)).toBeGreaterThan(-1);
    expect(secondStart(root.id)).toBeLessThan(secondStart(root2.id));
    const resumed = await dumpFor(second.id);
    expect(JSON.stringify(resumed.prompt)).toContain(SEAT_FREE);
    const after = (await api("GET", `/api/threads/${wait.threadId}/messages?limit=100`)).body.messages as any[];
    expect(after.filter((message) => chipText(message).includes("Parked — it continues automatically")).length).toBe(1);
    await until(() => taskOf(waiter.id, wait.threadId), (task) => task?.busy === false && task.activity === "idle");
    await until(() => taskOf(second.id, wait2.threadId), (task) => task?.busy === false && task.activity === "idle");
  } finally {
    if (child) {
      writeFileSync(finishFile, "finish");
      await waitForExit(child, { signal: "SIGTERM" });
    }
    rmSync(dumpFile, { force: true });
    await removeTempDir(home);
  }
}, hostTimeout(120_000));

const failedLines = async (f: any, threadId: string) => (await f.messages(threadId))
  .filter((message: any) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("error:"));

const browserPlace = async (f: any) => {
  expect((await f.api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
  expect((await f.api("PATCH", `/api/bots/${f.clive.id}`, { computer: "browser" })).status).toBe(200);
};

it("T8 Stop while parked on a credential card cancels the root and stops the card; a key provided afterwards is saved but starts nothing", () => scenario(async (f) => {
  f.script(f.clive.id, { key: "C0", match: ["T8-JOB"], steps: [{ tool: "request_credential", arguments: { credential_id: "xaiApiKey", reason: "T8 fixture model" } }], reply: "T8-ASKED: waiting for the key." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T8-JOB: set up the Grok model; ask me for the key you need.");
  await f.final(job, "T8-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "secret");
  expect(f.roots()[0].cards).toEqual([card.id]);
  expect((await f.api("POST", `/api/bots/${f.clive.id}/interrupt`, { threadId: job })).status).toBe(200);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("cancelled");
  expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
  const stopped = (await f.messages(job)).find((message: any) => message.id === card.id).secret;
  expect(stopped).toMatchObject({ stopped: true });
  expect(stopped.resumed).toBeUndefined();
  expect(stopped.provided).toBeUndefined();
  expect((await f.api("PUT", "/api/config", { xai: { key: "xai-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: job });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: false });
  await f.settle(1_500);
  const after = (await f.messages(job)).find((message: any) => message.id === card.id).secret;
  expect(after).toMatchObject({ provided: true, stopped: true });
  expect(after.resumed).toBeUndefined();
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(await failedLines(f, job)).toEqual([]);
  expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
}), hostTimeout(60_000));

it("T8 Stop while parked on connector cards cancels the root and stops the cards; connecting afterwards is kept but starts nothing", async () => {
  const composio = await composioStub();
  try {
    await scenario(async (f) => {
      expect((await f.api("PUT", "/api/config", { composio: { apiKey: "ak_good" } })).status).toBe(200);
      f.script(f.clive.id, { key: "C0", match: ["T8C-JOB"], readyFile: f.ready("c0"), gateFile: f.gate("c0"), reply: "T8C-ASKED: connect the apps." });
      const job = f.clive.activeTaskId;
      await f.say(f.clive.id, job, "T8C-JOB: wire up my mail and chat.");
      await expect.poll(() => existsSync(f.ready("c0")), { timeout: 30_000 }).toBe(true);
      const requested = await f.internal("/api/internal/connectors/request", { botId: f.clive.id, threadId: job, resumeKey: "t8-resume-key-0001", items: ["gmail", "slack"] }, f.token("composio"));
      expect(requested.status, JSON.stringify(requested.body)).toBe(200);
      const [gmail, slack] = requested.body.messageIds as string[];
      f.open("c0");
      await f.final(job, "T8C-ASKED");
      await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
      expect(f.roots()[0].cards).toEqual([gmail, slack]);
      expect((await f.api("POST", `/api/bots/${f.clive.id}/interrupt`, { threadId: job })).status).toBe(200);
      await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("cancelled");
      const cards = async () => (await f.messages(job)).filter((message: any) => message.kind === "connector").map((message: any) => message.connector);
      expect((await cards()).map((connector: any) => connector.stopped)).toEqual([true, true]);
      composio.connect("gmail");
      expect((await f.api("GET", `/api/bots/${f.clive.id}/connector-cards/${gmail}/status?threadId=${job}`)).body).toMatchObject({ connected: true });
      composio.connect("slack");
      expect((await f.api("GET", `/api/bots/${f.clive.id}/connector-cards/${slack}/status?threadId=${job}`)).body).toMatchObject({ connected: true });
      expect((await f.api("POST", `/api/bots/${f.clive.id}/connector-cards/${gmail}/resume`, { threadId: job })).status).toBeLessThan(500);
      await f.settle(1_500);
      expect((await cards()).map((connector: any) => [connector.status, connector.stopped, connector.resumed])).toEqual([["connected", true, undefined], ["connected", true, undefined]]);
      expect(f.roots()).toHaveLength(1);
      expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
      expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
      expect(await failedLines(f, job)).toEqual([]);
    }, { env: composio.env });
  } finally {
    await composio.close();
  }
}, hostTimeout(90_000));

it("T8 Stop while parked on a sign-in card cancels the root and stops the card; Cancel afterwards is saved but starts nothing", () => scenario(async (f) => {
  await browserPlace(f);
  f.script(f.clive.id, { key: "C0", match: ["T8S-JOB"], steps: [{ tool: "request_sign_in", arguments: { site: "https://example.com/dashboard", reason: "The dashboard is behind a login." } }], reply: "T8S-ASKED: sign in to example.com." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T8S-JOB: check my example.com dashboard.");
  await f.final(job, "T8S-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "signin");
  expect(f.roots()[0]).toMatchObject({ cards: [card.id], question: expect.stringContaining("sign in to example.com") });
  expect((await f.api("POST", `/api/bots/${f.clive.id}/interrupt`, { threadId: job })).status).toBe(200);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("cancelled");
  const stopped = (await f.messages(job)).find((message: any) => message.id === card.id).signIn;
  expect(stopped).toMatchObject({ stopped: true });
  expect(stopped.resumed).toBeUndefined();
  const cancelled = await f.api("POST", `/api/bots/${f.clive.id}/sign-in-cards/${card.id}/cancel`, { threadId: job });
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  expect(cancelled.body).toEqual({ cancelled: true, resumed: false });
  await f.settle(1_500);
  const after = (await f.messages(job)).find((message: any) => message.id === card.id).signIn;
  expect(after).toMatchObject({ cancelled: true, stopped: true });
  expect(after.resumed).toBeUndefined();
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(await failedLines(f, job)).toEqual([]);
}), hostTimeout(60_000));

it("T9 parks the root on a sign-in card and runs it again with the signed-in line on Done", () => scenario(async (f) => {
  await browserPlace(f);
  f.script(f.clive.id,
    { key: "C1", match: [SIGNED_IN, "example.com"], reply: "T9-DONE: the dashboard is open." },
    { key: "C0", match: ["T9-JOB"], steps: [{ tool: "request_sign_in", arguments: { site: "https://example.com/dashboard", reason: "The dashboard is behind a login." } }], reply: "T9-ASKED: sign in to example.com." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T9-JOB: check my example.com dashboard.");
  await f.final(job, "T9-ASKED");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(job)).find((message: any) => message.kind === "signin");
  const parked = f.roots()[0];
  expect(parked).toMatchObject({ status: "needs_input", cards: [card.id], executions: 1, question: expect.stringContaining("sign in to example.com") });
  expect(card.signIn.resumed).toBeUndefined();
  expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false, activity: "idle" });
  const done = await f.api("POST", `/api/bots/${f.clive.id}/sign-in-cards/${card.id}/done`, { threadId: job });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body).toEqual({ done: true, resumed: true });
  await f.final(job, "T9-DONE");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roots()).toHaveLength(1);
  expect(f.roots()[0]).toMatchObject({ id: parked.id, status: "completed", outcome: "done", executions: 2, result: "T9-DONE: the dashboard is open." });
  expect(f.eventsOf(parked.id)).toEqual(expect.arrayContaining(["parked", "answered", "started", "settled"]));
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C1"]);
  const answered = f.body(f.turn("C1")).trimStart();
  expect(answered.startsWith(`${SIGNED_IN} example.com.`), answered.slice(0, 200)).toBe(true);
  expect((await f.messages(job)).find((message: any) => message.id === card.id).signIn).toMatchObject({ done: true, resumed: true });
  expect((await f.api("POST", `/api/bots/${f.clive.id}/sign-in-cards/${card.id}/done`, { threadId: job })).body).toEqual({ done: true, resumed: true });
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C1"]);
}), hostTimeout(60_000));

it("T10 parks a teammate's turn on its credential card, tells the Chief at once, and the key answers the teammate", () => scenario(async (f) => {
  const mira = (await f.cli("new-bot", "--name", "Mira", "--section", "Engineering")).bot;
  expect((await f.api("PATCH", `/api/bots/${f.clive.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true })).status).toBe(200);
  const brief = "T10-BRIEF: set up the Grok model for the export; ask for the key you need.";
  f.script(f.clive.id,
    { key: "C0", match: ["T10-JOB"], steps: [{ arguments: { bot_ids: [mira.id], message: brief } }], reply: "C0: Mira is on it." },
    { key: "C1", match: [SETTLED, REPORT_FROM_MIRA, "T10-RESULT"], reply: "T10-FINAL: the export model is set up." });
  f.script(mira.id,
    { key: "M2", match: ["T10-BRIEF", SECRET_PROVIDED], reply: "T10-RESULT: the key is in and the export runs." },
    { key: "M1", match: ["T10-BRIEF"], steps: [{ tool: "request_credential", arguments: { credential_id: "xaiApiKey", reason: "T10 export model" } }], reply: "M1: I asked for the key." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T10-JOB: have Mira set up the export model and own the result.");
  const children = () => f.db().assignments.filter((row: any) => row.parentId);
  await expect.poll(() => children()[0]?.status, { timeout: 30_000 }).toBe("needs_input");
  const child = children()[0];
  const work = child.assignee.destination.threadId as string;
  const card = (await f.messages(work)).find((message: any) => message.kind === "secret");
  expect(card).toBeDefined();
  expect(child).toMatchObject({ status: "needs_input", cards: [card.id], executions: 1, question: expect.stringContaining("provide") });
  expect(f.eventsOf(child.id)).toContain("parked");
  await expect.poll(async () => (await f.chips(job, "needs your input")).length, { timeout: 15_000 }).toBe(1);
  expect(chipText((await f.chips(job, "needs your input"))[0])).toContain("provide");
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect(f.roots()[0].status).toBe("waiting");
  expect((await f.task(mira.id, work)).busy).toBe(false);
  expect((await f.api("PUT", "/api/config", { xai: { key: "xai-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${mira.id}/secret-cards/${card.id}/provided`, { threadId: work });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: true });
  await f.final(job, "T10-FINAL", 45_000);
  expect(children()[0]).toMatchObject({ id: child.id, status: "completed", outcome: "done", executions: 2 });
  expect(f.eventsOf(child.id)).toEqual(expect.arrayContaining(["parked", "answered", "started", "settled"]));
  expect(f.turns(mira.id).map((record: any) => record.planKey)).toEqual(["M1", "M2"]);
  expect(f.own(f.turn("M2"))).toContain(SECRET_PROVIDED);
  expect(f.roots()[0]).toMatchObject({ status: "completed", executions: 2 });
  expect((await f.messages(work)).find((message: any) => message.id === card.id).secret).toMatchObject({ provided: true, resumed: true });
  expect(await f.chips(job, "needs your input")).toHaveLength(1);
}), hostTimeout(90_000));

it("T11 does not rerun a cut turn that already pushed: the root ends with what it did, said once", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-runtime-roots-outward-"));
  try {
    await scenario(async (f) => {
      const job = f.clive.activeTaskId;
      await f.say(f.clive.id, job, "T11-JOB: push the release branch.");
      await expect.poll(async () => (await f.messages(job)).some((message: any) => message.kind === "activity" && message.tool?.name === "Bash" && message.tool.ok === true), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("running");
      const cut = f.roots()[0];
      await f.restart("SIGTERM");
      await expect.poll(() => f.roots()[0]?.status, { timeout: 30_000 }).toBe("failed");
      const root = f.roots()[0];
      expect(root).toMatchObject({ id: cut.id, status: "failed", outcome: "interrupted", executions: 1, restarts: 0 });
      expect(root.outcomeDetail.startsWith(INTERRUPTED_OUTWARD), root.outcomeDetail).toBe(true);
      expect(root.outcomeDetail).toContain("git push");
      expect(f.db().events.find((event: any) => event.assignmentId === root.id && event.kind === "restart_reconciled")?.detail).toBe("failed: outward action done");
      await expect.poll(async () => (await f.chips(job, INTERRUPTED_OUTWARD)).length, { timeout: 15_000 }).toBe(1);
      const line = (await f.chips(job, INTERRUPTED_OUTWARD))[0];
      expect(line.tool.name.startsWith("error: ")).toBe(true);
      expect(line.tool.name).toContain("git push");
      expect(await f.chips(job, RERUN_CHIP)).toHaveLength(0);
      expect(await f.chips(job, "turn interrupted — OpenMausBot restarted")).toHaveLength(0);
      await f.settle(1_500);
      expect(f.roots()).toHaveLength(1);
      expect(f.roots()[0]).toMatchObject({ status: "failed", executions: 1 });
      expect(await f.task(f.clive.id, job)).toMatchObject({ busy: false });
      const rows = (await f.messages(job)).filter((message: any) => !["digest", "compaction", "call"].includes(message.kind));
      expect(rows.at(-1).id).toBe(line.id);
    }, { scripted: false, fake: {
      FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: join(home, "finish"),
      FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "Bash", input: { command: "git push origin release" }, ok: true, output: [{ type: "text", text: "pushed" }] }]),
    } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, hostTimeout(90_000));

const STALL_CLOCK = { OMB_TEST_STALL_CLOCK: "1" };

type CardState = { status?: string; stopped?: boolean; resumed?: boolean };
type StallFixture = {
  dataDir: string;
  clive: { id: string };
  roots(): Array<{ status: string; outcome?: string; executions: number; cards?: string[] }>;
  messages(threadId: string): Promise<Array<{ id: string; kind: string; tool?: { name: string }; secret?: CardState; connector?: CardState; signIn?: CardState }>>;
  turns(botId: string): Array<{ planKey?: string }>;
  open(name: string): void;
  script(botId: string, ...entries: unknown[]): void;
  say(botId: string, threadId: string, text: string): Promise<unknown>;
  said(threadId: string, text: string): Promise<number>;
};

const stallOverCards = async (f: StallFixture, job: string, ids: string[]) => {
  const marker = join(f.dataDir, "stall-turns");
  writeFileSync(marker, "now");
  try { await expect.poll(() => f.roots()[0]?.status, { timeout: 20_000 }).not.toBe("running"); } finally { rmSync(marker, { force: true }); }
  expect(f.roots()[0]).toMatchObject({ status: "failed", outcome: "stalled", executions: 1 });
  expect(f.roots()[0]!.cards).toBeUndefined();
  expect((await f.messages(job)).filter((message) => message.kind === "activity" && message.tool?.name.startsWith("error:")).map((message) => message.tool!.name))
    .toEqual(["error: no activity for 20 minutes — the turn was stopped"]);
  const cards = (await f.messages(job)).filter((message) => ids.includes(message.id));
  expect(cards.map((message) => (message.secret ?? message.connector ?? message.signIn)?.stopped)).toEqual(ids.map(() => true));
};

const answerStartsNothing = async (f: StallFixture, job: string) => {
  f.open("c0");
  f.script(f.clive.id, { key: "C-AFTER", match: ["AFTER-ANSWER"], reply: "AFTER-ANSWER-DONE: hello back." });
  await f.say(f.clive.id, job, "AFTER-ANSWER: hello after the card was answered.");
  await expect.poll(() => f.roots().map((row) => row.status), { timeout: 30_000 }).toEqual(["failed", "completed"]);
  expect(f.roots().map((row) => [row.outcome, row.executions])).toEqual([["stalled", 1], ["done", 1]]);
  expect(await f.said(job, "AFTER-ANSWER-DONE")).toBe(1);
  expect(f.turns(f.clive.id).map((record) => record.planKey)).toEqual(["C-AFTER"]);
};

it("T12 a turn the watchdog stops after it posted a credential card fails as stalled and stops the card", () => scenario(async (f) => {
  f.script(f.clive.id, { key: "C0", match: ["T12-JOB"], steps: [{ tool: "request_credential", arguments: { credential_id: "xaiApiKey", reason: "T12 fixture model" } }],
    gateFile: f.gate("c0"), reply: "T12-LATE: never shown." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T12-JOB: set up the Grok model; ask me for the key you need.");
  await expect.poll(async () => (await f.messages(job)).find((message: { kind: string }) => message.kind === "secret")?.id, { timeout: 30_000 }).toBeTruthy();
  const card = (await f.messages(job)).find((message: { kind: string }) => message.kind === "secret");
  await stallOverCards(f, job, [card.id]);
  expect((await f.api("PUT", "/api/config", { xai: { key: "xai-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: job });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: false });
  await answerStartsNothing(f, job);
}, { fake: STALL_CLOCK }), hostTimeout(60_000));

it("T12 a turn the watchdog stops after it posted connector cards fails as stalled and stops the cards", async () => {
  const composio = await composioStub();
  try {
    await scenario(async (f) => {
      expect((await f.api("PUT", "/api/config", { composio: { apiKey: "ak_good" } })).status).toBe(200);
      f.script(f.clive.id, { key: "C0", match: ["T12C-JOB"], readyFile: f.ready("c0"), gateFile: f.gate("c0"), reply: "T12C-LATE: never shown." });
      const job = f.clive.activeTaskId;
      await f.say(f.clive.id, job, "T12C-JOB: wire up my mail and chat.");
      await expect.poll(() => existsSync(f.ready("c0")), { timeout: 30_000 }).toBe(true);
      const requested = await f.internal("/api/internal/connectors/request", { botId: f.clive.id, threadId: job, resumeKey: "t12-resume-key-0001", items: ["gmail", "slack"] }, f.token("composio"));
      expect(requested.status, JSON.stringify(requested.body)).toBe(200);
      const [gmail, slack] = requested.body.messageIds as string[];
      await stallOverCards(f, job, [gmail, slack]);
      composio.connect("gmail");
      composio.connect("slack");
      expect((await f.api("GET", `/api/bots/${f.clive.id}/connector-cards/${gmail}/status?threadId=${job}`)).body).toMatchObject({ connected: true });
      expect((await f.api("GET", `/api/bots/${f.clive.id}/connector-cards/${slack}/status?threadId=${job}`)).body).toMatchObject({ connected: true });
      await answerStartsNothing(f, job);
      const cards = (await f.messages(job)).filter((message: { kind: string }) => message.kind === "connector").map((message: { connector: CardState }) => message.connector);
      expect(cards.map((connector: CardState) => [connector.status, connector.stopped, connector.resumed])).toEqual([["connected", true, undefined], ["connected", true, undefined]]);
    }, { env: composio.env, fake: STALL_CLOCK });
  } finally {
    await composio.close();
  }
}, hostTimeout(90_000));

it("T12 a turn the watchdog stops after it posted a sign-in card fails as stalled and stops the card", () => scenario(async (f) => {
  await browserPlace(f);
  f.script(f.clive.id, { key: "C0", match: ["T12S-JOB"], steps: [{ tool: "request_sign_in", arguments: { site: "https://example.com/dashboard", reason: "The dashboard is behind a login." } }],
    gateFile: f.gate("c0"), reply: "T12S-LATE: never shown." });
  const job = f.clive.activeTaskId;
  await f.say(f.clive.id, job, "T12S-JOB: check my example.com dashboard.");
  await expect.poll(async () => (await f.messages(job)).find((message: { kind: string }) => message.kind === "signin")?.id, { timeout: 30_000 }).toBeTruthy();
  const card = (await f.messages(job)).find((message: { kind: string }) => message.kind === "signin");
  await stallOverCards(f, job, [card.id]);
  const done = await f.api("POST", `/api/bots/${f.clive.id}/sign-in-cards/${card.id}/done`, { threadId: job });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body).toEqual({ done: true, resumed: false });
  await answerStartsNothing(f, job);
}, { fake: STALL_CLOCK }), hostTimeout(60_000));
