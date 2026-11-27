import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readRegistry } from "./testing/registry.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";
import { readUsage } from "./usage-ledger.ts";

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, hang = false, fakeEnv: NodeJS.ProcessEnv = {}) {
  const f = await setup(hang, fakeEnv);
  try { await test(f); } finally { await f.close(); }
}

async function setup(hang: boolean, fakeEnv: NodeJS.ProcessEnv) {
  const env = { ...process.env, ...fakeEnv, FAKE_CLAUDE_VERSION: "2.1.270", ...(hang ? { FAKE_CLAUDE_TEXT_HANG: "1" } : {}) };
  const session = await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true });
  let ready = false;
  try {
    let restarted: ChildProcess | undefined;
    const evidence: unknown[] = [];
    const api = async (path: string, body?: unknown, method = "POST") => {
      const result = await request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as any;
      evidence.push({ path, method: body === undefined ? "GET" : method, body, result });
      return result;
    };
    const cli = async (...args: string[]) => {
      const result = await runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as any;
      evidence.push({ command: args, result });
      return result;
    };
    const bot = (await cli("new-bot", "--name", "Context probe")).bot;
    const thread = bot.activeTaskId;
    const plan = join(session.info.dataDir, "room-plan.json");
    writeFileSync(plan, JSON.stringify({ [bot.id]: { reply: "Acknowledged" } }));
    const messages = async () => (await api(`/api/threads/${thread}/messages`)).messages as any[];
    const task = () => readRegistry(session.info.dataDir).bots
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread);
    const idle = () => expect.poll(async () => (await api("/api/bots?messages=0")).bots
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread).busy, { timeout: 15_000 }).toBe(false);
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    };
    const turns = () => existsSync(`${plan}.evidence.jsonl`) ? readFileSync(`${plan}.evidence.jsonl`, "utf8")
      .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    ready = true;
    const summarizing = () => {
      const file = join(session.info.dataDir, "events", `${thread}.ndjson`);
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
        .filter(event => event.type === "context.summarizing").map(event => event.active as boolean) : [];
    };
    return { session, api, cli, bot, thread, messages, task, idle, send, turns, summarizing,
      compact: () => api(`/api/bots/${bot.id}/compact`, { threadId: thread }),
      restart: async (beforeLaunch?: () => void) => {
        await waitForExit(restarted ?? session.child, { signal: "SIGTERM" });
        beforeLaunch?.();
        const log = openSync(session.info.logPath, "a", 0o600);
        restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
          cwd: process.cwd(), env: verificationServerEnvironment(env, session.info.dataDir, Number(new URL(session.info.url).port)), stdio: ["ignore", log, log],
        });
        closeSync(log);
        await expect.poll(async () => {
          try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
        }, { timeout: 20_000 }).toBe(true);
      },
      close: async () => {
        try {
          if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
          writeFileSync(`${session.info.logPath}.context.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
          console.info(`Context evidence: ${session.info.logPath}.context.json`);
        } finally { await session.close(); }
      },
    };
  } finally { if (!ready) await session.close(); }
}

/** Account environment is a persisted config setting, not writable through the public config patch: this changes only
 * the stopped fixture's own config. With DISABLE_COMPACT, Claude Code has no compaction and a summary is OpenMausBot's fold. */
const claudeEnvironment = (f: Awaited<ReturnType<typeof setup>>, values: Record<string, string>) => f.restart(() => {
  const path = join(f.session.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(config.instances.claude.environment, values);
  writeFileSync(path, JSON.stringify(config));
});

it("Compact now runs Claude Code's own compaction and keeps the conversation on a session of that engine", () => fixture(async f => {
  await f.send("OLDER_REQUEST use port 9000");
  await f.send("CORRECTION use port 9001 instead");
  await f.send("LATEST and name the service ledger");
  const before = await f.messages();
  const oldSession = f.task().resumeCursors.claude;
  const turnsBefore = f.turns().length;
  await f.compact();
  await f.idle();
  const after = await f.messages();
  expect(after.at(-1)).toMatchObject({ kind: "compaction", engineCompaction: true });
  expect(after.at(-1).compaction).toBeUndefined();
  expect(after.filter(m => m.kind === "compaction")).toHaveLength(1);
  expect(after.slice(0, before.length).map(m => m.id)).toEqual(before.map(m => m.id));
  expect(f.turns()).toHaveLength(turnsBefore);
  const summarized = f.task().resumeCursors.claude;
  expect(summarized).not.toBe(oldSession);
  expect(summarized).toMatch(/^fork-/);
  await f.compact();
  await f.idle();
  expect((await f.messages()).filter(m => m.kind === "compaction")).toHaveLength(1);
  expect(f.task().resumeCursors.claude).toBe(summarized);
  expect(f.task().appliedCompactionId).toBeUndefined();
  await f.send("What port did we settle on?");
  const prompt = String(f.turns().at(-1).prompt.message.content);
  expect(prompt).not.toContain("Earlier conversation summary");
  expect(prompt).toContain("CORRECTION use port 9001 instead");
  expect(prompt).toContain("LATEST and name the service ledger");
  expect(prompt).not.toContain("OLDER_REQUEST");
  expect(f.task().resumeCursors.claude).toBe(summarized);
}), 90_000);

it("compacts durably, keeps corrections and starts a fresh native session without deleting any chats", () => fixture(async f => {
  await claudeEnvironment(f, { DISABLE_COMPACT: "1" });
  await f.send("OLDER_REQUEST use port 9000");
  await f.send("CORRECTION use port 9001 instead; cancel the earlier request");
  const before = await f.messages();
  const previousRequest = before.findLast(message => message.role === "user");
  expect(previousRequest.requestPending).toBe(false);
  const oldSession = f.task().resumeCursors.claude;
  const turnsBefore = f.turns().length;
  const sibling = (await f.cli("new-bot", "--name", "Separate context")).bot;
  await expect(f.api(`/api/bots/${sibling.id}/compact`, { threadId: f.thread })).rejects.toThrow(/no such task/);
  await f.compact();
  await f.idle();
  const after = await f.messages();
  const record = after.at(-1);
  expect(after.slice(0, before.length)).toEqual(before.map(message =>
    message.id === previousRequest.id ? { ...message, requestPending: true } : message));
  expect(record.kind).toBe("compaction");
  expect(record.compaction.summary).toContain("CORRECTION");
  expect(Buffer.byteLength(record.compaction.summary)).toBeLessThanOrEqual(6_000);
  expect(record.compaction.by).toBe("person");
  expect(f.turns()).toHaveLength(turnsBefore);
  await f.compact();
  await f.idle();
  expect((await f.messages()).filter(m => m.kind === "compaction")).toHaveLength(1);
  await f.restart();
  await f.send("What port did we settle on?");
  const next = f.turns().at(-1);
  expect(next.resumed).toBe(false);
  expect(String(next.prompt.message.content)).toContain("Earlier conversation summary");
  expect(String(next.prompt.message.content)).toContain("CORRECTION");
  expect(f.task().resumeCursors.claude).not.toBe(oldSession);
  expect(f.task().appliedCompactionId).toBe(record.id);
  const compactedSession = f.task().resumeCursors.claude;
  await f.send("Continue with the corrected port");
  expect(f.task().resumeCursors.claude).toBe(compactedSession);
  expect(String(f.turns().at(-1).prompt.message.content)).not.toContain("Earlier conversation summary");
  const original = before.find(m => m.text === "OLDER_REQUEST use port 9000");
  await f.cli("edit", "--bot", f.bot.id, "--task", f.thread, "--message", original.id, "--text", "NEW_BRANCH only port 9100");
  await f.idle();
  expect(f.turns().at(-1).resumed).toBe(false);
  expect(String(f.turns().at(-1).prompt.message.content)).not.toContain("CORRECTION");
  expect((await f.messages()).some(m => m.id === record.id)).toBe(true);
}), 90_000);

it("automatically folds old exchanges while keeping the two latest and the incoming request", () => fixture(async f => {
  await f.api("/api/config", { context: { compactAt: 1 } }, "PATCH");
  await f.send("FIRST_EXCHANGE historical request");
  await f.send("SECOND_EXCHANGE keep verbatim");
  await f.send("THIRD_EXCHANGE correction -5 != 5");
  await f.send("INCOMING do not summarize this request");
  const records = (await f.messages()).filter(m => m.kind === "compaction");
  expect(records).toHaveLength(1);
  expect(records[0].compaction.by).toBe("harness");
  expect(records[0].compaction.summary).not.toContain("INCOMING");
  const prompt = String(f.turns().at(-1).prompt.message.content);
  expect(prompt).toContain("SECOND_EXCHANGE keep verbatim");
  expect(prompt).toContain("THIRD_EXCHANGE correction -5 != 5");
  expect(prompt).toContain("INCOMING do not summarize this request");
  expect(f.turns().at(-1).resumed).toBe(false);
  await expect.poll(f.summarizing, { message: "the status line says it is summarizing, then stops saying it" }).toEqual([true, false]);
}), 70_000);

it("Stop cancels a stalled summary without writing a late record or starting an agent", () => fixture(async f => {
  await claudeEnvironment(f, { DISABLE_COMPACT: "1" });
  await f.send("Keep this original chat intact");
  const before = await f.messages();
  const previousRequest = before.findLast(message => message.role === "user");
  expect(previousRequest.requestPending).toBe(false);
  const count = f.turns().length;
  await f.compact();
  await expect.poll(() => {
    const dump = JSON.parse(readFileSync(f.session.fixtureDumpPath, "utf8"));
    return typeof dump.prompt === "string" && dump.prompt.startsWith("Summarize this conversation");
  }).toBe(true);
  await expect(f.compact()).rejects.toThrow(/already working/);
  await expect.poll(f.summarizing).toEqual([true]);
  await f.cli("interrupt", "--bot", f.bot.id, "--task", f.thread);
  await f.idle();
  expect((await f.messages()).filter(m => m.kind === "compaction")).toHaveLength(0);
  await expect.poll(f.summarizing, { message: "a stopped summary clears the status line" }).toEqual([true, false]);
  expect((await f.messages()).slice(0, before.length)).toEqual(before.map(message =>
    message.id === previousRequest.id ? { ...message, requestPending: true } : message));
  expect(f.turns()).toHaveLength(count);
  await f.send("Continue without a summary");
  expect(f.turns()).toHaveLength(count + 1);
}, true), 60_000);

it.each([
  { native: undefined, tokens: 190_000, compactions: 1 },
  { native: "100000", tokens: 95_000, compactions: 1 },
  { native: "off", tokens: 190_000, compactions: 0 },
  { native: "auto", tokens: 190_000, compactions: 0 },
])("respects the selected account's native compaction setting ($native)", ({ native, tokens, compactions }) => fixture(async f => {
  if (native !== undefined) await claudeEnvironment(f, { OMB_CLAUDE_AUTOCOMPACT: native });
  await f.api(`/api/bots/${f.bot.id}/tasks/${f.thread}`, {
    modelSelection: { instanceId: "claude", model: "claude-sonnet-4-6[1m]" },
  }, "PATCH");
  for (const text of ["FIRST historical request", "SECOND keep recent", "THIRD correction", "INCOMING follow-up"]) await f.send(text);
  expect(f.task().usage.context).toMatchObject({ tokens, window: 1_000_000 });
  expect((await f.messages()).filter(m => m.kind === "compaction")).toHaveLength(compactions);
  const launch = JSON.parse(readFileSync(f.session.fixtureDumpPath, "utf8"));
  if (native === "off") expect(launch.argv).not.toContain("--autocompact");
  else expect(launch.argv[launch.argv.indexOf("--autocompact") + 1]).toBe(native ?? "200000");
  if (compactions) {
    await f.send("NEXT keep the native headroom after the first fold");
    expect((await f.messages()).filter(m => m.kind === "compaction")).toHaveLength(2);
    expect(f.turns().at(-1).resumed).toBe(false);
  }
}, false, { FAKE_CLAUDE_CONTEXT_TOKENS: String(tokens) }), 90_000);

it.each([
  { name: "leaves a session Claude Code will compact itself", tokens: 165_000, engineOff: false, compactions: 0 },
  { name: "folds a session that Claude Code left uncompacted near its limit", tokens: 191_000, engineOff: false, compactions: 1 },
  { name: "folds at 80% when Claude Code's own compaction is switched off", tokens: 165_000, engineOff: true, compactions: 1 },
])("on a 200k model, $name", ({ tokens, engineOff, compactions }) => fixture(async f => {
  if (engineOff) await claudeEnvironment(f, { DISABLE_AUTO_COMPACT: "1" });
  await f.api(`/api/bots/${f.bot.id}/tasks/${f.thread}`, {
    modelSelection: { instanceId: "claude", model: "claude-sonnet-4-6" },
  }, "PATCH");
  for (const text of ["FIRST historical request", "SECOND keep recent", "THIRD correction"]) await f.send(text);
  const session = f.task().resumeCursors.claude;
  expect(typeof session).toBe("string");
  await f.send("INCOMING follow-up");
  expect(f.task().usage.context).toMatchObject({ tokens, window: 200_000 });
  expect((await f.messages()).filter(m => m.kind === "compaction")).toHaveLength(compactions);
  expect(f.task().resumeCursors.claude === session).toBe(compactions === 0);
  expect(String(f.turns().at(-1).prompt.message.content).includes("Earlier conversation summary")).toBe(compactions === 1);
}, false, { FAKE_CLAUDE_CONTEXT_TOKENS: String(tokens) }), 90_000);

async function codexFixture(test: (f: Awaited<ReturnType<typeof codexSetup>>) => Promise<void>, fakeEnv: NodeJS.ProcessEnv = {}) {
  const f = await codexSetup(fakeEnv);
  try { await test(f); } finally { await f.close(); }
}

async function codexSetup(fakeEnv: NodeJS.ProcessEnv) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-codex-compact-e2e-"));
  const callLog = join(scratch, "codex-calls.ndjson");
  const env = { ...process.env, FAKE_CODEX_MODE: "happy", FAKE_CODEX_CALL_LOG: callLog, FAKE_CODEX_THREAD_IDS: "distinct", FAKE_CODEX_CONTEXT_TOKENS: "1000,1000,270000",
    FAKE_CODEX_CONTEXT_TOKENS_AFTER_COMPACT: "40000", FAKE_CLAUDE_VERSION: "2.1.270", FAKE_CODEX_COMPACT_HOLD_FILE: join(scratch, "compact-hold"), ...fakeEnv };
  const session = await launchVerificationServer(env, undefined, undefined, undefined, undefined, undefined, ["codex"])
    .catch((error) => { rmSync(scratch, { recursive: true, force: true }); throw error; });
  let ready = false;
  try {
    mkdirSync(join(session.info.dataDir, ".codex"));
    const authenticate = (account: string) => writeFileSync(join(session.info.dataDir, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account, access_token: "fixture" } }));
    authenticate("account-1");
    const evidence: unknown[] = [];
    const api = async (path: string, body?: unknown, method = "POST") => {
      const sent = { path, method: body === undefined ? "GET" : method, body };
      try {
        const result = await request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as any;
        evidence.push({ ...sent, result });
        return result;
      } catch (error) {
        evidence.push({ ...sent, refused: String((error as Error).message) });
        throw error;
      }
    };
    const cli = async (...args: string[]) => {
      try {
        const result = await runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as any;
        evidence.push({ command: args, result });
        return result;
      } catch (error) {
        evidence.push({ command: args, failed: String((error as Error).message) });
        throw error;
      }
    };
    const holdCompaction = () => writeFileSync(join(scratch, "compact-hold"), "");
    const releaseCompaction = () => rmSync(join(scratch, "compact-hold"), { force: true });
    const bot = (await cli("new-bot", "--name", "Codex context probe")).bot;
    const thread: string = bot.activeTaskId;
    const codex = (await cli("models")).instances.find((item: any) => item.instanceId === "codex");
    const select = (selection: Record<string, unknown>) => api(`/api/bots/${bot.id}/tasks/${thread}`, { modelSelection: selection, requireAvailableModel: true }, "PATCH");
    const model = codex.models.options[0].id as string;
    await select({ instanceId: "codex", model });
    const messages = async () => (await api(`/api/threads/${thread}/messages`)).messages as any[];
    const task = () => readRegistry(session.info.dataDir).bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread);
    const idle = () => expect.poll(async () => (await api("/api/bots?messages=0")).bots
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread).busy, { timeout: 15_000 }).toBe(false);
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    };
    const calls = (method?: string): Array<{ pid: number; method: string; params: any }> =>
      (existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []).filter(call => !method || call.method === method);
    const turnTexts = () => calls("turn/start").map(call => ({ pid: call.pid, thread: call.params.threadId as string,
      text: withoutTurnClock(call.params.input.map((part: any) => part.text ?? "").join("\n")) }));
    const folds = async () => (await messages()).filter(m => m.kind === "compaction" && m.compaction);
    const engineRows = async () => (await messages()).filter(m => m.kind === "compaction" && m.engineCompaction);
    const cursor = () => task().resumeCursors.codex as string;
    const longConversation = async () => {
      for (const text of ["FIRST historical request", "SECOND keep recent", "THIRD correction"]) await send(text);
      await expect.poll(() => task().usage?.context).toMatchObject({ tokens: 270_000, window: 272_000 });
      await expect.poll(() => cursor()).toMatch(/^codex-thread-/);
      expect(await folds()).toHaveLength(0);
    };
    const compact = async () => { await api(`/api/bots/${bot.id}/compact`, { threadId: thread }); await idle(); };
    const usageRows = () => readUsage(session.info.dataDir, { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) })
      .filter(row => row.threadId === thread && row.botId === bot.id).sort((a, b) => a.at.localeCompare(b.at));
    ready = true;
    return { session, api, cli, bot, thread, select, model, messages, task, idle, send, calls, turnTexts, folds, engineRows, cursor, longConversation, compact, authenticate, scratch, usageRows, holdCompaction, releaseCompaction,
      close: async () => {
        try {
          try {
            evidence.push({ commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
              final: { messages: await messages().catch(() => null), task: task(), usage: usageRows(), fakeCodexCalls: calls() } });
          } finally {
            writeFileSync(`${session.info.logPath}.context.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
            console.info(`Codex compaction evidence: ${session.info.logPath}.context.json`);
          }
        } finally {
          try { await session.close(); } finally { rmSync(scratch, { recursive: true, force: true }); }
        }
      } };
  } finally { if (!ready) { try { await session.close(); } finally { rmSync(scratch, { recursive: true, force: true }); } } }
}

