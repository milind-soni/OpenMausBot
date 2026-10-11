import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("reports every run into the bot's main thread while fresh executions, approvals, deletion and unread stay reachable", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let broker: Socket | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  try {
    expect((await control(["doctor"]) as any).ok).toBe(true);
    const { bot } = await control(["new-bot", "--name", "Results fixture"]) as any;
    const originalThread = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).threadId;
    const { routine } = await api("POST", "/api/routines", {
      name: "Persistent report", prompt: "Report this run's state.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const completed: any[] = [];
    for (let index = 0; index < 2; index++) {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
      await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
      const finished = await runState(run.id);
      completed.push(finished);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
      expect(dump.argv).not.toContain("--resume");
      expect(JSON.stringify(dump.prompt)).not.toContain("hello from fake claude");
      evidence.push(await control(["wait", "--bot", bot.id, "--task", finished.threadId]));
      evidence.push(await control(["messages", "--bot", bot.id, "--task", finished.threadId, "--limit", "10"]));
    }
    // An editor/API routine reports into the bot's main thread: no new
    // "· Results" thread, while each run keeps its own execution record.
    const destination = completed[0].resultsThreadId;
    expect(destination).toBe(originalThread);
    expect(completed[1].resultsThreadId).toBe(destination);
    expect(completed[0].threadId).not.toBe(completed[1].threadId);
    const cards = (await messages(destination)).filter((message) => message.kind === "routine.run");
    expect(cards).toHaveLength(2);
    for (const run of completed) expect(cards.find((message) => message.routineRun.runId === run.id)?.routineRun)
      .toMatchObject({ status: "completed", scheduledFor: run.scheduledFor, executionThreadId: run.threadId, summary: "hello from fake claude" });
    // A phone without the card reads only the text, so it carries the result.
    for (const card of cards) expect(card.text).toBe("Routine “Persistent report” completed\n\nhello from fake claude");
    const currentBot = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    const savedBot = await currentBot();
    expect(savedBot.threadId).toBe(originalThread);
    expect(savedBot.tasks.filter((task: any) => !task.routineRunId)).toHaveLength(1);
    expect(savedBot.tasks.some((task: any) => task.title.endsWith("· Results"))).toBe(false);
    expect(savedBot.tasks.find((task: any) => task.threadId === destination).unread).toBe(true);
    for (const run of completed) expect(savedBot.tasks.find((task: any) => task.threadId === run.threadId))
      .toMatchObject({ routineRunId: run.id, unread: false, autoApprove: false, approvalMode: "ask" });

    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: completed[0].threadId }, 400);
    // Open run remains a usable normal conversation. Marking its historical
    // receipt seen must not reclassify later human conversation as internal.
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: completed[0].threadId, text: "Explain that completed report." }, 202);
    evidence.push(await control(["wait", "--bot", bot.id, "--task", completed[0].threadId]));
    await api("POST", `/api/routine-runs/${completed[0].id}/seen`);
    const promoted = (await currentBot()).tasks.find((task: any) => task.threadId === completed[0].threadId);
    expect(promoted.routineRunId).toBeUndefined();
    expect(promoted.unread).toBe(true);
    // The person wrote there last, so it is the bot's main thread now.
    const live = completed[0].threadId as string;
    expect((await currentBot()).mainThreadId).toBe(live);
    // A thread the person chooses keeps winning; null goes back to the main
    // thread, which each run asks for again and the routine never saves.
    const { task: chosenTask } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Chosen reports" }, 201);
    const dedicated = chosenTask.threadId as string;
    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: dedicated });
    expect((await api("PATCH", `/api/routines/${routine.id}`, { name: "Retained destination" })).routine.resultsThreadId).toBe(dedicated);
    expect((await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: null })).routine.resultsThreadId).toBeUndefined();
    // A legacy automatic "<name> · Results" thread is not a choice: the next
    // run moves to the main thread and the old thread and its reports stay.
    const { task: legacy } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Retained destination · Results" }, 201);
    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: legacy.threadId });
    const { run: moved } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    expect(moved.resultsThreadId).toBe(live);
    await expect.poll(async () => (await runState(moved.id))?.status, { timeout: 15_000 }).toBe("completed");
    expect((await api("GET", "/api/routines")).routines.find((candidate: any) => candidate.id === routine.id).resultsThreadId).toBeUndefined();
    expect((await currentBot()).tasks.some((task: any) => task.threadId === legacy.threadId)).toBe(true);
    expect((await messages(live)).filter((message) => message.kind === "routine.run")).toHaveLength(1);
    expect((await messages(originalThread)).filter((message) => message.kind === "routine.run")).toHaveLength(2);
    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: dedicated });

    const gate = join(fixture.info.dataDir, "results-finish");
    const wrapper = join(fixture.info.dataDir, "results-slow.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    const { run: pending } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("running");
    const active = await runState(pending.id);
    await expect.poll(() => {
      if (!existsSync(fixture.fixtureDumpPath)) return false;
      return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID === active.threadId;
    }, { timeout: 15_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const socketPath = launched.mcpConfig.mcpServers.ogb.args.at(-1);
    broker = connect(socketPath);
    broker.on("error", () => {});
    await new Promise<void>((resolve, reject) => { broker!.once("connect", resolve); broker!.once("error", reject); });
    broker.write(JSON.stringify({ t: "ask", id: "results-approval", kind: "permission", tool: "Bash", input: { command: "echo fixture-approval" } }) + "\n");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("waiting");
    const waitingCard = (await messages(dedicated)).find((message) => message.routineRun?.runId === pending.id);
    expect(waitingCard.routineRun).toMatchObject({ status: "waiting", executionThreadId: active.threadId });
    expect((await currentBot()).tasks.find((task: any) => task.threadId === active.threadId)).toMatchObject({ routineRunId: pending.id, unread: false });
    const approval = (await messages(active.threadId)).find((message) => message.card && !message.card.answered);
    expect(approval?.card.tool).toBe("Bash");

    await api("DELETE", `/api/bots/${bot.id}/tasks/${dedicated}`);
    const fallback = (await currentBot()).tasks.find((task: any) => task.threadId === active.threadId);
    expect(fallback.routineRunId).toBeUndefined();
    expect(fallback.unread).toBe(true);
    expect((await runState(pending.id)).resultsThreadId).toBe(dedicated);
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: active.threadId, requestId: approval.card.requestId, behavior: "deny" });
    writeFileSync(gate, "complete the isolated turn");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("completed");
    // A deleted destination falls back to the main thread for future runs.
    const { run: replacement } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    expect(replacement.resultsThreadId).toBe(live);
    await expect.poll(async () => (await runState(replacement.id))?.status, { timeout: 15_000 }).toBe("completed");
    expect((await currentBot()).tasks.some((task: any) => task.threadId === dedicated)).toBe(false);
    expect((await messages(live)).find((message) => message.routineRun?.runId === replacement.id)?.routineRun)
      .toMatchObject({ status: "completed", executionThreadId: (await runState(replacement.id)).threadId });
    expect((await currentBot()).tasks.some((task: any) => task.title.endsWith("· Results") && task.threadId !== legacy.threadId)).toBe(false);
    evidence.push({ cards, final: await api("GET", "/api/routines"), bot: await currentBot(), fallback });
  } finally {
    broker?.destroy();
    const evidencePath = `${fixture.info.logPath}.results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);

it("reports a routine made in a chat into that chat once the person writes there, not the bot's first thread or a new results thread", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  try {
    const { bot } = await cli("new-bot", "--name", "Chat routine fixture");
    const first = bot.activeTaskId as string;
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Planning" }, 201);
    const chat = task.threadId as string;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "propose_routine", arguments: {
        name: "Chat report", instructions: "Report the fixture state; no external services.",
        schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "UTC" },
      } }], reply: "The routine is scheduled." },
      { steps: [], reply: "Fresh chat report" },
    ] } }));
    await cli("send", "--bot", bot.id, "--task", chat, "--text", "Report the fixture state monthly.");
    await cli("wait", "--bot", bot.id, "--task", chat, "--timeout", "20");
    // The bot's own routine applies at once, as a receipt in that chat.
    const card = (await messages(chat)).findLast((message) => message.card?.routineRequest)?.card;
    expect(card).toMatchObject({ answered: "allow", autoApplied: true });
    const routineId = card.routineRequest.resultId as string;
    const definition = (await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === routineId);
    expect(definition.sourceThreadId).toBe(chat);

    // The person wrote in that chat last: it is the bot's main thread.
    const { run } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    expect(run.resultsThreadId).toBe(chat);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
    const finished = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
    expect((await messages(chat)).find((message) => message.routineRun?.runId === run.id)?.routineRun)
      .toMatchObject({ status: "completed", executionThreadId: finished.threadId });
    expect((await messages(first)).some((message) => message.kind === "routine.run")).toBe(false);
    const saved = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(saved.tasks.filter((candidate: any) => !candidate.routineRunId).map((candidate: any) => candidate.threadId).sort())
      .toEqual([first, chat].sort());
    expect(saved.tasks.find((candidate: any) => candidate.threadId === chat).unread).toBe(true);
    expect(saved.tasks.find((candidate: any) => candidate.threadId === finished.threadId)).toMatchObject({ routineRunId: run.id });
    evidence.push({ run: finished, bot: saved, main: await messages(chat) });
  } finally {
    const evidencePath = `${fixture.info.logPath}.chat-results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);

