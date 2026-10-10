// Exercises the actual guarded route under the prescribed disposable-home
// launcher. The only provider is its fake CLI; each thread has its own gate.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

type Bot = { id: string; activeTaskId: string };
type Message = { id: string; role: string; kind: string; text?: string; sendId?: string; steered?: boolean; turnTerminal?: boolean; tool?: { name: string; ok?: boolean } };
type Page = { messages: Message[]; activeLeafId: string | null };

describe("guarded external messages through an isolated runtime", () => {
  let fixture: VerificationServer;
  let evidence: unknown[];

  const api = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result });
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]);
    evidence.push({ command: ["control:omb", ...args, "--url", fixture.info.url], result });
    return result as any;
  };
  const newBot = async (): Promise<Bot> => {
    const { bot } = await control(["new-bot", "--name", "Guarded message fixture"]);
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "External guarded task" });
    expect(created.status).toBe(201);
    const activeTaskId = created.body.task.threadId;
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${activeTaskId}`, { approvalMode: "ask" })).status).toBe(200);
    return { id: bot.id, activeTaskId };
  };
  const page = async (threadId: string): Promise<Page> => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body;
  const file = (threadId: string, extension: string) => join(fixture.info.dataDir, `${threadId}.${extension}`);
  const launched = async (threadId: string) => {
    await expect.poll(() => {
      try { return Boolean(JSON.parse(readFileSync(file(threadId, "launch.json"), "utf8")).pid); }
      catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }, { timeout: 15_000 }).toBe(true);
  };
  const initialOutputProcessed = async (threadId: string) => {
    // The launch dump precedes stdout. Wait for the initial tool result to
    // reach the runtime before snapshotting the leaf; slow mode then emits
    // no more messages until this thread's finish gate is released.
    await expect.poll(async () => (await page(threadId)).messages.some(message =>
      message.kind === "activity" && message.tool?.name === "Bash" && message.tool.ok === true,
    ), { timeout: 15_000 }).toBe(true);
  };
  const finish = async (bot: Bot, threadId = bot.activeTaskId) => {
    await launched(threadId);
    writeFileSync(file(threadId, "gate"), "finish the isolated fake turn");
    expect((await control(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "15"])).status).toBe("settled");
    await control(["messages", "--bot", bot.id, "--task", threadId, "--limit", "20"]);
  };
  const guarded = (bot: Bot, body: Record<string, unknown>) => api("POST", `/api/bots/${bot.id}/messages/guarded`, body);
  const payload = (bot: Bot, text: string, leaf: string | null = null) => ({ threadId: bot.activeTaskId, sendId: randomUUID(), text, expectedActiveLeafId: leaf });
  const noQueuedWork = async (threadId: string) => {
    const inventory = (await api("GET", "/api/bots?messages=0")).body;
    expect(inventory.botQueuedMessages?.[threadId] ?? []).toEqual([]);
  };

  beforeEach(async () => {
    evidence = [];
    fixture = await launchVerificationServer();
    const wrapper = join(fixture.info.dataDir, "guarded-fake-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { basename, join } from "node:path";',
      'const thread = basename(process.cwd());',
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".gate");`,
      `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".launch.json");`,
      `process.env.FAKE_CLAUDE_STEER_RECEIVED = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".steered");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
  }, 30_000);

  afterEach(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.guarded-messages.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, limitation: "Actual runtime and guarded HTTP route with fake provider only. No live accounts, paid calls or user data." }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  });

  it("advertises the authenticated capability and rejects malformed, foreign and unauthenticated targets", async () => {
    expect((await api("GET", "/api/health")).body.capabilities).toMatchObject({ guardedMessages: 1 });
    const bot = await newBot(), input = payload(bot, "STRICT_GUARD_INPUT");
    for (const invalid of [
      { threadId: input.threadId, text: input.text, sendId: input.sendId },
      { ...input, sendId: "short" }, { ...input, expectedActiveLeafId: "../elsewhere" },
      { ...input, unrecognizedOption: true },
    ]) expect((await guarded(bot, invalid)).status).toBe(400);
    const foreign = await newBot();
    expect((await guarded(bot, { ...input, threadId: foreign.activeTaskId })).status).toBe(409);
    expect((await api("POST", `/api/bots/${bot.id}/messages/guarded`, input, { origin: "https://untrusted.example.test" })).status).toBe(403);
    expect((await api("POST", `/api/bots/${bot.id}/messages/guarded`, input, { "x-forwarded-for": "203.0.113.5" })).status).toBe(403);
    expect((await page(bot.activeTaskId)).messages).toEqual([]);
    expect((await page(foreign.activeTaskId)).messages).toEqual([]);
    await noQueuedWork(bot.activeTaskId);
  });

  it("replays only the canonical receipt after a lost response, completion and stale leaf", async () => {
    const bot = await newBot(), input = payload(bot, "LOST_RECEIPT_MUST_NOT_REPEAT");
    // Lose the successful HTTP body after the server has durably accepted it.
    const lost = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages/guarded`, {
      method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(input),
    });
    expect(lost.status).toBe(202); await lost.body?.cancel();
    evidence.push({ lostSuccessfulBody: true, input });
    const retry = await guarded(bot, input);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ ok: true, threadId: bot.activeTaskId, message: { sendId: input.sendId, text: input.text } });
    expect(retry.body.queued).toBeUndefined(); expect(retry.body.steered).toBeUndefined();
    await finish(bot);
    const after = await page(bot.activeTaskId);
    expect(after.messages.filter(message => message.sendId === input.sendId)).toHaveLength(1);
    expect(after.messages.some(message => message.turnTerminal && message.role === "bot")).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { approvalMode: "auto" })).status).toBe(200);
    const settledRetry = await guarded(bot, input);
    expect(settledRetry.status).toBe(202); expect(settledRetry.body.message.id).toBe(retry.body.message.id);
    expect((await guarded(bot, { ...input, text: "DIFFERENT_BODY_SAME_ID" })).status).toBe(409);
    expect((await page(bot.activeTaskId)).messages).toEqual(after.messages);
    await noQueuedWork(bot.activeTaskId);
  }, 30_000);

  it("rejects a changed leaf and unsafe permissions without appending or dispatching", async () => {
    const bot = await newBot();
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "FIRST_NORMAL_TURN"]);
    await finish(bot);
    const baseline = await page(bot.activeTaskId);
    expect(baseline.activeLeafId).not.toBeNull();
    const stale = await guarded(bot, payload(bot, "STALE_BRANCH_MUST_NOT_RUN"));
    expect(stale.status).toBe(409); expect(stale.body.code).toBe("guarded_branch");
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { approvalMode: "auto" })).status).toBe(200);
    const unsafe = await guarded(bot, payload(bot, "AUTO_MUST_NOT_RUN", baseline.activeLeafId));
    expect(unsafe.status).toBe(409); expect(unsafe.body.code).toBe("guarded_permissions");
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", alwaysAllow: ["Bash:fixture"] })).status).toBe(200);
    const remembered = await guarded(bot, payload(bot, "REMEMBERED_MUST_NOT_RUN", baseline.activeLeafId));
    expect(remembered.status).toBe(409); expect(remembered.body.code).toBe("guarded_permissions");
    expect((await page(bot.activeTaskId)).messages).toEqual(baseline.messages);
    await noQueuedWork(bot.activeTaskId);
  }, 30_000);

  it("does not steer an active normal turn or queue behind exhausted capacity", async () => {
    const bot = await newBot();
    expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
    const sibling = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Guarded idle sibling" });
    expect(sibling.status).toBe(201);
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "NORMAL_TURN_OWNS_THE_THREAD"]);
    await launched(bot.activeTaskId);
    await initialOutputProcessed(bot.activeTaskId);
    const current = await page(bot.activeTaskId);
    const busy = await guarded(bot, payload(bot, "GUARDED_MUST_NOT_STEER", current.activeLeafId));
    expect(busy.status).toBe(409); expect(busy.body.code).toBe("guarded_busy");
    const blockedThread = sibling.body.task.threadId;
    const capacity = await guarded(bot, { ...payload(bot, "GUARDED_MUST_NOT_QUEUE"), threadId: blockedThread });
    expect(capacity.status).toBe(409); expect(capacity.body.code).toBe("guarded_busy");
    await noQueuedWork(bot.activeTaskId); await noQueuedWork(blockedThread);
    expect((await page(bot.activeTaskId)).messages.filter(message => message.role === "user").map(message => message.text)).toEqual(["NORMAL_TURN_OWNS_THE_THREAD"]);
    expect((await page(blockedThread)).messages).toEqual([]);
    expect(existsSync(file(bot.activeTaskId, "steered"))).toBe(false);
    await finish(bot);
    expect((await page(blockedThread)).messages).toEqual([]);
    expect(existsSync(file(blockedThread, "launch.json"))).toBe(false);
  }, 30_000);

  it("admits only one concurrent guarded send while duplicate identities share its receipt", async () => {
    const bot = await newBot(), first = payload(bot, "FIRST_CONCURRENT_GUARDED"), second = payload(bot, "SECOND_CONCURRENT_GUARDED");
    const results = await Promise.all([guarded(bot, first), guarded(bot, second)]);
    expect(results.map(result => result.status).sort()).toEqual([202, 409]);
    const accepted = results.find(result => result.status === 202)!;
    expect(results.find(result => result.status === 409)!.body.code).toBe("guarded_branch");
    const original = accepted.body.message.sendId === first.sendId ? first : second;
    const retries = await Promise.all([guarded(bot, original), guarded(bot, original)]);
    expect(retries.map(result => result.status)).toEqual([202, 202]);
    expect(retries.every(result => result.body.message.id === accepted.body.message.id)).toBe(true);
    expect(retries.every(result => !result.body.steered && !result.body.queued)).toBe(true);
    await launched(bot.activeTaskId);
    expect(existsSync(file(bot.activeTaskId, "steered"))).toBe(false);
    expect((await page(bot.activeTaskId)).messages.filter(message => message.role === "user")).toHaveLength(1);
    await noQueuedWork(bot.activeTaskId);
    await finish(bot);
  }, 30_000);

  it("reports an exact request and stops only its snapshotted execution", async () => {
    expect((await api("GET", "/api/health")).body.capabilities.guardedRequests).toBe(1);
    const bot = await newBot(), input = payload(bot, "EXACT_REQUEST_TO_STOP");
    const accepted = await guarded(bot, input);
    expect(accepted.status).toBe(202);
    await launched(bot.activeTaskId);
    await initialOutputProcessed(bot.activeTaskId);
    const route = `/api/bots/${bot.id}/requests/${input.sendId}`;
    const snapshot = (await api("GET", `${route}?threadId=${bot.activeTaskId}`)).body;
    expect(snapshot).toMatchObject({ messageId: accepted.body.message.id, phase: "working" });
    expect(typeof snapshot.activeTurnId).toBe("string");
    expect(typeof snapshot.executionId).toBe("string");
    const target = { threadId: bot.activeTaskId, messageId: snapshot.messageId, expectedActiveLeafId: snapshot.activeLeafId,
      expectedTurnId: snapshot.activeTurnId, expectedExecutionId: snapshot.executionId };
    // A null/old setup lease must never match a newer generation, even if a
    // provider has not assigned its own turn id yet.
    expect((await api("POST", `${route}/interrupt`, { ...target, expectedExecutionId: null })).status).toBe(409);
    expect((await api("POST", `${route}/interrupt`, { ...target, expectedTurnId: "foreign-turn" })).status).toBe(409);
    expect((await api("POST", `${route}/interrupt`, { ...target, extra: true })).status).toBe(400);
    expect((await api("POST", `${route}/interrupt`, target, { origin: "https://untrusted.example.test" })).status).toBe(403);
    const stopped = await api("POST", `${route}/interrupt`, target);
    expect(stopped).toMatchObject({ status: 200, body: { ok: true, outcome: "stopped" } });
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: any) => entry.id === bot.id).busy).toBe(false);
    expect((await api("POST", `${route}/interrupt`, target)).status).toBe(409);
    expect(existsSync(file(bot.activeTaskId, "gate"))).toBe(false);
  }, 30_000);

  it("keeps old stop receipts from reaching a later human turn and rejects foreign threads", async () => {
    const bot = await newBot(), input = payload(bot, "FIRST_REQUEST_COMPLETE");
    expect((await guarded(bot, input)).status).toBe(202);
    await finish(bot);
    const route = `/api/bots/${bot.id}/requests/${input.sendId}`;
    const settled = (await api("GET", `${route}?threadId=${bot.activeTaskId}`)).body;
    expect(settled.phase).toBe("settled");
    const final = settled.messages.find((message: any) => message.turnTerminal);
    expect(final.requestMessageId).toBe(settled.messageId);
    const target = { threadId: bot.activeTaskId, messageId: settled.messageId, expectedActiveLeafId: settled.activeLeafId,
      expectedTurnId: settled.activeTurnId, expectedExecutionId: settled.executionId };
    expect((await api("POST", `${route}/interrupt`, target)).status).toBe(409);
    const other = await newBot();
    expect((await api("GET", `${route}?threadId=${other.activeTaskId}`)).status).toBe(409);
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "A_LATER_HUMAN_REQUEST"]);
    expect((await api("GET", `${route}?threadId=${bot.activeTaskId}`))).toMatchObject({ status: 409, body: { code: "guarded_request_changed" } });
    expect((await api("POST", `${route}/interrupt`, target)).status).toBe(409);
    expect((await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "15"])).status).toBe("settled");
  }, 30_000);
});