const sameThreadAfterCompaction = async (f: Awaited<ReturnType<typeof codexSetup>>) => {
  await expect.poll(() => f.cursor()).toMatch(/^codex-thread-/);
  const session = f.cursor();
  const turns = f.turnTexts();
  expect(turns).toHaveLength(3);
  const pid = turns[0]!.pid;
  expect(new Set(turns.map(turn => turn.pid))).toEqual(new Set([pid]));
  await expect.poll(() => f.task().handedMessages?.codex?.session).toBe(session);
  const ledger = JSON.stringify(f.task().handedMessages);
  await f.compact();
  expect(f.calls("thread/compact/start")).toEqual([{ pid, method: "thread/compact/start", params: { threadId: session } }]);
  expect(await f.folds()).toHaveLength(0);
  const rows = await f.engineRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "compaction", engineCompaction: true });
  expect(rows[0].compaction).toBeUndefined();
  await expect.poll(() => f.task().usage.context).toBeUndefined();
  expect(f.task().lastContextModel).toBeUndefined();
  expect(f.cursor()).toBe(session);
  expect(JSON.stringify(f.task().handedMessages)).toBe(ledger);
  await expect.poll(() => f.usageRows().length).toBe(4);
  expect(f.usageRows()[3]).toMatchObject({ instanceId: "codex", driverKind: "codex", input: 0, output: 0, costUsd: null });
  const listed = (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.id === f.bot.id).tasks.find((t: any) => t.threadId === f.thread);
  expect(listed.usage?.context).toBeUndefined();
  await f.send("FOURTH after compaction");
  const next = f.turnTexts().at(-1)!;
  expect(f.calls("thread/start")).toHaveLength(1);
  expect(next).toEqual({ pid, thread: session, text: "FOURTH after compaction" });
  expect(await f.folds()).toHaveLength(0);
  expect(f.cursor()).toBe(session);
  await expect.poll(() => f.task().usage.context).toMatchObject({ tokens: 40_000 });
};

