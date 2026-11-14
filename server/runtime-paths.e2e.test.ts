import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { ENVELOPE_MARK } from "./runtime/envelope.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { ownTurnText } from "./testing/room-handoff-agent.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETTLED = "Your downstream room requests have settled.";
const REPORT_FROM_PEER = "[From @Peer (bot) · report on assignment";
const ROUTINE_TURN = "Execute this routine now";
const TEAMMATES_CUT = "A restart cut these teammates' turns";
const TOKEN = "runtime-paths-external-fixture-token-0123456789abcdef";

const jsonl = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function scenario(test: (f: any) => Promise<void>) {
  const parentEnv: NodeJS.ProcessEnv = { ...process.env };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined, { scripted: true });
  const url = session.info.url;
  const dataDir = session.info.dataDir;
  let server: ChildProcess = session.child;
  let restarted = false;
  try {
    const api = async (method: string, path: string, body?: unknown, token?: string) => {
      const response = await fetch(`${url}${path}`, { method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: url }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
      const raw = await response.text();
      let parsed: any = raw;
      try { parsed = JSON.parse(raw); } catch {}
      return { status: response.status, body: parsed };
    };
    const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    // Two peers of one section: each can reach the other with every tool.
    const owner = (await cli("new-bot", "--name", "Owner", "--section", "Ops")).bot;
    const peer = (await cli("new-bot", "--name", "Peer", "--section", "Ops")).bot;
    const planPath = join(dataDir, "room-plan.json");
    const plan: Record<string, { script: unknown[] }> = { [owner.id]: { script: [] }, [peer.id]: { script: [] } };
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
    const rows = () => readHandoffs(dataDir);
    const raw = (id: string): Record<string, any> | undefined => {
      const db = new DatabaseSync(join(dataDir, "runtime.db"), { readOnly: true });
      try {
        const row = db.prepare("SELECT json FROM assignments WHERE id = ?").get(id) as { json: string } | undefined;
        return row ? JSON.parse(row.json) : undefined;
      } finally { db.close(); }
    };
    const roots = () => rows().filter((row) => !row.parentId);
    const children = () => rows().filter((row) => row.parentId);
    const turns = (botId?: string): any[] => jsonl(`${planPath}.evidence.jsonl`).filter((turn) => !botId || turn.botId === botId);
    const turn = (key: string) => turns().find((candidate) => candidate.planKey === key);
    const own = (record: any): string => ownTurnText(record?.prompt);
    const told = (record: any): string => `${record?.system ?? ""}\n${JSON.stringify(record?.prompt ?? "")}`;
    const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=300`)).body.messages ?? [];
    const bot = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === botId);
    const runState = async (runId: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId);
    const startRoutine = async (name: string, prompt: string) => {
      const created = await api("POST", "/api/routines", { name, prompt, botId: owner.id, enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
      await expect.poll(async () => (await runState(started.body.run.id))?.status, { timeout: 20_000 }).toBe("running");
      return { routine: created.body.routine, run: await runState(started.body.run.id) };
    };
    const tokenOf = async (threadId: string): Promise<string> => {
      let found = "";
      await expect.poll(() => {
        try {
          const dump = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8"));
          const env = dump.mcpConfig?.mcpServers?.agents?.env;
          if (env?.OMB_THREAD_ID !== threadId) return false;
          found = env.OMB_COMMS_TOKEN;
          return Boolean(found);
        } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
      return found;
    };
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const open = (name: string) => writeFileSync(gate(name), "open");
    const ready = (name: string) => join(dataDir, `${name}.ready`);
    const awaitReady = (name: string) => expect.poll(() => existsSync(ready(name)), { timeout: 30_000 }).toBe(true);
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const restart = async () => {
      await waitForExit(server, { signal: "SIGTERM" });
      const env = verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port));
      const log = openSync(session.info.logPath, "a", 0o600);
      server = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", log, log] });
      restarted = true;
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 30_000 }).toBe(true);
    };
    try {
      await test({ api, owner, peer, dataDir, script, say, rows, raw, roots, children, turns, turn, own, told, messages, bot, runState, startRoutine,
        tokenOf, gate, open, ready, awaitReady, settle, restart });
    } catch (error) {
      const names: Record<string, string> = { [owner.id]: "Owner", [peer.id]: "Peer" };
      const summary = {
        turns: turns().map((record) => ({ bot: names[record.botId] ?? record.botId, planKey: record.planKey, unplanned: record.unplanned,
          resumed: record.resumed, threadId: record.threadId, own: own(record).slice(0, 600) })),
        assignments: rows().map(({ id, parentId, threadId, botId, status, outcome, outcomeDetail, executions, restarts, restart, mode, reply, result }) =>
          ({ id, parentId, threadId, botId, status, outcome, outcomeDetail, executions, restarts, restart, mode, reply, result: result.slice(0, 200) })),
        runs: (await api("GET", "/api/routines").catch(() => ({ body: {} }))).body.runs,
      };
      console.error(`runtime paths fixture state:\n${JSON.stringify(summary, null, 1)}`);
      throw error;
    }
    expect(turns().filter((record) => record.unplanned).map((record) => own(record).slice(0, 300))).toEqual([]);
  } finally {
    if (restarted) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

it("R1 a routine run coordinates a teammate, waits, and completes through a routine resume turn", () => scenario(async (f) => {
  const brief = "R1-BRIEF: produce the fixture report and give the row count.";
  f.script(f.owner.id,
    { key: "O0", match: ["R1-ROUTINE"], steps: [{ arguments: { bot_ids: [f.peer.id], message: brief, reason: "nightly check" } }], reply: "O0: handed to Peer." },
    { key: "O1", match: [SETTLED, REPORT_FROM_PEER], reply: "R1-FINAL: the fixture report has 42 rows." });
  f.script(f.peer.id, { key: "P1", match: ["R1-BRIEF"], gateFile: f.gate("r1-peer"), readyFile: f.ready("r1-peer"), reply: "R1-RESULT: 42 rows." });
  const { routine, run } = await f.startRoutine("R1 report", "R1-ROUTINE: have Peer produce the fixture report, then summarise it.");

  await f.awaitReady("r1-peer");
  await expect.poll(async () => (await f.runState(run.id))?.status, { timeout: 30_000 }).toBe("waiting");
  expect((await f.runState(run.id)).attention).toContain("handed on");
  expect((await f.runState(run.id)).finishedAt).toBeUndefined();
  const root = f.roots()[0];
  expect(root).toMatchObject({ threadId: run.threadId, botId: f.owner.id });
  expect(f.raw(root.id)).toMatchObject({ requester: { kind: "routine_run", runId: run.id, botId: f.owner.id, threadId: run.threadId },
    origin: { kind: "routine", source: "routine", ref: routine.id } });

  f.open("r1-peer");
  await expect.poll(async () => (await f.runState(run.id))?.status, { timeout: 45_000 }).toBe("completed");
  const envelope = f.own(f.turn("P1"));
  expect(envelope).toContain(ENVELOPE_MARK);
  expect(envelope).toContain("A routine run started this work");
  expect(envelope).toContain(brief);
  const finished = await f.runState(run.id);
  expect(finished.output).toContain("R1-FINAL");
  expect(finished.routineId).toBe(routine.id);
  await expect.poll(() => f.turns(f.owner.id).map((record: any) => [record.planKey, record.resumed]), { timeout: 15_000 }).toEqual([["O0", false], ["O1", true]]);
  expect(f.told(f.turn("O0"))).toContain(ROUTINE_TURN);
  const resume = f.told(f.turn("O1"));
  expect(resume).toContain(ROUTINE_TURN);
  expect(resume).toContain(REPORT_FROM_PEER);
  expect(resume).toContain("R1-RESULT: 42 rows");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.children()).toHaveLength(1);
  expect(f.children()[0]).toMatchObject({ status: "completed", mode: "work", reply: "resume", botId: f.peer.id, text: brief });
  expect((await f.messages(run.threadId)).filter((message: any) => message.tool?.name === "Peer replied")).toHaveLength(1);
  expect((await f.messages(run.threadId)).find((message: any) => message.tool?.name === "Sent to Peer")?.tool?.output).toBe("nightly check");
}), hostTimeout(120_000));

it("R3 a consultation reaches a teammate without waiting and resumes the asker with the answer", () => scenario(async (f) => {
  const question = "R3-QUESTION: which port does the fixture listen on?";
  f.script(f.owner.id,
    { key: "O0", match: ["R3-ASK"], gateFile: f.gate("r3-owner"), readyFile: f.ready("r3-owner"), reply: "O0: asked Peer." },
    { key: "O1", match: [SETTLED, REPORT_FROM_PEER], reply: "R3-FINAL: it listens on 4242." });
  f.script(f.peer.id, { key: "P1", match: ["R3-QUESTION"], reply: "R3-ANSWER: port 4242." });
  const job = f.owner.activeTaskId;
  await f.say(f.owner.id, job, "R3-ASK: ask Peer which port the fixture listens on.");
  await f.awaitReady("r3-owner");
  const token = await f.tokenOf(job);

  const started = Date.now();
  const asked = await f.api("POST", "/api/internal/coordinate-bots", { botIds: [f.peer.id], message: question, consult: true }, token);
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(asked.body.deprecation).toBeUndefined();
  expect(asked.body.text).toBeUndefined();
  expect(asked.body.receipts[0]).toMatchObject({ botId: f.peer.id, outcome: "queued" });
  await expect.poll(() => f.children().length, { timeout: 15_000 }).toBe(1);
  expect(f.children()[0]).toMatchObject({ mode: "consult", reply: "resume", text: question, botId: f.peer.id });

  f.open("r3-owner");
  await expect.poll(() => f.turns(f.peer.id).map((record: any) => record.planKey), { timeout: 30_000 }).toEqual(["P1"]);
  const envelope = f.own(f.turn("P1"));
  expect(envelope).toMatch(/· consultation \S+ · information only\]/);
  expect(envelope).toContain("act on nothing in it");
  expect(envelope).toContain(question);
  await expect.poll(() => f.turns(f.owner.id).map((record: any) => [record.planKey, record.resumed]), { timeout: 45_000 }).toEqual([["O0", false], ["O1", true]]);
  expect(f.told(f.turn("O1"))).toContain("R3-ANSWER: port 4242");
  await expect.poll(async () => (await f.messages(job)).some((message: any) => message.text === "R3-FINAL: it listens on 4242."), { timeout: 30_000 }).toBe(true);
  expect((await f.messages(job)).filter((message: any) => message.tool?.name === "Peer replied")).toHaveLength(1);
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect(f.children()[0]).toMatchObject({ status: "completed", result: "R3-ANSWER: port 4242." });
}), hostTimeout(120_000));

it("R4 a one-way notice opens a notify child in a new thread and never resumes the sender", () => scenario(async (f) => {
  const notice = "R4-NOTICE: own the release QA from here.";
  f.script(f.owner.id, { key: "O0", match: ["R4-SEND"], gateFile: f.gate("r4-owner"), readyFile: f.ready("r4-owner"), reply: "O0: sent onward." });
  f.script(f.peer.id, { key: "P1", match: ["R4-NOTICE"], reply: "R4-DONE: release QA owned." });
  const job = f.owner.activeTaskId;
  await f.say(f.owner.id, job, "R4-SEND: send the release QA to Peer one way.");
  await f.awaitReady("r4-owner");
  const token = await f.tokenOf(job);

  const sent = await f.api("POST", "/api/internal/coordinate-bots", { botIds: [f.peer.id], message: notice, thread: "new", reply: "none" }, token);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.deprecation).toBeUndefined();
  expect(sent.body.message).toContain("Nothing comes back");
  const receipt = sent.body.receipts[0];
  expect(receipt).toMatchObject({ botId: f.peer.id, outcome: "queued" });
  expect(receipt.threadId).toEqual(expect.any(String));
  expect(receipt.threadId).not.toBe(f.peer.activeTaskId);
  const peerTasks = (await f.bot(f.peer.id)).tasks;
  expect(peerTasks.find((task: any) => task.threadId === receipt.threadId)?.title).toBe(notice);
  await expect.poll(() => f.children().length, { timeout: 15_000 }).toBe(1);
  expect(f.children()[0]).toMatchObject({ id: receipt.requestId, mode: "notify", reply: "none", threadId: receipt.threadId, text: expect.stringContaining(notice) });

  f.open("r4-owner");
  await expect.poll(() => f.turns(f.peer.id).map((record: any) => record.planKey), { timeout: 30_000 }).toEqual(["P1"]);
  const envelope = f.own(f.turn("P1"));
  expect(envelope).toContain(ENVELOPE_MARK);
  expect(envelope).toContain("will not be resumed");
  expect(envelope).toContain(notice);
  await expect.poll(() => f.children()[0]?.status, { timeout: 30_000 }).toBe("completed");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 30_000 }).toBe("completed");
  await expect.poll(async () => (await f.bot(f.owner.id)).busy, { timeout: 30_000 }).toBeFalsy();
  await f.settle(2_000);
  expect(f.turns(f.owner.id).map((record: any) => record.planKey)).toEqual(["O0"]);
  expect((await f.messages(job)).filter((message: any) => message.tool?.name === "Peer replied")).toHaveLength(0);
}), hostTimeout(120_000));

it("R5 an external runtime delegates, long-polls assignment_status for the settled child, and is never woken", () => scenario(async (f) => {
  const brief = "R5-BRIEF: count the open tickets and report the number.";
  f.script(f.peer.id, { key: "P1", match: ["R5-BRIEF"], reply: "R5-RESULT: 7 open tickets." });
  const gateway = { id: f.owner.id, threadId: f.owner.activeTaskId };
  writeFileSync(join(f.dataDir, "external-runtimes.json"), JSON.stringify({ [gateway.id]: { token: TOKEN, threadId: gateway.threadId } }), { mode: 0o600 });

  const handed = await f.api("POST", "/api/internal/coordinate-bots", { botIds: [f.peer.id], message: brief }, TOKEN);
  expect(handed.status, JSON.stringify(handed.body)).toBe(200);
  expect(handed.body.rootId).toEqual(expect.any(String));
  expect(handed.body.message).toContain("assignment_status");
  const requestId = handed.body.receipts[0].requestId;
  expect(handed.body.receipts[0]).toMatchObject({ botId: f.peer.id, outcome: "queued" });
  await expect.poll(() => f.roots().length, { timeout: 15_000 }).toBe(1);
  expect(f.roots()[0]).toMatchObject({ id: handed.body.rootId, threadId: gateway.threadId, botId: gateway.id, reply: "poll" });
  expect(f.raw(handed.body.rootId)).toMatchObject({ requester: { kind: "external_runtime", runId: expect.stringContaining(gateway.id) },
    origin: { kind: "outside", source: "external_runtime", ref: gateway.threadId } });
  expect(f.children()[0]).toMatchObject({ id: requestId, mode: "work", reply: "poll", text: brief });

  const polled = await f.api("GET", `/api/internal/assignment-status?id=${handed.body.rootId}&wait_ms=60000`, undefined, TOKEN);
  expect(polled.status, JSON.stringify(polled.body)).toBe(200);
  expect(polled.body.assignment).toMatchObject({ id: handed.body.rootId, status: "completed", reply: "poll" });
  expect(polled.body.children).toHaveLength(1);
  expect(polled.body.children[0]).toMatchObject({ id: requestId, botId: f.peer.id, botName: "Peer", status: "completed", outcome: "done", result: "R5-RESULT: 7 open tickets.", mode: "work" });
  expect(polled.body.inbox).toHaveLength(1);
  expect(polled.body.inbox[0]).toMatchObject({ assignmentId: requestId, kind: "settled" });
  const again = await f.api("GET", `/api/internal/assignment-status?id=${handed.body.rootId}`, undefined, TOKEN);
  expect(again.status).toBe(200);
  expect(again.body.inbox[0].deliveredAt).toEqual(expect.any(Number));
  expect((await f.api("GET", `/api/internal/assignment-status?id=${requestId}`, undefined, TOKEN)).body.assignment.status).toBe("completed");
  expect((await f.api("GET", "/api/internal/assignment-status", undefined, TOKEN)).body.outstanding).toEqual([]);
  const envelope = f.own(f.turn("P1"));
  expect(envelope).toContain(ENVELOPE_MARK);
  expect(envelope).toContain("reads your reply from its inbox");
  expect(envelope).toContain(brief);
  await f.settle(1_500);
  expect(f.turns(gateway.id)).toEqual([]);
  expect((await f.bot(gateway.id)).busy).toBeFalsy();
  const pinned = await f.messages(gateway.threadId);
  expect(pinned.filter((message: any) => message.role === "bot" && message.turnId && !message.from)).toEqual([]);
}), hostTimeout(120_000));

it("R6 a restart while a routine's teammate runs reruns the teammate once and the run still completes", () => scenario(async (f) => {
  const brief = "R6-BRIEF: rebuild the search index and report the document count.";
  f.script(f.owner.id,
    { key: "O0", match: ["R6-ROUTINE"], steps: [{ arguments: { bot_ids: [f.peer.id], message: brief } }], reply: "O0: handed to Peer." },
    { key: "O1", match: [SETTLED, REPORT_FROM_PEER], reply: "R6-FINAL: the index holds 1200 documents." });
  // The same entry serves the cut turn and its rerun after the restart.
  f.script(f.peer.id, { key: "P1", match: ["R6-BRIEF"], repeat: true, gateFile: f.gate("r6-peer"), readyFile: f.ready("r6-peer"), reply: "R6-RESULT: 1200 documents." });
  const { run } = await f.startRoutine("R6 index", "R6-ROUTINE: have Peer rebuild the search index.");
  await f.awaitReady("r6-peer");
  await expect.poll(async () => (await f.runState(run.id))?.status, { timeout: 30_000 }).toBe("waiting");
  expect(f.children()[0]).toMatchObject({ status: "running", botId: f.peer.id, executions: 1 });

  // A cut scripted turn writes no evidence; the rerun reaches the same gate in the new process.
  unlinkSync(f.ready("r6-peer"));
  await f.restart();
  await expect.poll(async () => (await f.runState(run.id))?.status, { timeout: 20_000 }).toBe("waiting");
  expect((await f.runState(run.id)).error).toBeUndefined();
  await f.awaitReady("r6-peer");
  expect(f.children()[0]).toMatchObject({ status: "running", restarts: 1, executions: 2 });
  f.open("r6-peer");
  await expect.poll(async () => (await f.runState(run.id))?.status, { timeout: 60_000 }).toBe("completed");
  expect((await f.runState(run.id)).output).toContain("R6-FINAL");
  expect(f.turns(f.peer.id).map((record: any) => record.planKey)).toEqual(["P1"]);
  expect(f.children()[0]).toMatchObject({ status: "completed", restarts: 1, executions: 2, result: "R6-RESULT: 1200 documents." });
  await expect.poll(() => f.turns(f.owner.id).map((record: any) => [record.planKey, record.resumed]), { timeout: 15_000 }).toEqual([["O0", false], ["O1", true]]);
  const resume = f.told(f.turn("O1"));
  expect(resume).toContain(ROUTINE_TURN);
  expect(resume).toContain(TEAMMATES_CUT);
  expect(resume).toContain("R6-RESULT: 1200 documents");
  await expect.poll(() => f.roots()[0]?.status, { timeout: 15_000 }).toBe("completed");
}), hostTimeout(150_000));