/** One isolated server, its API, and a restart on the same data. */
async function resultsFixture() {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  const savedBot = async (id: string) => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === id);
  const destination = async (id: string) => (await api("GET", "/api/routines")).routines.find((candidate: any) => candidate.id === id).resultsThreadId;
  const routine = async (botId: string) => (await api("POST", "/api/routines", {
    name: "Morning report", prompt: "Report this run's state.", botId, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  }, 201)).routine.id as string;
  const report = async (id: string) => {
    const { run } = await api("POST", `/api/routines/${id}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status,
      { timeout: 20_000 }).toBe("completed");
    return run.resultsThreadId as string;
  };
  /** Stop the server, let `edit` change routines.json (and `stopped` the
   * data directory), and start it again. */
  const restart = async (edit?: (file: any) => void, stopped?: (dataDir: string) => void) => {
    await waitForExit(server ?? fixture.child, { signal: "SIGTERM" });
    const path = join(dataDir, "routines.json");
    if (edit) {
      const file = JSON.parse(readFileSync(path, "utf8"));
      edit(file);
      writeFileSync(path, JSON.stringify(file));
    }
    stopped?.(dataDir);
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  const close = async () => {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  };
  return { api, control, messages, savedBot, destination, routine, report, restart, close };
}

it("reports into the conversation the person is in, the one a bot with hidden threads opens, after they used threads", async () => {
  const f = await resultsFixture();
  try {
    const { bot } = await f.control("new-bot", "--name", "Hidden threads");
    const oldest = bot.activeTaskId as string;
    // Threads were on once: a later conversation is the selection.
    const { task } = await f.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Later chat" }, 201);
    const live = task.threadId as string;
    const routine = await f.routine(bot.id);
    // Before anyone writes, the selection stands for where the person is.
    expect(await f.report(routine)).toBe(live);
    // They talk there; then another window, or a followed notification,
    // selects the oldest thread. Reports stay with the person.
    await f.control("send", "--bot", bot.id, "--task", live, "--text", "Good morning.");
    expect((await f.control("wait", "--bot", bot.id, "--task", live, "--timeout", "20")).status).toBe("settled");
    await f.api("POST", `/api/bots/${bot.id}/tasks/${oldest}?messages=0`);
    expect(await f.report(routine)).toBe(live);
    expect((await f.messages(live)).filter((message) => message.kind === "routine.run")).toHaveLength(2);
    expect((await f.messages(oldest)).some((message) => message.kind === "routine.run")).toBe(false);
    const saved = await f.savedBot(bot.id);
    expect(saved.threadId).toBe(oldest);
    expect(saved.tasks.find((candidate: any) => candidate.threadId === live).unread).toBe(true);
    // With threads hidden, the app opens the bot at that same thread.
    expect(saved.mainThreadId).toBe(live);
    // Nothing is saved on the routine: each run asks again.
    expect(await f.destination(routine)).toBeUndefined();
  } finally {
    await f.close();
  }
}, 90_000);

it("after the upgrade, reports into and opens the conversation the person last wrote in before it, not the one left selected", async () => {
  const f = await resultsFixture();
  try {
    const { bot } = await f.control("new-bot", "--name", "Upgraded");
    const oldest = bot.activeTaskId as string;
    const { task } = await f.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Their chat" }, 201);
    const theirs = task.threadId as string;
    // They talk in their own chat from the app, then an activity row leaves
    // the bot on the oldest thread, where v0.1.98 to v0.1.107 reported.
    await f.api("POST", `/api/bots/${bot.id}/messages`, { threadId: theirs, text: "Good morning.", sendId: randomUUID() }, 202);
    expect((await f.control("wait", "--bot", bot.id, "--task", theirs, "--timeout", "20")).status).toBe("settled");
    await f.api("POST", `/api/bots/${bot.id}/tasks/${oldest}?messages=0`);
    const routine = await f.routine(bot.id);
    // Their data as v0.1.98 to v0.1.107 left it: the oldest thread saved on
    // the routine as if chosen, and no askedAt yet.
    await f.restart((file) => {
      delete file.frozenResultsCleared;
      file.routines.find((candidate: any) => candidate.id === routine).resultsThreadId = oldest;
    }, (dataDir) => {
      const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as any[];
      for (const saved of bots) for (const each of saved.tasks ?? []) delete each.askedAt;
      writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots));
      rmSync(join(dataDir, "asked-at-filled"), { force: true });
    });
    const saved = await f.savedBot(bot.id);
    expect(saved.threadId).toBe(oldest);
    // With threads hidden the app opens the bot there, and reports land there.
    expect(saved.mainThreadId).toBe(theirs);
    expect(await f.report(routine)).toBe(theirs);
  } finally {
    await f.close();
  }
}, 90_000);

it("clears the oldest thread v0.1.98 to v0.1.107 saved as a routine's destination, once, also one archived since", async () => {
  const f = await resultsFixture();
  try {
    const { bot } = await f.control("new-bot", "--name", "Frozen destination");
    const oldest = bot.activeTaskId as string;
    const { task } = await f.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Later chat" }, 201);
    const routine = await f.routine(bot.id);
    // Those versions kept reporting into the thread they saved after it was
    // archived, and today's oldest open thread is another.
    const { bot: tidied } = await f.control("new-bot", "--name", "Archived destination");
    const archived = tidied.activeTaskId as string;
    const { task: kept } = await f.api("POST", `/api/bots/${tidied.id}/tasks`, { title: "Kept chat" }, 201);
    const tidiedRoutine = await f.routine(tidied.id);
    await f.api("PATCH", `/api/bots/${tidied.id}/tasks/${archived}`, { archivedAt: Date.now() });
    // What those versions left: the oldest thread saved as if chosen.
    await f.restart((file) => {
      delete file.frozenResultsCleared;
      file.routines.find((candidate: any) => candidate.id === routine).resultsThreadId = oldest;
      file.routines.find((candidate: any) => candidate.id === tidiedRoutine).resultsThreadId = archived;
    });
    expect(await f.destination(routine)).toBeUndefined();
    expect(await f.report(routine)).toBe(task.threadId);
    expect(await f.destination(tidiedRoutine)).toBeUndefined();
    expect(await f.report(tidiedRoutine)).toBe(kept.threadId);
    // Picked after the upgrade, the oldest thread is a person's choice.
    expect((await f.api("PATCH", `/api/routines/${routine}`, { resultsThreadId: oldest })).routine.resultsThreadId).toBe(oldest);
    await f.restart();
    expect(await f.destination(routine)).toBe(oldest);
    expect(await f.report(routine)).toBe(oldest);
  } finally {
    await f.close();
  }
}, 90_000);