const foldedToNewThread = async (f: Awaited<ReturnType<typeof codexSetup>>, oldSession: string, requests = 0) => {
  expect(f.calls("thread/compact/start")).toHaveLength(requests);
  const record = (await f.folds()).at(-1);
  expect(record.compaction.by).toBe("person");
  await f.send("FOURTH after the fold");
  expect(f.calls("thread/start")).toHaveLength(2);
  const next = f.turnTexts().at(-1)!;
  expect(next.thread).not.toBe(oldSession);
  await expect.poll(() => f.cursor()).toBe(next.thread);
  expect(next.text).toContain("Earlier conversation summary");
};

it("Compact now compacts a Codex conversation in place on its kept process: the next message goes on in the same thread, with nothing resent and nothing folded", () => codexFixture(async f => {
  await f.longConversation();
  await sameThreadAfterCompaction(f);
}), 90_000);

it("books the usage Codex reports for a compaction, and the next turn still counts its own", () => codexFixture(async f => {
  await f.longConversation();
  await f.compact();
  await expect.poll(() => f.usageRows().length).toBe(4);
  expect(f.usageRows()[3]).toMatchObject({ instanceId: "codex", input: 50, output: 5, cachedInput: 20 });
  await f.send("FOURTH after compaction");
  await expect.poll(() => f.usageRows().length).toBe(5);
  expect(f.usageRows()[4]).toMatchObject({ input: 7, output: 3, cachedInput: 4 });
}, { FAKE_CODEX_COMPACT_USAGE: JSON.stringify({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 20 }) }), 90_000);

