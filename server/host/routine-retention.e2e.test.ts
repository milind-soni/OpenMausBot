import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { launchRestartableServer } from "../testing/restartable-server.ts";

it("sweeps only eligible scheduled executions on an isolated server restart", async () => {
  const fixture = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(data)}`).toBe(true);
    return data;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Retention fixture" })).bot;
    const threads: string[] = [];
    for (let n = 0; n < 10; n++) threads.push((await api("POST", `/api/bots/${bot.id}/tasks`, { title: `Run ${n}`, select: false })).task.threadId);
    await fixture.stop();

    // Only this stopped fixture's synthetic store is changed to exercise the seven-day boundary.
    const old = Date.now() - 20 * 86_400_000;
    const botsFile = join(fixture.dataDir, "bots.json");
    const bots = JSON.parse(readFileSync(botsFile, "utf8")) as any[];
    const saved = bots.find((item) => item.id === bot.id);
    for (let n = 0; n < threads.length; n++) {
      const task = saved.tasks.find((item: any) => item.threadId === threads[n]);
      Object.assign(task, { routineRunId: n === 9 ? "orphan" : `run-${n}`, createdAt: old - n, updatedAt: old - n, unread: false });
      if (n === 7) task.pinned = true;
    }
    writeFileSync(botsFile, JSON.stringify(bots));
    const runs = threads.slice(0, 9).map((threadId, n) => ({
      id: `run-${n}`, routineId: "r", routineName: "Routine", prompt: "long prompt", output: "result",
      target: "bot", botId: bot.id, runOn: "maus", scheduledFor: old - n, createdAt: old - n, finishedAt: old - n,
      status: "completed", manual: false, triggerSource: n === 6 ? "webhook" : "schedule", ...(n === 6 ? { sameConversation: true } : {}),
      threadId, resultsThreadId: bot.threadId, report: { state: "quiet" },
    }));
    writeFileSync(join(fixture.dataDir, "routines.json"), JSON.stringify({ version: 1, routines: [], runs, frozenResultsCleared: true }));
    execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { Store } from './server/store.ts';
      const [botId, destination, execution, at] = process.argv.slice(1);
      const store = new Store(() => ({ instanceId: 'claude', model: 'fixture' }));
      store.appendMessage(destination, { role: 'bot', kind: 'text', text: 'orphan result', at: Number(at),
        automation: { routineId: 'r', runId: 'orphan', name: 'Routine', trigger: 'schedule', executionThreadId: execution, scheduledFor: Number(at) } });
    `, bot.id, bot.threadId, threads[9]!, String(old)], { cwd: process.cwd(), env: verificationServerEnvironment(process.env, fixture.dataDir, fixture.port) });
    await fixture.start();

    expect((await api("GET", "/api/config")).threads.routineExecutionRetentionSupported).toBe(true);
    expect((await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id).tasks.map((task: any) => task.threadId)).toContain(threads[5]);
    await api("PATCH", "/api/config", { routineExecutionRetentionDays: 7 });

    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === "run-5")?.threadId, { timeout: 15_000 }).toBeUndefined();
    const after = (await api("GET", "/api/routines")).runs as any[];
    const tasks = (await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id).tasks as any[];
    expect(after).toHaveLength(9);
    expect(after.find((run) => run.id === "run-5")).toMatchObject({ status: "completed", report: { state: "quiet" } });
    expect(after.find((run) => run.id === "run-5")).not.toHaveProperty("prompt");
    expect(after.find((run) => run.id === "run-8")).not.toHaveProperty("threadId");
    expect(after.find((run) => run.id === "run-0")).toMatchObject({ prompt: "long prompt", output: "result", threadId: threads[0] });
    expect(after.find((run) => run.id === "run-6")).toMatchObject({ triggerSource: "webhook", sameConversation: true, threadId: threads[6] });
    expect(tasks.map((task) => task.threadId)).not.toContain(threads[5]);
    expect(tasks.map((task) => task.threadId)).not.toContain(threads[8]);
    expect(tasks.map((task) => task.threadId)).not.toContain(threads[9]);
    expect(tasks.map((task) => task.threadId)).toEqual(expect.arrayContaining([bot.threadId, threads[0], threads[6], threads[7]]));
    expect((await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "orphan result", automation: expect.objectContaining({ runId: "orphan" }) }),
    ]));
    await fixture.stop();
    await fixture.start();
    expect((await api("GET", "/api/routines")).runs.find((run: any) => run.id === "run-5")).not.toHaveProperty("threadId");
    console.log(JSON.stringify({ logPath: fixture.logPath }));
  } finally { await fixture.close(); }
}, 90_000);
