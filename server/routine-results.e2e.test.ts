import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

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
    // A thread the person chooses keeps winning; null goes back to the main thread.
    const { task: chosenTask } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Chosen reports" }, 201);
    const dedicated = chosenTask.threadId as string;
    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: dedicated });
    expect((await api("PATCH", `/api/routines/${routine.id}`, { name: "Retained destination" })).routine.resultsThreadId).toBe(dedicated);
    expect((await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: null })).routine.resultsThreadId).toBe(originalThread);
    // A legacy automatic "<name> · Results" thread is not a choice: the next
    // run moves to the main thread and the old thread and its reports stay.
    const { task: legacy } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Retained destination · Results" }, 201);
    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: legacy.threadId });
    const { run: moved } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    expect(moved.resultsThreadId).toBe(originalThread);
    await expect.poll(async () => (await runState(moved.id))?.status, { timeout: 15_000 }).toBe("completed");
    expect((await api("GET", "/api/routines")).routines.find((candidate: any) => candidate.id === routine.id).resultsThreadId).toBe(originalThread);
    expect((await currentBot()).tasks.some((task: any) => task.threadId === legacy.threadId)).toBe(true);
    expect((await messages(originalThread)).filter((message) => message.kind === "routine.run")).toHaveLength(3);
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
    expect(replacement.resultsThreadId).toBe(originalThread);
    await expect.poll(async () => (await runState(replacement.id))?.status, { timeout: 15_000 }).toBe("completed");
    expect((await currentBot()).tasks.some((task: any) => task.threadId === dedicated)).toBe(false);
    expect((await messages(originalThread)).find((message) => message.routineRun?.runId === replacement.id)?.routineRun)
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

it("reports a routine made in another chat into the bot's main thread, not that chat or a new results thread", async () => {
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
    const mainThread = bot.activeTaskId as string;
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Planning" }, 201);
    const chat = task.threadId as string;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "propose_routine", arguments: {
        name: "Chat report", instructions: "Report the fixture state; no external services.",
        schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "UTC" },
      } }], reply: "Please review the routine confirmation." },
      { steps: [], reply: "Fresh chat report" },
    ] } }));
    await cli("send", "--bot", bot.id, "--task", chat, "--text", "Report the fixture state monthly.");
    await cli("wait", "--bot", bot.id, "--task", chat, "--timeout", "20");
    const card = (await messages(chat)).findLast((message) => message.card?.routineRequest && !message.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    const { resultId: routineId } = await api("POST", `/api/bots/${bot.id}/respond`, { threadId: chat, requestId: card.requestId, behavior: "allow" });
    const definition = (await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === routineId);
    expect(definition.sourceThreadId).toBe(chat);

    const { run } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    expect(run.resultsThreadId).toBe(mainThread);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
    const finished = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
    expect((await messages(mainThread)).find((message) => message.routineRun?.runId === run.id)?.routineRun)
      .toMatchObject({ status: "completed", executionThreadId: finished.threadId });
    expect((await messages(chat)).some((message) => message.kind === "routine.run")).toBe(false);
    const saved = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(saved.tasks.filter((candidate: any) => !candidate.routineRunId).map((candidate: any) => candidate.threadId).sort())
      .toEqual([mainThread, chat].sort());
    expect(saved.tasks.find((candidate: any) => candidate.threadId === mainThread).unread).toBe(true);
    expect(saved.tasks.find((candidate: any) => candidate.threadId === finished.threadId)).toMatchObject({ routineRunId: run.id });
    evidence.push({ run: finished, bot: saved, main: await messages(mainThread) });
  } finally {
    const evidencePath = `${fixture.info.logPath}.chat-results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);
