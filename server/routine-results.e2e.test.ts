import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("keeps results together while fresh executions, approvals, deletion and unread stay reachable", async () => {
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
    const destination = completed[0].resultsThreadId;
    expect(destination).toBeTruthy();
    expect(completed[1].resultsThreadId).toBe(destination);
    expect(completed[0].threadId).not.toBe(completed[1].threadId);
    const cards = (await messages(destination)).filter((message) => message.kind === "routine.run");
    expect(cards).toHaveLength(2);
    for (const run of completed) expect(cards.find((message) => message.routineRun.runId === run.id)?.routineRun)
      .toMatchObject({ status: "completed", scheduledFor: run.scheduledFor, executionThreadId: run.threadId, summary: "hello from fake claude" });
    const currentBot = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    const savedBot = await currentBot();
    expect(savedBot.threadId).toBe(originalThread);
    expect(savedBot.tasks.filter((task: any) => !task.routineRunId)).toHaveLength(2);
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
    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: originalThread });
    expect((await api("PATCH", `/api/routines/${routine.id}`, { name: "Retained destination" })).routine.resultsThreadId).toBe(originalThread);
    const dedicated = (await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: null })).routine.resultsThreadId;
    expect(dedicated).not.toBe(destination);
    expect(dedicated).not.toBe(originalThread);

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
    const { run: replacement } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    expect(replacement.resultsThreadId).not.toBe(dedicated);
    await expect.poll(async () => (await runState(replacement.id))?.status, { timeout: 15_000 }).toBe("completed");
    expect((await currentBot()).tasks.some((task: any) => task.threadId === dedicated)).toBe(false);
    evidence.push({ cards, final: await api("GET", "/api/routines"), bot: await currentBot(), fallback });
  } finally {
    broker?.destroy();
    const evidencePath = `${fixture.info.logPath}.results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);