it("refuses a parked conversation after its own provider settles while its teammate is still working", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result }); return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: ["control:omb", ...args, "--url", fixture.info.url], result }); return result;
  };
  try {
    const chief = (await control(["new-bot", "--name", "Guarded coordinator", "--section", "Leadership"])).bot;
    const teammate = (await control(["new-bot", "--name", "Guarded teammate", "--section", "Engineering"])).bot;
    expect((await api("PATCH", `/api/bots/${chief.id}`, {
      chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true, parkDirectMessages: true,
    })).status).toBe(200);
    const gate = join(fixture.info.dataDir, "guarded-teammate.gate");
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
      [chief.id]: {
        steps: [{ arguments: { bot_ids: [teammate.id], request_key: "guard-check", message: "Complete the gated fixture check." } }],
        reply: "The teammate owns the outstanding check.", resumeReply: "The guarded fixture check is complete.",
      },
      [teammate.id]: { gateFile: gate, reply: "The gated check passed." },
    }));
    await control(["send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Coordinate the gated fixture check."]);
    const nodes = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "room-handoffs.json"), "utf8")) as Array<{ botId: string; status: string }>;
    await expect.poll(() => { try { return nodes().find(node => node.botId === teammate.id)?.status; } catch { return undefined; } }, { timeout: 15_000 }).toBe("running");
    // Unlike the public busy flag (which includes coordination), this no-op
    // permission PATCH only succeeds after the exact task's raw busy flag
    // AND its synchronous provider dispatch claim have both been released.
    await expect.poll(async () => (await api("PATCH", `/api/bots/${chief.id}/tasks/${chief.activeTaskId}`, { approvalMode: "ask" })).status,
      { timeout: 15_000 }).toBe(200);
    const pagePath = `/api/threads/${chief.activeTaskId}/messages?limit=100`;
    const baseline = (await api("GET", pagePath)).body as Page;
    expect(baseline.messages.some(message => message.text === "The teammate owns the outstanding check." && message.turnTerminal)).toBe(true);
    expect(nodes().find(node => node.botId === teammate.id)?.status).toBe("running");
    const refusal = await api("POST", `/api/bots/${chief.id}/messages/guarded`, {
      threadId: chief.activeTaskId, sendId: randomUUID(), text: "THIS_GUARDED_FOLLOWUP_MUST_NOT_RUN", expectedActiveLeafId: baseline.activeLeafId,
    });
    expect(refusal).toMatchObject({ status: 409, body: { code: "guarded_busy" } });
    expect((await api("GET", pagePath)).body).toEqual(baseline);
    expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages?.[chief.activeTaskId] ?? []).toEqual([]);
    writeFileSync(gate, "finish only the isolated teammate");
    expect((await control(["wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "15"])).status).toBe("settled");
    const final = await control(["messages", "--bot", chief.id, "--task", chief.activeTaskId, "--limit", "20"]);
    expect(final.messages.some((message: Message) => message.text === "The guarded fixture check is complete.")).toBe(true);
    expect(final.messages.some((message: Message) => message.text === "THIS_GUARDED_FOLLOWUP_MUST_NOT_RUN")).toBe(false);
  } finally {
    const evidencePath = `${fixture.info.logPath}.guarded-coordination.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, limitation: "Actual runtime and gated fake teammate only; no live accounts, providers, or user data." }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 45_000);