it("folds, as before engines compacted themselves, when the person set where to fold", () => codexFixture(async f => {
  await f.api("/api/config", { context: { compactAt: 0.5 } }, "PATCH");
  await f.longConversation();
  const session = f.cursor();
  await f.compact();
  await foldedToNewThread(f, session);
}), 90_000);

it("folds, as it always did, when the process the last turn left is gone", () => codexFixture(async f => {
  await f.longConversation();
  const session = f.cursor();
  const { pid } = f.turnTexts().at(-1)!;
  process.kill(pid, "SIGKILL");
  await expect.poll(() => {
    const log = join(f.session.info.dataDir, "native", `${f.thread}.ndjson`);
    return existsSync(log) && readFileSync(log, "utf8").includes("exited while idle");
  }).toBe(true);
  await f.compact();
  await foldedToNewThread(f, session);
}), 90_000);

it("folds the branch the person is on, and sends the other thread nothing, after switching to another branch", () => codexFixture(async f => {
  await f.longConversation();
  const session = f.cursor();
  const earlier = (await f.messages()).filter(m => m.role === "bot" && m.kind === "text")[0];
  await f.api(`/api/bots/${f.bot.id}/active-branch`, { threadId: f.thread, messageId: earlier.id });
  await f.compact();
  await foldedToNewThread(f, session);
}), 90_000);

