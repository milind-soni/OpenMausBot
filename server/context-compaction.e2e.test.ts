import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readRegistry } from "./testing/registry.ts";

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
