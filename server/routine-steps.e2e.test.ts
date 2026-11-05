import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

const REPLIES = {
  "MARK-FIND": "ITEM-ONE shipped a model today",
  "MARK-SUM": "Summary: ITEM-ONE is a new release",
  "MARK-YES": "It does.\nYES",
  "MARK-NO": "NO",
};

describe("a stepped routine through the isolated harness", () => {
  let fixture: VerificationServer;
  let owner: any;
  let researcher: any;
  let evidence: unknown[];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    if (method !== "GET") evidence.push({ method, path, body, status: response.status });
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const dump = (threadId: string) => JSON.parse(readFileSync(join(fixture.info.dataDir, `${threadId}.json`), "utf8"));
  const prompt = (threadId: string) => JSON.stringify(dump(threadId).prompt);
  const botOf = (threadId: string) => dump(threadId).mcpConfig.mcpServers.agents.env.OMB_BOT_ID;
  const runStepped = async (check: string) => {
    const { routine } = await api("POST", "/api/routines", {
      name: `News ${check}`, prompt: "Tell me when AI news mentions a release.", botId: owner.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
      steps: [
        { botId: researcher.id, instructions: "MARK-FIND three AI news items." },
        { botId: owner.id, instructions: "MARK-SUM in five lines.", model: "quick" },
        { botId: owner.id, instructions: `${check} Does the summary mention a release?`, check: true },
      ],
    });
    expect(routine.steps).toHaveLength(3);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 30_000 }).toBe("completed");
    return await runState(run.id);
  };

  beforeEach(async () => {
    fixture = await launchVerificationServer();
    evidence = [{ fixture: fixture.info }];
    owner = (await control(["new-bot", "--name", "Step owner"]) as any).bot;
    researcher = (await control(["new-bot", "--name", "Step researcher"]) as any).bot;
    const markers = join(fixture.info.dataDir, "step-replies.json");
    writeFileSync(markers, JSON.stringify(REPLIES));
    const wrapper = join(fixture.info.dataDir, "routine-steps.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const at = process.argv.indexOf("--mcp-config");',
      'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_THREAD_ID ?? "probe";',
      `process.env.FAKE_CLAUDE_MARKER_REPLIES = ${JSON.stringify(markers)};`,
      `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".json");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
  }, 30_000);
  afterEach(async () => {
    if (!fixture) return;
    const path = `${fixture.info.logPath}.json`;
    writeFileSync(path, JSON.stringify({ evidence, final: await api("GET", "/api/routines").catch(() => null) }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath: path }));
    await fixture.close();
  });

  it("runs each step on its bot in its own thread, hands on only the reply, and reports the last real reply once", async () => {
    const run = await runStepped("MARK-YES");
    const [find, sum, check] = run.stepRuns;
    expect(run.stepRuns.map((step: any) => step.status)).toEqual(["done", "done", "done"]);
    expect(check.answer).toBe("yes");
    expect(new Set([find.threadId, sum.threadId, check.threadId]).size).toBe(3);
    expect([find, sum, check].map((step: any) => botOf(step.threadId))).toEqual([researcher.id, owner.id, owner.id]);
    expect(sum.model).toMatch(/haiku/i);
    expect(JSON.stringify(dump(sum.threadId).argv)).toMatch(/haiku/i);
    expect(JSON.stringify(dump(find.threadId).argv)).not.toMatch(/haiku/i);
    expect(prompt(sum.threadId)).toContain(REPLIES["MARK-FIND"]);
    expect(prompt(sum.threadId)).not.toContain("MARK-FIND three AI news items.");
    expect(prompt(check.threadId)).toContain(REPLIES["MARK-SUM"]);
    expect(run).toMatchObject({ threadId: sum.threadId, output: REPLIES["MARK-SUM"] });
    expect(run.handoff).toBeUndefined();
    await expect.poll(async () => (await messages(run.resultsThreadId)).filter((message) => message.automation?.runId === run.id).map((message) => message.text), { timeout: 15_000 })
      .toEqual([REPLIES["MARK-SUM"]]);
    evidence.push({ run, steps: run.stepRuns });
  }, 90_000);

  it("ends quietly with nothing in the results chat when the check says no", async () => {
    const run = await runStepped("MARK-NO");
    expect(run).toMatchObject({ status: "completed", report: { state: "quiet" } });
    expect(run.stepRuns[2].answer).toBe("no");
    await control(["wait", "--bot", owner.id, "--task", run.stepRuns[2].threadId]);
    expect((await messages(run.resultsThreadId)).filter((message) => message.automation?.runId === run.id)).toEqual([]);
    evidence.push({ quiet: run });
  }, 90_000);
});