it("folds, rather than report a compaction the next message would not use, when the thread moves to the bot's own folder", () => codexFixture(async f => {
  await f.longConversation();
  const session = f.cursor();
  const project = mkdtempSync(join(f.scratch, "project-"));
  await f.api(`/api/bots/${f.bot.id}`, { cwd: project }, "PATCH");
  await f.compact();
  await foldedToNewThread(f, session);
}), 90_000);

it("folds when the effort the thread holds is set back to the default, which would make the next message start over", () => codexFixture(async f => {
  await f.select({ instanceId: "codex", model: f.model, effort: "high" });
  await f.longConversation();
  const session = f.cursor();
  await f.select({ instanceId: "codex", model: f.model });
  await f.compact();
  await foldedToNewThread(f, session);
}), 90_000);

it("folds when the account was signed into another one since the last turn, and never sends the old process the request", () => codexFixture(async f => {
  await f.longConversation();
  const session = f.cursor();
  f.authenticate("account-2");
  await f.compact();
  await foldedToNewThread(f, session);
}), 90_000);

it("folds when Codex does not compact", () => codexFixture(async f => {
  await f.longConversation();
  const session = f.cursor();
  await f.compact();
  await foldedToNewThread(f, session, 1);
}, { FAKE_CODEX_COMPACT: "error" }), 90_000);

