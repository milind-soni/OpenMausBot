import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const SEAT_FREE = "the computer this conversation waited for is free again";
const INTERRUPTED_OUTWARD = "Interrupted by an OpenMausBot restart after it already";
const SETTLED = "Your downstream room requests have settled.";
const GOAL_RUN_ENDED = "The goal run this step belonged to ended with the restart.";
const INTERRUPTED_LINE = "turn interrupted — OpenMausBot restarted";

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

type Responder = { kind: "member"; botId: string } | { kind: "mentions" } | { kind: "everyone" };

async function scenario(test: (f: any) => Promise<void>, options: { fake?: Record<string, string>; scripted?: boolean } = {}) {
  const parentEnv: NodeJS.ProcessEnv = { ...process.env, ...options.fake };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined, { scripted: options.scripted !== false });
  const url = session.info.url;
  const dataDir = session.info.dataDir;
  let server: ChildProcess = session.child;
  let restarted = false;
  let roomThread: string | undefined;
  const restart = async (signal: NodeJS.Signals, extraEnv: Record<string, string> = {}, before?: () => void) => {
    await waitForExit(server, { signal });
    before?.();
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

    const room = async (name: string, memberIds: string[], defaultResponder: Responder) => {
      const created = await api("POST", "/api/groups", { name, memberIds, setup: { bulletin: "", defaultResponder } });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      roomThread = created.body.group.threadId;
      return created.body.group as { id: string; threadId: string };
    };
    const post = async (group: { id: string; threadId: string }, text: string, extra: Record<string, unknown> = {}) => {
      const sent = await api("POST", `/api/groups/${group.id}/messages`, { text, threadId: group.threadId, ...extra });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      return sent.body;
    };
    const roomView = async (groupId: string) => ((await api("GET", "/api/bots?messages=0")).body.groups as any[]).find((group) => group.id === groupId);
    const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as any[];
    const db = () => readRuntimeDb(dataDir);
    const roots = () => db().assignments.filter((row) => !row.parentId);
    const roomRoots = (threadId: string) => roots().filter((row) => row.assignee?.destination?.threadId === threadId);
    const eventsOf = (id: string) => db().events.filter((event) => event.assignmentId === id).map((event) => event.kind);
    const turns = (botId?: string): any[] => jsonl(`${planPath}.evidence.jsonl`).filter((turn) => !botId || turn.botId === botId);
    const turn = (key: string) => turns().find((candidate) => candidate.planKey === key);
    const own = (record: any): string => ownTurnText(record?.prompt);
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
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const open = (name: string) => writeFileSync(gate(name), "open");
    const ready = (name: string) => join(dataDir, `${name}.ready`);
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      await test({ api, cli, bot, clive, dataDir, script, room, post, roomView, bots, db, roots, roomRoots, eventsOf, turns, turn, own, messages, chips, said, final,
        gate, open, ready, settle, restart });
    } catch (error) {
      const summary = {
        turns: turns().map((record) => ({ planKey: record.planKey, unplanned: record.unplanned, threadId: record.threadId, own: own(record).slice(0, 700) })),
        assignments: db().assignments.map(({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, cards, continuation, goalRunId, level }) =>
          ({ id, parentId, status, outcome, outcomeDetail, executions, restarts, restart, result, question, answer, cards, continuation, goalRunId, level })),
        events: db().events,
        room: roomThread ? (await messages(roomThread).catch(() => [])).map((message) => ({ role: message.role, kind: message.kind, from: message.from?.name, text: message.text, tool: message.tool?.name })) : [],
      };
      console.error(`room roots fixture state:\n${JSON.stringify(summary, null, 1)}`);
      throw error;
    }
    expect(turns().filter((record) => record.unplanned).map((record) => own(record).slice(0, 300))).toEqual([]);
  } finally {
    if (restarted) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

const nothingLive = (f: any) => f.db().assignments.filter((row: any) => !["completed", "failed", "cancelled"].includes(row.status));

it("R1 runs each responder of a person's room message as a root in the room thread", () => scenario(async (f) => {
  const mira = await f.bot("Mira", "Engineering");
  const room = await f.room("Engineering", [f.clive.id, mira.id], { kind: "mentions" });
  f.script(f.clive.id, { key: "C0", match: ["R1-JOB"], reply: "R1-CLIVE: the invoices are in." });
  f.script(mira.id, { key: "M0", match: ["R1-JOB"], reply: "R1-MIRA: the total is 42." });
  await f.post(room, "@Clive @Mira R1-JOB: summarise the week's invoices.");
  await f.final(room.threadId, "R1-CLIVE");
  await f.final(room.threadId, "R1-MIRA");
  await expect.poll(() => f.roomRoots(room.threadId).map((row: any) => row.status), { timeout: 15_000 }).toEqual(["completed", "completed"]);
  const rows = f.roomRoots(room.threadId);
  expect(rows.map((row: any) => row.assignee.botId).sort()).toEqual([f.clive.id, mira.id].sort());
  for (const row of rows) {
    expect(row).toMatchObject({ depth: 0, executions: 1, restarts: 0, outcome: "done",
      requester: { kind: "person", threadId: room.threadId, botId: row.assignee.botId },
      origin: { kind: "person", quote: expect.stringContaining("R1-JOB") },
      assignee: { destination: { kind: "room_thread", groupId: room.id, threadId: room.threadId } } });
    expect(row.brief).toContain("R1-JOB");
    expect(f.eventsOf(row.id)).toEqual(expect.arrayContaining(["enqueued", "started", "settled"]));
  }
  expect(rows.find((row: any) => row.assignee.botId === f.clive.id).result).toBe("R1-CLIVE: the invoices are in.");
  expect(f.db().assignments).toHaveLength(2);
  expect(nothingLive(f)).toEqual([]);
  await expect.poll(async () => (await f.roomView(room.id)).working, { timeout: 15_000 }).toBe(false);
  expect((await f.roomView(room.id)).busyBotId).toBeNull();
  expect(f.turns().map((record: any) => record.planKey).sort()).toEqual(["C0", "M0"]);
}), hostTimeout(60_000));

it("R2 a member's coordinate_bots reuses its turn's root, and a Chief's Full reaches the teammate's row and turn", () => scenario(async (f) => {
  const mira = await f.bot("Mira", "Engineering");
  expect((await f.api("PATCH", `/api/bots/${f.clive.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true })).status).toBe(200);
  // Full on the Chief is the operator's grant, seeded on the stored record while the server is down.
  await f.restart("SIGTERM", {}, () => {
    const stored = JSON.parse(readFileSync(join(f.dataDir, "bots.json"), "utf8"));
    const chief = stored.find((candidate: any) => candidate.id === f.clive.id);
    chief.approvalMode = "full"; chief.autoApprove = false;
    writeFileSync(join(f.dataDir, "bots.json"), JSON.stringify(stored, null, 2));
  });
  const room = await f.room("Engineering", [f.clive.id, mira.id], { kind: "member", botId: f.clive.id });
  f.script(f.clive.id,
    { key: "C0", match: ["R2-JOB"], steps: [{ arguments: { bot_ids: [mira.id], message: "R2-BRIEF: check the export numbers." } }], reply: "R2-SENT: Mira is on it." },
    { key: "C1", match: [SETTLED, "R2-RESULT"], reply: "R2-FINAL: confirmed, 42." });
  f.script(mira.id, { key: "M0", match: ["R2-BRIEF"], reply: "R2-RESULT: the numbers add up." });
  await f.post(room, "R2-JOB: have Mira check the export numbers and confirm.");
  await f.final(room.threadId, "R2-FINAL", 45_000);
  await expect.poll(() => f.db().assignments.map((row: any) => row.status), { timeout: 15_000 }).toEqual(["completed", "completed"]);
  const rows = f.db().assignments;
  const root = rows.find((row: any) => !row.parentId);
  const child = rows.find((row: any) => row.parentId);
  expect(root).toMatchObject({ id: child.parentId, status: "completed", executions: 2, level: "full",
    assignee: { botId: f.clive.id, destination: { kind: "room_thread", groupId: room.id, threadId: room.threadId } } });
  expect(child).toMatchObject({ rootId: root.id, status: "completed", outcome: "done", level: "full", result: "R2-RESULT: the numbers add up.",
    assignee: { botId: mira.id, destination: { kind: "room_thread", groupId: room.id, threadId: room.threadId } },
    requester: { kind: "bot_turn", botId: f.clive.id, threadId: room.threadId, chief: true } });
  expect(f.db().events.find((event: any) => event.assignmentId === child.id && event.kind === "started")?.detail).toContain("level full");
  expect(f.turn("C0").permissionMode).toBe("bypassPermissions");
  expect(f.turn("M0").permissionMode).toBe("bypassPermissions");
  expect(f.turns().map((record: any) => record.planKey)).toEqual(["C0", "M0", "C1"]);
  expect(nothingLive(f)).toEqual([]);
}), hostTimeout(120_000));

const parkOnCredential = async (f: any, room: { id: string; threadId: string }, job: string) => {
  f.script(f.clive.id, { key: "C0", match: [job], steps: [{ tool: "request_credential", arguments: { credential_id: "xaiApiKey", reason: `${job} fixture model` } }], reply: `${job}-ASKED: waiting for the key.` });
  await f.post(room, `${job}: set up the Grok model; ask me for the key you need.`);
  await f.final(room.threadId, `${job}-ASKED`);
  await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 15_000 }).toBe("needs_input");
  const card = (await f.messages(room.threadId)).find((message: any) => message.kind === "secret");
  expect(card).toBeDefined();
  expect(card.from.botId).toBe(f.clive.id);
  expect(card.secret.resumed).toBeUndefined();
  const parked = f.roomRoots(room.threadId)[0];
  expect(parked).toMatchObject({ status: "needs_input", cards: [card.id], executions: 1, question: expect.stringContaining("provide") });
  expect(f.eventsOf(parked.id)).toContain("parked");
  await expect.poll(async () => (await f.roomView(room.id)).working, { timeout: 15_000 }).toBe(false);
  expect((await f.roomView(room.id)).busyBotId).toBeNull();
  expect((await f.bots()).find((candidate: any) => candidate.id === f.clive.id).busy).toBe(false);
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  return { card, parked };
};

it("R3 parks a member's root on its credential card, keeps the room taking messages, and resumes the member with the provided line", () => scenario(async (f) => {
  const room = await f.room("Engineering", [f.clive.id], { kind: "member", botId: f.clive.id });
  const { card, parked } = await parkOnCredential(f, room, "R3-JOB");
  f.script(f.clive.id, { key: "C-TYPED", match: ["R3-TYPED"], reply: "R3-TYPED-DONE: hello back." }, { key: "C1", match: [SECRET_PROVIDED], reply: "R3-DONE: the model is set up." });
  await f.post(room, "R3-TYPED: hello while the card waits.");
  await f.final(room.threadId, "R3-TYPED-DONE");
  await expect.poll(() => f.roomRoots(room.threadId).map((row: any) => row.status), { timeout: 15_000 }).toEqual(["needs_input", "completed"]);
  expect(f.roomRoots(room.threadId)[0]).toMatchObject({ id: parked.id, cards: [card.id], executions: 1 });
  expect((await f.api("PUT", "/api/config", { xai: { key: "xai-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: room.threadId });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: true });
  await f.final(room.threadId, "R3-DONE");
  await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roomRoots(room.threadId)).toHaveLength(2);
  expect(f.roomRoots(room.threadId)[0]).toMatchObject({ id: parked.id, status: "completed", outcome: "done", executions: 2, result: "R3-DONE: the model is set up." });
  expect(f.roomRoots(room.threadId)[0].cards).toBeUndefined();
  expect(f.eventsOf(parked.id)).toEqual(expect.arrayContaining(["parked", "answered", "started", "settled"]));
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C-TYPED", "C1"]);
  expect(f.own(f.turn("C1"))).toContain(SECRET_PROVIDED);
  expect((await f.messages(room.threadId)).find((message: any) => message.id === card.id).secret).toMatchObject({ provided: true, resumed: true });
  expect((await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: room.threadId })).status).toBe(200);
  await f.settle(500);
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0", "C-TYPED", "C1"]);
  expect(nothingLive(f)).toEqual([]);
  expect((await f.roomView(room.id)).working).toBe(false);
}), hostTimeout(90_000));

it("R4 Stop in the room cancels the parked root and stops the card; providing afterwards saves but starts nothing", () => scenario(async (f) => {
  const room = await f.room("Engineering", [f.clive.id], { kind: "member", botId: f.clive.id });
  const { card, parked } = await parkOnCredential(f, room, "R4-JOB");
  expect((await f.api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
  await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 15_000 }).toBe("cancelled");
  expect(f.roomRoots(room.threadId)[0]).toMatchObject({ id: parked.id, status: "cancelled", outcome: "stopped", executions: 1 });
  const stopped = (await f.messages(room.threadId)).find((message: any) => message.id === card.id).secret;
  expect(stopped).toMatchObject({ stopped: true });
  expect(stopped.resumed).toBeUndefined();
  expect(stopped.provided).toBeUndefined();
  expect((await f.api("PUT", "/api/config", { xai: { key: "xai-fixture-key" } })).status).toBe(200);
  const provided = await f.api("POST", `/api/bots/${f.clive.id}/secret-cards/${card.id}/provided`, { threadId: room.threadId });
  expect(provided.status, JSON.stringify(provided.body)).toBe(200);
  expect(provided.body).toEqual({ provided: true, resumed: false });
  await f.settle(1_500);
  const after = (await f.messages(room.threadId)).find((message: any) => message.id === card.id).secret;
  expect(after).toMatchObject({ provided: true, stopped: true });
  expect(after.resumed).toBeUndefined();
  expect(f.roomRoots(room.threadId)).toHaveLength(1);
  expect(f.roomRoots(room.threadId)[0]).toMatchObject({ status: "cancelled", outcome: "stopped", executions: 1 });
  expect(f.turns(f.clive.id).map((record: any) => record.planKey)).toEqual(["C0"]);
  expect((await f.messages(room.threadId)).filter((message: any) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("error:"))).toEqual([]);
  expect((await f.roomView(room.id))).toMatchObject({ working: false, busyBotId: null });
  expect((await f.bots()).find((candidate: any) => candidate.id === f.clive.id).busy).toBe(false);
}), hostTimeout(60_000));

// The host desktop fallback exists on macOS and Windows only.
const itHost = process.platform === "linux" ? it.skip : it;
itHost("R5 queues a member's root on the computer seat at the wait ceiling, FIFO with a direct root, and continues it when the seat frees", async () => {
  const CEILING_MS = 1_500;
  const home = mkdtempSync(join(tmpdir(), "omb-room-roots-seat-"));
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
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-12_000)}`);
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
  const botOf = (botId: string) => api("GET", "/api/bots?messages=0").then(({ body }) => body.bots.find((bot: any) => bot.id === botId));
  const roomOf = (groupId: string) => api("GET", "/api/bots?messages=0").then(({ body }) => body.groups.find((group: any) => group.id === groupId));
  const rootIn = (threadId: string) => readRuntimeDb(data).assignments.find((row) => !row.parentId && row.assignee?.destination?.threadId === threadId);
  const eventsOf = (id: string) => readRuntimeDb(data).events.filter((event) => event.assignmentId === id).map((event) => event.kind);
  const chat = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
  try {
    writeFileSync(stateFile, JSON.stringify({ noContainers: true }));
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Room roots</title>");
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
    await apiOk("POST", `/api/bots/${waiter.id}/messages`, { text: "R5-DIRECT: use the screen too.", threadId: wait.threadId });
    await until(() => taskOf(waiter.id, wait.threadId), (task) => task?.busy === true);
    expect((await gate(await dumpFor(waiter.id))).held).toBe(true);
    const direct = (await until(() => rootIn(wait.threadId), (row) => row?.status === "queued"))!;
    expect(direct).toMatchObject({ status: "queued", continuation: { note: expect.stringContaining(SEAT_FREE), count: 1 } });
    rmSync(dumpFile, { force: true });
    const { bot: member } = await apiOk("POST", "/api/bots", { name: "Seat Member" });
    // A room turn reaches a desktop only through the member's own setting (no Auto fallback in a room).
    await apiOk("PATCH", `/api/bots/${member.id}`, { computer: "local" });
    const { group: room } = await apiOk("POST", "/api/groups", { name: "Screen room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    await apiOk("POST", `/api/groups/${room.id}/messages`, { text: "R5-ROOM: use the screen in the room.", threadId: room.threadId });
    await until(() => botOf(member.id), (bot) => bot?.busy === true);
    const memberLaunch = await dumpFor(member.id).catch(async (error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nroom chat: ${JSON.stringify((await chat(room.threadId)).map((message) => [message.kind, message.from?.name, chipText(message)]))}`);
    });
    expect((await gate(memberLaunch)).held).toBe(true);
    const root = (await until(() => rootIn(room.threadId), (row) => row?.status === "queued"))!;
    expect(root).toMatchObject({ status: "queued", executions: 1, continuation: { note: expect.stringContaining(SEAT_FREE), count: 1 },
      assignee: { botId: member.id, destination: { kind: "room_thread", groupId: room.id, threadId: room.threadId } } });
    expect(eventsOf(root.id)).toContain("continued");
    expect(root.createdAt).toBeGreaterThan(direct.createdAt);
    await until(() => botOf(member.id), (bot) => bot?.busy === false);
    const parkedChip = (await chat(room.threadId)).find((message) => chipText(message).includes("Parked — it continues automatically when the computer is free"));
    expect(parkedChip, JSON.stringify((await chat(room.threadId)).map(chipText))).toBeDefined();
    expect(chipText(parkedChip)).toContain("Seat Holder");
    expect((await roomOf(room.id)).busyBotId).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect([rootIn(wait.threadId)!.status, rootIn(room.threadId)!.status]).toEqual(["queued", "queued"]);
    for (const id of [direct.id, root.id]) expect(eventsOf(id).filter((kind) => ["settled", "cancelled", "budget", "refused"].includes(kind))).toEqual([]);
    writeFileSync(finishFile, "finish");
    await until(() => taskOf(holder.id, held.threadId), (task) => task?.busy === false);
    const continuedDirect = await until(() => rootIn(wait.threadId), (row) => row?.status === "completed", 45_000);
    expect(continuedDirect).toMatchObject({ status: "completed", outcome: "done", executions: 2 });
    const continuedRoom = await until(() => rootIn(room.threadId), (row) => row?.status === "completed", 45_000);
    expect(continuedRoom).toMatchObject({ id: root.id, status: "completed", outcome: "done", executions: 2 });
    expect(eventsOf(root.id)).toEqual(expect.arrayContaining(["started", "continued", "started", "settled"]));
    const events = readRuntimeDb(data).events;
    const secondStart = (id: string) => events.findIndex((event, index) => event.assignmentId === id && event.kind === "started"
      && events.slice(0, index).some((prior) => prior.assignmentId === id && prior.kind === "started"));
    expect(secondStart(direct.id)).toBeGreaterThan(-1);
    expect(secondStart(direct.id)).toBeLessThan(secondStart(root.id));
    // Read from the transcript, not the fake's launch dump: the dump keeps only the latest launch, and the continuations launch in parallel.
    const rows = await chat(room.threadId);
    const replies = rows.filter((message) => message.role === "bot" && message.kind === "text" && message.from?.botId === member.id);
    const shown = JSON.stringify(rows.map((message) => [message.kind, message.from?.name, message.turnId, chipText(message).slice(0, 80)]));
    expect(new Set(replies.map((message) => message.turnId)).size, shown).toBe(2);
    expect(replies.some((message) => String(message.text).includes(SEAT_FREE)), shown).toBe(true);
    expect(rows.filter((message) => chipText(message).includes("Parked — it continues automatically")).length).toBe(1);
    await until(() => roomOf(room.id), (group) => group?.working === false && group.busyBotId === null);
    await until(() => botOf(member.id), (bot) => bot?.busy === false);
  } finally {
    if (child) {
      writeFileSync(finishFile, "finish");
      await waitForExit(child, { signal: "SIGTERM" });
    }
    rmSync(dumpFile, { force: true });
    await removeTempDir(home);
  }
}, hostTimeout(120_000));

it("R6 reruns a member's cut turn once after a restart, in place, with the restart note and the member's resuming chip", () => scenario(async (f) => {
  const room = await f.room("Engineering", [f.clive.id], { kind: "member", botId: f.clive.id });
  f.script(f.clive.id,
    { key: "C-RERUN", match: ["R6-JOB", RERUN_NOTE], reply: "R6-FINAL: migrated once." },
    { key: "C-CUT", match: ["R6-JOB"], readyFile: f.ready("cut"), gateFile: f.gate("cut"), reply: "never" });
  await f.post(room, "R6-JOB: migrate the invoices and report.");
  await expect.poll(() => existsSync(f.ready("cut")), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 15_000 }).toBe("running");
  const cut = f.roomRoots(room.threadId)[0];
  await f.restart("SIGTERM");
  f.open("cut");
  await expect.poll(() => f.turns(f.clive.id).map((record: any) => record.planKey).at(-1), { timeout: 30_000 }).toBe("C-RERUN");
  const rerun = f.own(f.turn("C-RERUN"));
  expect(rerun).toContain(RERUN_NOTE);
  expect(rerun).toContain("Continue the request you were working on");
  expect(rerun).toContain("R6-JOB");
  await f.final(room.threadId, "R6-FINAL");
  await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.roomRoots(room.threadId)).toHaveLength(1);
  expect(f.roomRoots(room.threadId)[0]).toMatchObject({ id: cut.id, status: "completed", outcome: "done", restarts: 1, executions: 2, result: "R6-FINAL: migrated once." });
  expect(f.eventsOf(cut.id)).toContain("restart_reconciled");
  const chips = await f.chips(room.threadId, RERUN_CHIP);
  expect(chips).toHaveLength(1);
  expect(chips[0].from?.botId).toBe(f.clive.id);
  expect(await f.chips(room.threadId, INTERRUPTED_LINE)).toHaveLength(0);
  await f.settle(500);
  expect(f.turns(f.clive.id).filter((record: any) => record.planKey === "C-RERUN")).toHaveLength(1);
  expect((await f.roomView(room.id))).toMatchObject({ working: false, busyBotId: null });
}), hostTimeout(90_000));

it("R6 does not rerun a member's cut turn that already pushed: the root ends with what it did, said once in the room", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-room-roots-outward-"));
  try {
    await scenario(async (f) => {
      const room = await f.room("Engineering", [f.clive.id], { kind: "member", botId: f.clive.id });
      await f.post(room, "R6B-JOB: push the release branch.");
      await expect.poll(async () => (await f.messages(room.threadId)).some((message: any) => message.kind === "activity" && message.tool?.name === "Bash" && message.tool.ok === true), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 15_000 }).toBe("running");
      const cut = f.roomRoots(room.threadId)[0];
      await f.restart("SIGTERM");
      await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 30_000 }).toBe("failed");
      const root = f.roomRoots(room.threadId)[0];
      expect(root).toMatchObject({ id: cut.id, status: "failed", outcome: "interrupted", executions: 1, restarts: 0 });
      expect(root.outcomeDetail.startsWith(INTERRUPTED_OUTWARD), root.outcomeDetail).toBe(true);
      expect(root.outcomeDetail).toContain("git push");
      expect(f.db().events.find((event: any) => event.assignmentId === root.id && event.kind === "restart_reconciled")?.detail).toBe("failed: outward action done");
      await expect.poll(async () => (await f.chips(room.threadId, INTERRUPTED_OUTWARD)).length, { timeout: 15_000 }).toBe(1);
      const line = (await f.chips(room.threadId, INTERRUPTED_OUTWARD))[0];
      expect(line.tool.name.startsWith("error: ")).toBe(true);
      expect(line.tool.name).toContain("git push");
      expect(line.from?.botId).toBe(f.clive.id);
      expect(await f.chips(room.threadId, RERUN_CHIP)).toHaveLength(0);
      expect(await f.chips(room.threadId, INTERRUPTED_LINE)).toHaveLength(0);
      await f.settle(1_500);
      expect(f.roomRoots(room.threadId)).toHaveLength(1);
      expect(f.roomRoots(room.threadId)[0]).toMatchObject({ status: "failed", executions: 1 });
      expect((await f.roomView(room.id))).toMatchObject({ working: false, busyBotId: null });
      expect((await f.bots()).find((candidate: any) => candidate.id === f.clive.id).busy).toBe(false);
    }, { scripted: false, fake: {
      FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: join(home, "finish"),
      FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "Bash", input: { command: "git push origin release" }, ok: true, output: [{ type: "text", text: "pushed" }] }]),
    } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, hostTimeout(90_000));

it("R7 does not rerun a cut goal step after a restart: its run ended with the restart, the step ends with that reason, silently", () => scenario(async (f) => {
  const mira = await f.bot("Mira", "Engineering");
  const room = await f.room("Engineering", [f.clive.id, mira.id], { kind: "member", botId: f.clive.id });
  f.script(f.clive.id, { key: "C-STEP", match: ["R7-GOAL"], readyFile: f.ready("step"), gateFile: f.gate("step"), reply: "never" });
  await f.post(room, "R7-GOAL: get the export verified.", { mode: "goal" });
  await expect.poll(() => existsSync(f.ready("step")), { timeout: 30_000 }).toBe(true);
  const card = (await f.messages(room.threadId)).find((message: any) => message.kind === "goal.run");
  expect(card?.goalRun?.runId).toBeDefined();
  await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 15_000 }).toBe("running");
  const step = f.roomRoots(room.threadId)[0];
  expect(step).toMatchObject({ goalRunId: card.goalRun.runId, executions: 1, assignee: { botId: f.clive.id, destination: { kind: "room_thread", threadId: room.threadId } } });
  await f.restart("SIGTERM");
  f.open("step");
  await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 30_000 }).toBe("failed");
  const after = f.roomRoots(room.threadId)[0];
  expect(after).toMatchObject({ id: step.id, status: "failed", restarts: 1, result: GOAL_RUN_ENDED });
  expect(f.eventsOf(step.id)).toContain("restart_reconciled");
  expect((await f.messages(room.threadId)).find((message: any) => message.id === card.id).goalRun.status).not.toBe("working");
  await f.settle(1_500);
  expect(f.turns(f.clive.id).filter((record: any) => record.planKey !== "C-STEP")).toEqual([]);
  expect(f.roomRoots(room.threadId)).toHaveLength(1);
  expect(await f.chips(room.threadId, RERUN_CHIP)).toHaveLength(0);
  expect(await f.chips(room.threadId, GOAL_RUN_ENDED)).toHaveLength(0);
  expect(await f.chips(room.threadId, INTERRUPTED_LINE)).toHaveLength(0);
  expect((await f.roomView(room.id))).toMatchObject({ working: false, busyBotId: null });
  expect(nothingLive(f)).toEqual([]);
}), hostTimeout(90_000));

it("R7 a goal step the watchdog stops after it posted a credential card fails as stalled and stops the card", () => scenario(async (f) => {
  const mira = await f.bot("Mira", "Engineering");
  const room = await f.room("Engineering", [f.clive.id, mira.id], { kind: "member", botId: f.clive.id });
  f.script(f.clive.id, { key: "C-STEP", match: ["R7S-GOAL"], steps: [{ tool: "request_credential", arguments: { credential_id: "xaiApiKey", reason: "R7S fixture model" } }],
    gateFile: f.gate("step"), reply: "R7S-LATE: never shown." });
  await f.post(room, "R7S-GOAL: set up the Grok model; ask me for the key you need.", { mode: "goal" });
  const messages = (): Promise<Array<{ id: string; kind: string; secret?: { stopped?: boolean }; goalRun?: { status: string } }>> => f.messages(room.threadId);
  await expect.poll(async () => (await messages()).find((message) => message.kind === "secret")?.id, { timeout: 30_000 }).toBeTruthy();
  const card = (await messages()).find((message) => message.kind === "secret")!;
  const step = f.roomRoots(room.threadId)[0];
  expect(step).toMatchObject({ status: "running", goalRunId: expect.any(String) });
  writeFileSync(join(f.dataDir, "stall-turns"), "now");
  try { await expect.poll(() => f.roomRoots(room.threadId)[0]?.status, { timeout: 20_000 }).toBe("failed"); } finally { rmSync(join(f.dataDir, "stall-turns"), { force: true }); }
  expect(f.roomRoots(room.threadId)[0]).toMatchObject({ id: step.id, status: "failed", outcome: "stalled", executions: 1 });
  expect(f.roomRoots(room.threadId)[0].cards).toBeUndefined();
  expect((await messages()).find((message) => message.id === card.id)?.secret).toMatchObject({ stopped: true });
  // The run retries a stalled step once: that attempt ends without a decision, and so does the run.
  f.open("step");
  await expect.poll(async () => (await messages()).find((message) => message.kind === "goal.run")?.goalRun?.status, { timeout: 30_000 }).not.toBe("working");
  expect(nothingLive(f)).toEqual([]);
}, { fake: { OMB_TEST_STALL_CLOCK: "1" } }), hostTimeout(60_000));

it("R8 runs a chained @mention as a root of its own, with the hop recorded", () => scenario(async (f) => {
  const mira = await f.bot("Mira", "Engineering");
  const room = await f.room("Engineering", [f.clive.id, mira.id], { kind: "member", botId: f.clive.id });
  f.script(f.clive.id, { key: "C0", match: ["R8-JOB"], reply: "R8-CLIVE: @Mira please confirm the total." });
  f.script(mira.id, { key: "M1", match: ["R8-JOB", "R8-CLIVE"], reply: "R8-MIRA: confirmed, 42." });
  await f.post(room, "R8-JOB: what is the week's total?");
  await f.final(room.threadId, "R8-MIRA");
  await expect.poll(() => f.roomRoots(room.threadId).map((row: any) => row.status), { timeout: 15_000 }).toEqual(["completed", "completed"]);
  const [first, mentioned] = f.roomRoots(room.threadId);
  expect(first).toMatchObject({ assignee: { botId: f.clive.id }, executions: 1, result: "R8-CLIVE: @Mira please confirm the total." });
  expect(first.brief).toContain("R8-JOB");
  expect(mentioned).toMatchObject({ assignee: { botId: mira.id, destination: { kind: "room_thread", threadId: room.threadId } }, depth: 0, executions: 1,
    requester: { kind: "person", threadId: room.threadId }, origin: { kind: "person", quote: expect.stringContaining("R8-JOB") }, result: "R8-MIRA: confirmed, 42." });
  expect(mentioned.brief.startsWith("Mentioned by Clive (hop 1): R8-CLIVE"), mentioned.brief).toBe(true);
  expect(mentioned.parentId).toBeUndefined();
  expect(f.db().assignments).toHaveLength(2);
  expect(f.turns().map((record: any) => record.planKey)).toEqual(["C0", "M1"]);
  expect(nothingLive(f)).toEqual([]);
  expect((await f.roomView(room.id))).toMatchObject({ working: false, busyBotId: null });
}), hostTimeout(60_000));
