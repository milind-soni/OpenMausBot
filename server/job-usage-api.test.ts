import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import type { JobUsageSummary } from "../shared/job-usage.ts";
import { waitForExit } from "./testing/cleanup.ts";

describe("native job usage through actual fixture turns", () => {
  let session: VerificationServer;
  const restarted: ChildProcess[] = [];
  afterEach(async () => {
    for (const child of restarted.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
    if (!session) return;
    console.info(JSON.stringify(session.info));
    await session.close();
  });
  const control = (args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
  const get = async (path: string, token?: string) => {
    const response = await fetch(`${session.info.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json() as { jobs: JobUsageSummary[] } };
  };

  it("books each actual provider turn to its native root, exposes exact source identities and rereads the same totals", async () => {
    session = await launchVerificationServer();
    const { bot } = await control(["new-bot", "--name", "Native usage probe"]);
    const sent = await control(["send", "--bot", bot.id, "--text", "synthetic usage fixture request"]);
    const threadId = sent.taskId as string;
    expect(threadId).toBeTypeOf("string");
    expect(JSON.stringify(await control(["wait", "--bot", bot.id, "--timeout", "30"]))).toContain("settled");
    let first: JobUsageSummary | undefined;
    await expect.poll(async () => {
      const result = await get(`/api/threads/${threadId}/job/usage`);
      expect(result.status).toBe(200);
      first = result.body.jobs[0];
      return first?.total.turns;
    }, { timeout: 10_000 }).toBe(1);
    expect(first).toMatchObject({ total: { reportedUsd: 0.01, estimatedUsd: null, unknownCostTurns: 0, unknownInputTurns: 0, unknownOutputTurns: 0 },
      coverage: { expectedAttempts: 1, observedAttempts: 1, missingAttempts: 0, scopeComplete: true } });
    expect(first!.total.totalTokens).toBe(first!.total.input + first!.total.output);
    expect(first!.observations).toEqual([expect.objectContaining({ rootId: first!.rootId, assignmentId: first!.rootId,
      attemptId: `native:${first!.rootId}:1`, turnId: expect.any(String), botId: bot.id, driverKind: "claudeAgent", costSource: "reported" })]);
    expect(JSON.stringify(first)).not.toContain("synthetic usage fixture request");
    const again = await get(`/api/threads/${threadId}/job/usage?rootId=${first!.rootId}`);
    expect(again.body.jobs).toEqual([first]);

    await control(["send", "--bot", bot.id, "--task", threadId, "--text", "second independent usage fixture request"]);
    expect(JSON.stringify(await control(["wait", "--bot", bot.id, "--timeout", "30"]))).toContain("settled");
    await expect.poll(async () => (await get(`/api/threads/${threadId}/job/usage`)).body.jobs.reduce((sum, job) => sum + job.total.turns, 0), { timeout: 10_000 }).toBe(2);
    expect((await get(`/api/threads/${threadId}/job/usage?rootId=${first!.rootId}`)).body.jobs).toEqual([first]);
    expect((await get(`/api/threads/${threadId}/job/usage?rootId=unrelated`)).status).toBe(404);
  }, 90_000);

  it("includes parent, child and final-summary turns once and preserves the full ledger view across repeated service restarts", async () => {
    session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
    const chief = (await control(["new-bot", "--name", "Usage Chief", "--section", "Leadership"])).bot;
    const engineer = (await control(["new-bot", "--name", "Usage Engineer", "--section", "Engineering"])).bot;
    const post = async (path: string, body: unknown, method: "POST" | "PATCH" = "POST") => {
      const response = await fetch(`${session.info.url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    expect((await post(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH")).status).toBe(200);
    const planPath = join(session.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [chief.id]: { script: [
        { key: "chief-start", match: ["USAGE-TREE-JOB"], steps: [{ arguments: { bot_ids: [engineer.id], message: "USAGE-TREE-BRIEF: return the synthetic result." } }], reply: "Delegated." },
        { key: "chief-finish", match: ["Your downstream room requests have settled."], reply: "USAGE-TREE-FINAL: completed once." },
      ] },
      [engineer.id]: { script: [{ key: "engineer", match: ["USAGE-TREE-BRIEF"], reply: "Synthetic work completed." }] },
    }));
    const threadId = chief.activeTaskId;
    expect((await post(`/api/bots/${chief.id}/messages`, { threadId, text: "USAGE-TREE-JOB: delegate and return the result." })).status).toBeLessThan(300);
    let before: JobUsageSummary | undefined;
    await expect.poll(async () => {
      const result = await get(`/api/threads/${threadId}/job/usage`);
      before = result.body.jobs[0];
      return before?.total.turns;
    }, { timeout: 30_000 }).toBe(3);
    expect(before).toMatchObject({ assignments: 2, coverage: { expectedAttempts: 3, observedAttempts: 3, missingAttempts: 0, scopeComplete: true } });
    expect(before!.observations.filter(row => row.botId === chief.id)).toHaveLength(2);
    expect(before!.observations.filter(row => row.botId === engineer.id)).toHaveLength(1);
    expect(new Set(before!.observations.map(row => `${row.assignmentId}:${row.attemptId}:${row.turnId}`)).size).toBe(3);
    const evidenceBefore = readFileSync(`${planPath}.evidence.jsonl`, "utf8");
    let server = session.child;
    for (let restart = 0; restart < 2; restart++) {
      await waitForExit(server, { signal: "SIGTERM" });
      const env = verificationServerEnvironment(process.env, session.info.dataDir, Number(new URL(session.info.url).port));
      const log = openSync(session.info.logPath, "a", 0o600);
      server = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log] });
      restarted.push(server);
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 30_000 }).toBe(true);
      expect((await get(`/api/threads/${threadId}/job/usage?rootId=${before!.rootId}`)).body.jobs).toEqual([before]);
      expect(readFileSync(`${planPath}.evidence.jsonl`, "utf8")).toBe(evidenceBefore);
    }
  }, 120_000);
});
