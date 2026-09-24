// Real provider processes with independent per-thread gates, under the same
// disposable-home launcher used by the independent-threads API fixture.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

describe("per-bot thread capacity through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  let model: string;
  let evidence: unknown[];
  const sockets: Socket[] = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result });
    return result;
  };
  const botState = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as any[];
  const threadFile = (threadId: string, extension: string) => join(fixture.info.dataDir, `${threadId}.${extension}`);
  const dump = async (threadId: string) => {
    let snapshot: any;
    await expect.poll(() => {
      try {
        // The CLI writes in another process: existence alone can observe an
        // empty or partial file between open() and its completed write.
        snapshot = JSON.parse(readFileSync(threadFile(threadId, "json"), "utf8"));
        return true;
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }, { timeout: 15_000 }).toBe(true);
    return snapshot;
  };
  const finish = (threadId: string) => writeFileSync(threadFile(threadId, "gate"), "finish this isolated turn");
  const busyThreads = async (botId: string) => (await botState(botId)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId) as string[];
  const send = (botId: string, threadId: string, text: string, sendId?: string) => api("POST", `/api/bots/${botId}/messages`, { threadId, text, sendId });
  const limit = async (maxConcurrentPerBot: number) => {
    const result = await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot } });
    expect(result.status).toBe(200);
    expect(result.body.threads).toEqual({ maxConcurrentPerBot });
    return result;
  };
  const botWithThreads = async (count: number) => {
    const created = await api("POST", "/api/bots", { name: "Capacity fixture", modelSelection: { instanceId: "claude", model } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const threads = [bot.threadId as string];
    for (let i = 1; i < count; i++) {
      const createdTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: `Capacity thread ${i + 1}` });
      expect(createdTask.status).toBe(201);
      threads.push(createdTask.body.task.threadId);
    }
    return { botId: bot.id as string, threads };
  };
  const capabilityStatus = async (launched: any) => {
    const response = await fetch(`${fixture.info.url}/api/internal/agents`, {
      headers: { authorization: `Bearer ${launched.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN}` },
    });
    await response.arrayBuffer();
    // The evidence records the authorization result, never the bearer token.
    evidence.push({ authority: "existing provider capability", path: "/api/internal/agents", status: response.status, pid: launched.pid });
    return response.status;
  };
  const permission = async (threadId: string, requestId: string) => {
    const launched = await dump(threadId);
    const socket = connect(launched.mcpConfig.mcpServers.ogb.args.at(-1));
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const answers: any[] = [];
    createInterface({ input: socket }).on("line", (line) => answers.push(JSON.parse(line)));
    socket.write(`${JSON.stringify({ t: "ask", id: requestId, kind: "permission", tool: "Bash", input: { command: "ls -la ./dist" } })}\n`);
    return answers;
  };

  beforeEach(async () => {
    evidence = [];
    fixture = await launchVerificationServer();
    const wrapper = join(fixture.info.dataDir, "capacity-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { basename, join } from "node:path";',
      'const thread = basename(process.cwd());',
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      'process.env.OMB_FIXTURE_CWD = process.cwd();',
      'process.env.OMB_FIXTURE_LAUNCHED_AT = String(Date.now());',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".gate");`,
      `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".json");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
    const instance = (await api("GET", "/api/instances")).body.instances.find((candidate: any) => candidate.instanceId === "claude");
    model = instance.models.options[0].id;
  }, 30_000);

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.capacity.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
  });

  it("defaults to three, runs ten real turns after raising the limit, and safely queues and cancels overflow", async () => {
    expect((await api("GET", "/api/config")).body.threads).toEqual({ maxConcurrentPerBot: 3 });
    for (const maxConcurrentPerBot of [0, 11, 1.5, "2", null]) {
      expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot } })).status).toBe(400);
    }
    expect((await api("GET", "/api/config")).body.threads.maxConcurrentPerBot).toBe(3);
    const { botId, threads } = await botWithThreads(12);
    const firstThree = await Promise.all(threads.slice(0, 3).map((threadId, i) => send(botId, threadId, `ACTIVE_${i}`)));
    expect(firstThree.map((result) => result.status)).toEqual([202, 202, 202]);
    expect(firstThree.every((result) => !result.body.queued)).toBe(true);
    const initialProcesses = await Promise.all(threads.slice(0, 3).map(dump));
    expect(await busyThreads(botId)).toHaveLength(3);
    const fourth = await send(botId, threads[3], "FOURTH_AFTER_RAISE", "capacity_default_fourth");
    expect(fourth.status).toBe(202);
    expect(fourth.body).toMatchObject({ queued: true, reason: "capacity", threadId: threads[3] });
    expect((await messages(threads[3])).filter((message) => message.role === "user")).toEqual([]);
    expect(existsSync(threadFile(threads[3], "json"))).toBe(false);

    await limit(10);
    await dump(threads[3]);
    const rest = await Promise.all(threads.slice(4, 10).map((threadId, i) => send(botId, threadId, `ACTIVE_${i + 4}`)));
    expect(rest.every((result) => result.status === 202 && !result.body.queued)).toBe(true);
    const launched = await Promise.all(threads.slice(0, 10).map(dump));
    expect(new Set(launched.map((entry) => entry.pid)).size).toBe(10);
    expect(new Set(launched.map((entry) => entry.env.OMB_FIXTURE_CWD)).size).toBe(10);
    expect(launched.every((entry) => entry.argv[entry.argv.indexOf("--model") + 1] === model)).toBe(true);
    expect(await busyThreads(botId)).toHaveLength(10);
    for (const process of initialProcesses) expect(await capabilityStatus(process)).toBe(200);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).threads).toEqual({ maxConcurrentPerBot: 10 });
    evidence.push({ simultaneousProviderProcesses: launched.map((entry) => ({ pid: entry.pid, cwd: entry.env.OMB_FIXTURE_CWD })), model });

    const overflow = await send(botId, threads[10], "ELEVENTH_WAITING", "capacity_eleventh_retry");
    expect(overflow.status).toBe(202);
    expect(overflow.body).toMatchObject({ queued: true, reason: "capacity", threadId: threads[10], queueId: expect.any(String) });
    expect((await send(botId, threads[10], "ELEVENTH_WAITING", "capacity_eleventh_retry")).body).toEqual(overflow.body);
    expect((await send(botId, threads[10], "CONFLICTING_RETRY", "capacity_eleventh_retry")).status).toBe(409);
    expect((await messages(threads[10])).filter((message) => message.role === "user")).toEqual([]);
    expect(existsSync(threadFile(threads[10], "json"))).toBe(false);
    const cancelled = await send(botId, threads[11], "TWELFTH_CANCELLED", "capacity_twelfth_cancel");
    expect(cancelled.body).toMatchObject({ queued: true, reason: "capacity" });
    expect((await api("DELETE", `/api/bots/${botId}/queue/${cancelled.body.queueId}`, { threadId: threads[10] })).status).toBe(404);
    expect((await api("DELETE", `/api/bots/${botId}/queue/${cancelled.body.queueId}`, { threadId: threads[11] })).status).toBe(200);

    const other = await botWithThreads(1);
    expect((await send(other.botId, other.threads[0], "OTHER_BOT_INDEPENDENT")).body.queued).toBeUndefined();
    await dump(other.threads[0]);
    expect(await busyThreads(other.botId)).toEqual(other.threads);
    expect(await busyThreads(botId)).toHaveLength(10);

    finish(threads[0]);
    await dump(threads[10]);
    await expect.poll(() => busyThreads(botId)).toHaveLength(10);
    const drained = (await messages(threads[10])).filter((message) => message.role === "user");
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ text: "ELEVENTH_WAITING", sendId: "capacity_eleventh_retry", queueId: overflow.body.queueId });
    expect((await messages(threads[11])).filter((message) => message.role === "user")).toEqual([]);
    expect(existsSync(threadFile(threads[11], "json"))).toBe(false);
    for (const threadId of [...threads.slice(1, 11), ...other.threads]) finish(threadId);
    await expect.poll(() => busyThreads(botId), { timeout: 10_000 }).toEqual([]);
    await expect.poll(() => busyThreads(other.botId), { timeout: 10_000 }).toEqual([]);
    expect(existsSync(threadFile(threads[11], "json"))).toBe(false);
  }, 60_000);

  it("dispatches routines into a free slot without waiting for whole-bot idle", async () => {
    await limit(2);
    const { botId, threads } = await botWithThreads(2);
    expect((await send(botId, threads[0], "HOLD_ONE_SLOT")).body.queued).toBeUndefined();
    await dump(threads[0]);
    expect(await busyThreads(botId)).toEqual([threads[0]]);
    const created = await api("POST", "/api/routines", {
      name: "Slot dispatch probe",
      prompt: "Write the scheduled digest.",
      target: "bot",
      botId,
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const runState = async (id: string) =>
      (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
    try {
      // One busy thread, one free slot: the run must start now instead of
      // waiting for the bot to become fully idle.
      const first = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      await expect.poll(async () => (await runState(first.id))?.status, { timeout: 15_000 }).toBe("running");
      const firstRun = await runState(first.id);
      expect(firstRun.threadId).toBeTruthy();
      expect(firstRun.threadId).not.toBe(threads[0]);
      await dump(firstRun.threadId);
      expect(await busyThreads(botId)).toHaveLength(2);
      // Whole-bot idleness is no longer the gate: the bot flag stays busy
      // while the scheduled run occupies the second slot.
      expect((await botState(botId)).busy).toBe(true);
      // At capacity the next run defers until a slot frees.
      const second = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await runState(second.id))?.status).toBe("queued");
      finish(threads[0]);
      await expect.poll(async () => (await runState(second.id))?.status, { timeout: 15_000 }).toBe("running");
      const secondRun = await runState(second.id);
      expect(secondRun.threadId).not.toBe(firstRun.threadId);
      await dump(secondRun.threadId);
    } finally {
      for (const threadId of await busyThreads(botId)) finish(threadId);
      await expect.poll(async () => (await busyThreads(botId)).length, { timeout: 15_000 }).toBe(0);
      await api("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
    }
  }, 90_000);

  it("holds routine runs behind an active group turn and starts them once it ends", async () => {
    const { botId } = await botWithThreads(1);
    const createdRoom = await api("POST", "/api/groups", {
      name: "Routine gate room",
      memberIds: [botId],
      setup: { bulletin: "Answer briefly.", defaultResponder: { kind: "member", botId } },
    });
    expect(createdRoom.status).toBe(201);
    const room = createdRoom.body.group;
    const created = await api("POST", "/api/routines", {
      name: "Group gate probe",
      prompt: "Write the deferred digest.",
      target: "bot",
      botId,
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const runState = async (id: string) =>
      (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
    const roomWorking = async () =>
      (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === room.id)?.working;
    try {
      const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "Hold the room turn open." });
      expect(sent.status).toBe(202);
      expect(sent.body.queued).toBeUndefined();
      // Room turns run in the member's shared workspace, so the gated fake
      // provider dumps and holds under the bot id, not the room thread id.
      await dump(botId);
      await expect.poll(roomWorking, { timeout: 15_000 }).toBe(true);
      const run = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      // An active group turn blocks scheduled starts the same way it blocks
      // every other turn kind, even with every capacity slot free: across
      // scheduler ticks the run stays queued — deferred, not failed.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      const held = await runState(run.id);
      expect(held?.status).toBe("queued");
      expect(held?.deferredAt).toEqual(expect.any(Number));
      // Ending the room turn releases the run into a thread of its own.
      finish(botId);
      await expect.poll(roomWorking, { timeout: 15_000 }).toBe(false);
      await expect.poll(async () => (await runState(run.id))?.status, { timeout: 20_000 }).toBe("running");
      const started = await runState(run.id);
      expect(started.threadId).toBeTruthy();
      expect(started.threadId).not.toBe(room.threadId);
      await dump(started.threadId);
    } finally {
      finish(room.threadId);
      for (const threadId of await busyThreads(botId)) finish(threadId);
      await expect.poll(async () => (await busyThreads(botId)).length, { timeout: 15_000 }).toBe(0);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
    }
  }, 120_000);

  it("dispatches delegated handoffs into the standing thread without waiting for whole-bot idle", async () => {
    await limit(2);
    const target = await botWithThreads(2);
    const source = await botWithThreads(1);
    const created = await api("POST", "/api/routines", {
      name: "Delegated slot probe",
      prompt: "Hold the delegator turn.",
      target: "bot",
      botId: source.botId,
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const runState = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
    // A routine turn is today's classic delegate_bot caller — a plain chat
    // turn is steered to coordinate_bots — and its held turn supplies the
    // internal comms capability that caller holds.
    const delegatorTurn = async () => {
      const run = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("running");
      const started = await runState(run.id);
      const launched = await dump(started.threadId);
      return { runId: run.id as string, threadId: started.threadId as string, token: launched.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string };
    };
    const delegate = async (turn: { threadId: string; token: string }) => {
      const response = await fetch(`${fixture.info.url}/api/internal/delegate-bot`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${turn.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ toBotId: target.botId, message: "Delegated slot probe" }),
      });
      const result = { status: response.status, body: await response.json() as any };
      // The evidence records the authorization result, never the bearer.
      evidence.push({ authority: "existing provider capability", path: "/api/internal/delegate-bot", threadId: turn.threadId, result });
      return result;
    };
    // The woken delegator's reply echoes the prompt its provider received.
    // Read it from the conversation, not the run record: a run keeps only
    // the first 2,000 characters of its output, and the replayed history
    // ahead of the notice (the teammate's echoed reply now includes its
    // in-turn context note) runs past that. The notice must be the latest
    // thing the delegator was told, after the teammate's reply.
    const expectWokenByCompletion = async (turn: { runId: string; threadId: string }) => {
      const replies = (await messages(turn.threadId)).filter((message) => message.role === "bot" && message.kind === "text");
      const reply = String(replies.at(-1)?.text ?? "");
      // the run recorded this same wake reply
      expect(reply.startsWith((await runState(turn.runId)).output)).toBe(true);
      const peerReply = reply.indexOf("@Capacity fixture replied to the delegated task");
      const notice = reply.lastIndexOf("[A delegated task just completed]");
      expect(peerReply).toBeGreaterThan(-1);
      expect(notice).toBeGreaterThan(peerReply);
      expect(reply.slice(notice)).toMatch(/^\[A delegated task just completed\]\n\nThe task you delegated to @Capacity fixture has finished, and their reply is now in this conversation\.\n\n[^]*Do not re-delegate the same task\.$/);
    };
    try {
      // One busy thread, one free slot: when the delegator's turn settles
      // and the handoff drains, it must land in the target's standing
      // thread — its newest task thread — instead of waiting for the whole
      // bot to go idle. Every turn here, including the agentless delegated
      // one, runs from its thread's task folder, so the fixture's shared
      // cwd-keyed gates cover them all.
      expect((await send(target.botId, target.threads[0], "HOLD_ONE_SLOT")).body.queued).toBeUndefined();
      await dump(target.threads[0]);
      expect(await busyThreads(target.botId)).toEqual([target.threads[0]]);
      expect((await botState(target.botId)).busy).toBe(true);

      const first = await delegatorTurn();
      const queued = await delegate(first);
      expect(queued.status).toBe(200);
      expect(queued.body).toMatchObject({ queued: true, taskId: expect.any(String) });
      finish(first.threadId);
      await dump(target.threads[1]);
      // The busy list orders by recent activity, not thread creation.
      expect((await busyThreads(target.botId)).sort()).toEqual([...target.threads].sort());
      expect((await botState(target.botId)).busy).toBe(true);

      // Standing thread busy and capacity full: the next handoff holds with
      // a visible wait instead of dispatching.
      const second = await delegatorTurn();
      const held = await delegate(second);
      expect(held.body).toMatchObject({ queued: true, taskId: expect.any(String) });
      finish(second.threadId);
      await expect.poll(async () => (await runState(second.runId))?.status, { timeout: 15_000 }).toBe("waiting");
      expect((await messages(second.threadId)).some((message) => message.kind === "activity" && message.tool?.name?.includes("waiting — they're busy"))).toBe(true);
      expect((await busyThreads(target.botId)).sort()).toEqual([...target.threads].sort());

      // The standing thread frees while the other stays busy: the held
      // handoff re-tests its own admission and moves — the whole-bot busy
      // flag is never the gate. Its turn lands in the just-freed thread,
      // whose gate is already down, so it settles and wakes the delegator.
      finish(target.threads[1]);
      await expect.poll(async () => (await runState(second.runId))?.status, { timeout: 20_000 }).toBe("completed");
      expect(await busyThreads(target.botId)).toEqual([target.threads[0]]);
      await expectWokenByCompletion(second);
      await expect.poll(async () => (await runState(first.runId))?.status, { timeout: 15_000 }).toBe("completed");
      await expectWokenByCompletion(first);
    } finally {
      for (const bot of [target, source]) {
        for (const threadId of await busyThreads(bot.botId)) finish(threadId);
      }
      await expect.poll(async () => (await busyThreads(target.botId)).length + (await busyThreads(source.botId)).length, { timeout: 15_000 }).toBe(0);
      await api("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${target.botId}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${source.botId}`).catch(() => undefined);
    }
  }, 150_000);

  it("restores cancellable queued receipts from a fresh snapshot and broadcasts complete queue changes", async () => {
    await limit(1);
    const { botId, threads: [active, waiting, cancelled, deleted] } = await botWithThreads(4);
    expect((await send(botId, active, "ACTIVE_DURING_RELOAD")).body.queued).toBeUndefined();
    await dump(active);
    const events = await openSse(`${fixture.info.url}/api/events`);
    try {
      const queued = await send(botId, waiting, "RESTORE_AFTER_RELOAD", "reload_queue_receipt");
      expect(queued.body).toMatchObject({ queued: true, reason: "capacity", threadId: waiting });
      const receipt = { queueId: queued.body.queueId, text: "RESTORE_AFTER_RELOAD", reason: "capacity" };
      expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages).toEqual({ [waiting]: [receipt] });
      const enqueued = await events.until((frame) => frame.kind === "bot.queued" && frame.queues[waiting]?.[0]?.queueId === receipt.queueId);
      expect(enqueued.queues).toEqual({ [waiting]: [receipt] });
      const cancelReceipt = (await send(botId, cancelled, "CANCEL_AFTER_RELOAD")).body;
      const restored = (await api("GET", "/api/bots")).body.botQueuedMessages;
      expect(restored[cancelled]).toEqual([{ queueId: cancelReceipt.queueId, text: "CANCEL_AFTER_RELOAD", reason: "capacity" }]);
      expect((await api("DELETE", `/api/bots/${botId}/queue/${restored[cancelled][0].queueId}`, { threadId: waiting })).status).toBe(404);
      expect((await api("DELETE", `/api/bots/${botId}/queue/${restored[cancelled][0].queueId}`, { threadId: cancelled })).status).toBe(200);
      const removed = await events.until((frame) => frame.kind === "bot.queued" && frame.seq > enqueued.seq + 1 && !frame.queues[cancelled]);
      expect(removed.queues).toEqual({ [waiting]: [receipt] });
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({ [waiting]: [receipt] });

      await send(botId, deleted, "DELETE_QUEUED_TASK");
      const beforeDelete = await events.until((frame) => frame.kind === "bot.queued" && frame.queues[deleted]?.length);
      expect((await api("DELETE", `/api/bots/${botId}/tasks/${deleted}`)).status).toBe(200);
      expect((await events.until((frame) => frame.kind === "bot.queued" && frame.seq > beforeDelete.seq && !frame.queues[deleted])).queues).toEqual({ [waiting]: [receipt] });
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({ [waiting]: [receipt] });

      finish(active);
      await dump(waiting);
      expect((await events.until((frame) => frame.kind === "bot.queued" && frame.seq > beforeDelete.seq && Object.keys(frame.queues).length === 0)).queues).toEqual({});
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({});
      expect((await messages(waiting)).filter((message) => message.role === "user")).toEqual([
        expect.objectContaining({ text: receipt.text, queueId: receipt.queueId }),
      ]);
      expect((await messages(cancelled)).filter((message) => message.role === "user")).toEqual([]);
      expect(existsSync(threadFile(cancelled, "json"))).toBe(false);
      expect(existsSync(threadFile(deleted, "json"))).toBe(false);
      finish(waiting);
      await expect.poll(() => busyThreads(botId)).toEqual([]);
      evidence.push({ queueEvents: events.frames.filter((frame) => frame.kind === "bot.queued") });
    } finally { events.close(); }
  }, 30_000);

  it("counts approval waits, drains FIFO when raised or a turn finishes, and preserves active work when lowered", async () => {
    await limit(1);
    const { botId, threads: [first, second, third, fourth] } = await botWithThreads(4);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${first}`, { approvalMode: "ask" })).status).toBe(200);
    expect((await send(botId, first, "APPROVAL_HOLDS_SLOT")).body.queued).toBeUndefined();
    const launchedFirst = await dump(first);
    const answers = await permission(first, "capacity-approval");
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.threadId === first).activity).toBe("waiting-on-you");
    expect(await busyThreads(botId)).toEqual([first]);
    const queued = [];
    for (const [index, threadId] of [second, third, fourth].entries()) {
      const result = await send(botId, threadId, `FIFO_${index + 1}`, `capacity_fifo_send_${index + 1}`);
      expect(result.body).toMatchObject({ queued: true, reason: "capacity" });
      queued.push(result.body.queueId);
      expect((await messages(threadId)).filter((message) => message.role === "user")).toEqual([]);
      expect(existsSync(threadFile(threadId, "json"))).toBe(false);
    }
    expect(answers).toEqual([]);

    await limit(2);
    const launchedSecond = await dump(second);
    await expect.poll(() => busyThreads(botId)).toHaveLength(2);
    expect(await capabilityStatus(launchedFirst)).toBe(200);
    expect((await botState(botId)).tasks.find((task: any) => task.threadId === first).activity).toBe("waiting-on-you");
    expect(existsSync(threadFile(third, "json"))).toBe(false);
    expect(existsSync(threadFile(fourth, "json"))).toBe(false);

    await limit(1);
    expect(await busyThreads(botId)).toHaveLength(2);
    expect(await capabilityStatus(launchedFirst)).toBe(200);
    expect(await capabilityStatus(launchedSecond)).toBe(200);
    expect(() => process.kill(launchedFirst.pid, 0)).not.toThrow();
    expect(() => process.kill(launchedSecond.pid, 0)).not.toThrow();
    finish(second);
    await expect.poll(() => busyThreads(botId)).toEqual([first]);
    expect(existsSync(threadFile(third, "json"))).toBe(false);
    expect((await messages(third)).filter((message) => message.role === "user")).toEqual([]);
    expect(answers).toEqual([]);
    const response = await api("POST", `/api/bots/${botId}/respond`, { threadId: first, requestId: "capacity-approval", behavior: "allow" });
    expect(response.status).toBe(200);
    await expect.poll(() => answers.some((answer) => answer.id === "capacity-approval")).toBe(true);
    expect(await busyThreads(botId)).toEqual([first]);
    expect(existsSync(threadFile(third, "json"))).toBe(false);

    finish(first);
    const launchedThird = await dump(third);
    await expect.poll(() => busyThreads(botId)).toEqual([third]);
    expect(existsSync(threadFile(fourth, "json"))).toBe(false);
    finish(third);
    const launchedFourth = await dump(fourth);
    await expect.poll(() => busyThreads(botId)).toEqual([fourth]);
    expect(Number(launchedSecond.env.OMB_FIXTURE_LAUNCHED_AT)).toBeLessThan(Number(launchedThird.env.OMB_FIXTURE_LAUNCHED_AT));
    expect(Number(launchedThird.env.OMB_FIXTURE_LAUNCHED_AT)).toBeLessThan(Number(launchedFourth.env.OMB_FIXTURE_LAUNCHED_AT));
    finish(fourth);
    await expect.poll(() => busyThreads(botId)).toEqual([]);
    for (const [index, threadId] of [second, third, fourth].entries()) {
      const userMessages = (await messages(threadId)).filter((message) => message.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({ text: `FIFO_${index + 1}`, queueId: queued[index] });
    }
    evidence.push({ fifoThreadOrder: [second, third, fourth], lowerLimitPreservedActiveProcesses: [launchedFirst.pid, launchedSecond.pid], approvalUsedSlot: true });
  }, 45_000);
});