it("books a compaction Codex sends no usage notification for as a row of no tokens and no cost", () => codexFixture(async f => {
  await f.longConversation();
  await f.compact();
  await expect.poll(() => f.usageRows().length).toBe(4);
  expect(f.usageRows()[3]).toMatchObject({ instanceId: "codex", input: 0, output: 0, costUsd: null });
  await f.send("FOURTH after compaction");
  await expect.poll(() => f.usageRows().length).toBe(5);
  expect(f.usageRows()[4]).toMatchObject({ input: 7, output: 3, cachedInput: 4 });
}, { FAKE_CODEX_COMPACT_NO_USAGE: "1" }), 90_000);

it("writes nothing, and folds nothing, when the effort the thread holds was set back to the default while Codex compacted", () => codexFixture(async f => {
  await f.select({ instanceId: "codex", model: f.model, effort: "high" });
  await f.longConversation();
  const session = f.cursor();
  f.holdCompaction();
  await f.api(`/api/bots/${f.bot.id}/compact`, { threadId: f.thread });
  await expect.poll(() => f.calls("thread/compact/start").length).toBe(1);
  await f.select({ instanceId: "codex", model: f.model });
  f.releaseCompaction();
  await f.idle();
  expect(f.calls("thread/compact/start")).toHaveLength(1);
  expect(await f.engineRows()).toHaveLength(0);
  expect(await f.folds()).toHaveLength(0);
  expect(f.task().usage.context).toMatchObject({ tokens: 270_000 });
  expect(f.cursor()).toBe(session);
  await expect.poll(() => f.usageRows().length).toBe(4);
}), 90_000);

