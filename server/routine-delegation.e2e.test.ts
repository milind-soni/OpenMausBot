import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

describe("routine delegation through the isolated harness", () => {
  let fixture: VerificationServer;
  let source: any;
  let peer: any;
  let evidence: unknown[];
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture.info.url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status });
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const file = (threadId: string, extension: string) => join(fixture.info.dataDir, `${threadId}.${extension}`);
  const finish = (threadId: string) => writeFileSync(file(threadId, "gate"), "finish isolated turn");
  const dump = async (threadId: string) => {
    await expect.poll(() => existsSync(file(threadId, "json")), { timeout: 15_000 }).toBe(true);
    return JSON.parse(readFileSync(file(threadId, "json"), "utf8"));
  };
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const start = async () => {
    const { routine } = await api("POST", "/api/routines", {
      name: "Delegated report", prompt: "Ask the peer for evidence, then report its result.", botId: source.id,
      enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("running");
    return await runState(run.id);
  };
  const delegate = async (threadId: string) => {
    const launched = await dump(threadId);
    const result = await api("POST", "/api/internal/delegate-bot", { toBotId: peer.id, message: "Produce the fixture report." }, launched.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN);
    expect(result.queued).toBe(true);
    return result;
  };
  beforeEach(async () => {
    fixture = await launchVerificationServer();
    evidence = [{ fixture: fixture.info }];
    source = (await control(["new-bot", "--name", "Routine owner"]) as any).bot;
    peer = (await control(["new-bot", "--name", "Routine peer"]) as any).bot;
    const wrapper = join(fixture.info.dataDir, "routine-gated.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { existsSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const at = process.argv.indexOf("--mcp-config");',
      'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_THREAD_ID ?? "probe";',
      // One-hop delegates intentionally have no agents server. Let that
      // actual peer turn complete; gate only the source/occupied turns.
      `process.env.FAKE_CLAUDE_MODE = thread === "probe" && !existsSync(${JSON.stringify(join(fixture.info.dataDir, "gate-peer"))}) ? "happy" : "slow";`,
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".gate");`,
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

  it("waits for a busy peer, then resumes the same routine and records the final report", async () => {
    const { bots } = await api("GET", "/api/bots");
    const peerThread = bots.find((bot: any) => bot.id === peer.id).threadId;
    await control(["send", "--bot", peer.id, "--text", "An existing task occupies the peer."]);
    expect((await dump(peerThread)).systemPrompt).not.toContain("Execute this routine now:");
    const run = await start();
    expect((await dump(run.threadId)).systemPrompt).toContain("Execute this routine now:");
    expect((await dump(run.threadId)).systemPrompt).toContain("after an accepted delegation, end this turn for automatic resumption");
    await delegate(run.threadId);
    finish(run.threadId);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("waiting");
    expect((await runState(run.id)).attention).toContain("delegated");
    expect((await runState(run.id)).finishedAt).toBeUndefined();
    finish(peerThread);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 20_000 }).toBe("completed");
    const transcript = await messages(run.threadId);
    expect(transcript.some((message) => message.text?.includes("@Routine peer replied to the delegated task"))).toBe(true);
    expect((await runState(run.id)).output).toContain("[A delegated task just completed]");
    evidence.push({ waitedForBusyPeer: true, resumedRoutine: run.id, threadId: run.threadId, transcript });
  }, 60_000);

  it("wakes the routine with a denied handoff instead of leaving it waiting forever", async () => {
    await api("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true });
    const run = await start();
    await delegate(run.threadId);
    finish(run.threadId);
    await expect.poll(async () => (await messages(run.threadId)).some((message) => message.card?.tool === "delegate_bot"), { timeout: 15_000 }).toBe(true);
    const card = (await messages(run.threadId)).find((message) => message.card?.tool === "delegate_bot");
    await api("POST", `/api/bots/${source.id}/respond`, { threadId: run.threadId, requestId: card.card.requestId, behavior: "deny" });
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
    const transcript = await messages(run.threadId);
    expect(transcript.some((message) => /denied/i.test(message.text ?? message.tool?.name ?? ""))).toBe(true);
    evidence.push({ deniedHandoffResumed: true, transcript });
  }, 45_000);

  it.each([
    { capacity: 3, resume: "completion" },
    { capacity: 1, resume: "raise" },
  ])("charges a logical wake once at capacity $capacity, then resumes on $resume", async ({ capacity, resume }) => {
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: capacity } });
    writeFileSync(join(fixture.info.dataDir, "gate-peer"), "hold the delegated peer");
    const run = await start();
    await delegate(run.threadId);
    finish(run.threadId);
    await dump("probe");
    await expect.poll(async () => (await runState(run.id))?.status).toBe("waiting");

    // The source thread is idle, but startTurn's later bot-wide admission
    // check rejects its wake. Keep that condition deterministic across drains.
    const occupiedThreads: string[] = [];
    for (let index = 0; index < capacity; index++) {
      const { task } = await api("POST", `/api/bots/${source.id}/tasks`, { title: `Occupied ${index}` });
      occupiedThreads.push(task.threadId);
      await api("POST", `/api/bots/${source.id}/messages`, { threadId: task.threadId, text: "Hold this task open." });
      await dump(task.threadId);
    }
    finish("probe");
    await expect.poll(async () => (await messages(run.threadId)).some(
      (message) => message.text?.includes("@Routine peer replied to the delegated task"),
    ), { timeout: 15_000 }).toBe(true);

    const observer = (await control(["new-bot", "--name", "Unrelated observer"]) as any).bot;
    const observerThread = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === observer.id).threadId;
    // More retries than the three-wake burst budget must not exhaust it:
    // these completions retry one held wake, not new logical follow-ups.
    for (let index = 0; index < 4; index++) {
      await api("POST", `/api/bots/${observer.id}/messages`, { threadId: observerThread, text: `Unrelated work ${index}` });
      await dump(observerThread);
      finish(observerThread);
      await control(["wait", "--bot", observer.id, "--task", observerThread]);
      expect((await runState(run.id)).status).toBe("waiting");
    }

    if (resume === "raise") await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: capacity + 1 } });
    else finish(occupiedThreads[0]);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
    expect((await runState(run.id)).output).toContain("[A delegated task just completed]");
    if (resume === "raise") {
      const bot = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === source.id);
      expect(bot.tasks.find((task: any) => task.threadId === occupiedThreads[0]).busy).toBe(true);
    }
    evidence.push({ busyRetriesPreservedWakeBudget: true, capacity, resume, runId: run.id, transcript: await messages(run.threadId) });
  }, 60_000);

  it("resumes a new user's delegation on a completed routine's execution thread", async () => {
    const run = await start();
    finish(run.threadId);
    await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
    const finished = await runState(run.id);
    await expect.poll(async () => {
      const bot = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === source.id);
      return bot.tasks.find((task: any) => task.threadId === run.threadId)?.busy;
    }).toBe(false);
    unlinkSync(file(run.threadId, "gate"));
    unlinkSync(file(run.threadId, "json"));
    await api("POST", `/api/bots/${source.id}/messages`, { threadId: run.threadId, text: "A new request: ask the peer for a fresh report." });
    await delegate(run.threadId);
    finish(run.threadId);
    await expect.poll(async () => (await messages(run.threadId)).some(
      (message) => message.role === "bot" && message.text?.includes("[A delegated task just completed]"),
    ), { timeout: 20_000 }).toBe(true);
    expect(await runState(run.id)).toMatchObject({ status: "completed", finishedAt: finished.finishedAt, output: finished.output });
    evidence.push({ reusedCompletedExecution: true, transcript: await messages(run.threadId) });
  }, 45_000);

  it("does not dispatch an approved handoff after the routine was cancelled", async () => {
    await api("PATCH", `/api/bots/${source.id}`, { approvePeerComms: true });
    const run = await start();
    await delegate(run.threadId);
    finish(run.threadId);
    await expect.poll(async () => (await messages(run.threadId)).some((message) => message.card?.tool === "delegate_bot"), { timeout: 15_000 }).toBe(true);
    const card = (await messages(run.threadId)).find((message) => message.card?.tool === "delegate_bot");
    await api("POST", `/api/routine-runs/${run.id}/cancel`);
    // A stale approval may be rejected or acknowledged as already settled;
    // either response must leave the cancelled work and target untouched.
    await fetch(`${fixture.info.url}/api/bots/${source.id}/respond`, {
      method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url },
      body: JSON.stringify({ threadId: run.threadId, requestId: card.card.requestId, behavior: "allow" }),
    });
    expect((await runState(run.id)).status).toBe("cancelled");
    const target = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === peer.id);
    expect(Boolean(target.busy)).toBe(false);
    expect(target.messages.some((message: any) => message.role === "user")).toBe(false);
    evidence.push({ cancelledHandoffNotDispatched: true, runId: run.id });
  }, 45_000);

  it("drops a failed routine's persisted handoffs when provider settings reload", async () => {
    const run = await start();
    await delegate(run.threadId);
    const pendingFile = join(fixture.info.dataDir, "delegations.json");
    expect(JSON.parse(readFileSync(pendingFile, "utf8"))[run.threadId]).toHaveLength(1);
    // Clearing the fixture's empty connected-app key rebuilds only its fake
    // provider fleet; it makes no credential probe or external request.
    await api("PUT", "/api/config", { composio: { apiKey: "" } });
    await expect.poll(async () => (await runState(run.id))?.status).toBe("failed");
    expect(JSON.parse(readFileSync(pendingFile, "utf8"))[run.threadId]).toBeUndefined();
    unlinkSync(file(run.threadId, "json"));
    await api("POST", `/api/bots/${source.id}/messages`, { threadId: run.threadId, text: "New unrelated work after the failed routine." });
    await dump(run.threadId);
    finish(run.threadId);
    await control(["wait", "--bot", source.id, "--task", run.threadId]);
    const target = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === peer.id);
    expect(target.messages.some((message: any) => message.role === "user")).toBe(false);
    expect(JSON.parse(readFileSync(pendingFile, "utf8"))[run.threadId]).toBeUndefined();
    evidence.push({ providerFailureRemovedPersistedHandoff: true, runId: run.id });
  }, 45_000);

  it("does not revive a cancelled routine when an already-running peer replies during later user work", async () => {
    writeFileSync(join(fixture.info.dataDir, "gate-peer"), "hold the delegated peer");
    const run = await start();
    await delegate(run.threadId);
    finish(run.threadId);
    await dump("probe");
    await expect.poll(async () => (await runState(run.id))?.status).toBe("waiting");
    await api("POST", `/api/routine-runs/${run.id}/cancel`);
    unlinkSync(file(run.threadId, "gate"));
    unlinkSync(file(run.threadId, "json"));
    await api("POST", `/api/bots/${source.id}/messages`, { threadId: run.threadId, text: "A new independent request after cancellation." });
    await dump(run.threadId);
    finish("probe");
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === peer.id)?.busy,
      { timeout: 15_000 }).toBe(false);
    finish(run.threadId);
    await control(["wait", "--bot", source.id, "--task", run.threadId]);
    const transcript = await messages(run.threadId);
    expect(transcript.some((message) => message.text?.includes("[A delegated task just completed]"))).toBe(false);
    expect((await runState(run.id)).status).toBe("cancelled");
    evidence.push({ cancelledPeerDidNotResumeNewUserTurn: true, transcript });
  }, 45_000);
});