it("lets a second click do nothing while the first runs, and again once it is done", () => codexFixture(async f => {
  await f.longConversation();
  f.holdCompaction();
  await f.api(`/api/bots/${f.bot.id}/compact`, { threadId: f.thread });
  await expect.poll(() => f.calls("thread/compact/start").length).toBe(1);
  await expect(f.api(`/api/bots/${f.bot.id}/compact`, { threadId: f.thread })).rejects.toThrow(/already working/);
  f.releaseCompaction();
  await f.idle();
  await f.compact();
  expect(f.calls("thread/compact/start")).toHaveLength(1);
  expect(await f.engineRows()).toHaveLength(1);
  expect(await f.folds()).toHaveLength(0);
}), 90_000);

it("leaves the first turn of another engine after a Codex compaction to replay the conversation as it always does", () => codexFixture(async f => {
  await f.longConversation();
  await f.compact();
  expect(await f.engineRows()).toHaveLength(1);
  const claude = (await f.cli("models")).instances.find((item: any) => item.instanceId === "claude");
  await f.select({ instanceId: "claude", model: claude.models.options[0].id });
  await f.send("FIFTH asked of Claude");
  const prompt = String(JSON.parse(readFileSync(f.session.fixtureDumpPath, "utf8")).prompt.message.content);
  expect(prompt).toContain("FIRST historical request");
  expect(prompt).toContain("THIRD correction");
  expect(prompt).toContain("FIFTH asked of Claude");
  expect(prompt).not.toContain("Earlier conversation summary");
  expect(await f.folds()).toHaveLength(0);
}), 90_000);
