// Warm summaries end to end: the real server, the fake Claude Code. The fake's conversation grows 20k tokens a turn from
// 110k and Claude Code's own compaction (at 162k, as measured on a Team trial) takes FAKE_CLAUDE_COMPACT_MS, standing in for
// the 35-58 s a real one takes on Opus. Warm summaries run at 1/100 of their real delays (OMB_WARM_SUMMARY_TIME_SCALE).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const COMPACT_MS = 6_000;

async function fixture(env: NodeJS.ProcessEnv, test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(env);
  try { await test(f); } finally { await f.close(); }
}

async function setup(extra: NodeJS.ProcessEnv) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-warm-summary-e2e-"));
  const prompts = join(scratch, "prompts.jsonl");
  writeFileSync(prompts, "");
  const env = {
    ...process.env, FAKE_CLAUDE_VERSION: "2.1.312", FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_PROMPTS: prompts,
    FAKE_CLAUDE_CONTEXT_GROWTH: "110000:20000", FAKE_CLAUDE_CONTEXT_STATE: join(scratch, "context"), FAKE_CLAUDE_AUTOCOMPACT_AT: "162000",
    FAKE_CLAUDE_COMPACT_MS: String(COMPACT_MS), FAKE_CLAUDE_COMPACT_DUMP: join(scratch, "compact.json"), OMB_WARM_SUMMARY_TIME_SCALE: "0.01",
    ...extra,
  };
  const session = await launchVerificationServer(env);
  try {
    const url = session.info.url;
    const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
    const bot = (await cli("new-bot", "--name", "Warm summary probe")).bot;
    const thread = bot.activeTaskId as string;
    // A 1M-window model, as on the trial: OpenMausBot's own fold would wait for 180k, so Claude Code's comes first.
    await cli("set-model", "--bot", bot.id, "--instance", "claude", "--model", "claude-opus-5-5");
    const task = () => JSON.parse(readFileSync(join(session.info.dataDir, "bots.json"), "utf8"))
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread);
    /** The time from a send to the bot's reply being in the conversation. */
    const send = async (text: string) => {
      const started = performance.now();
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "60")).status).toBe("settled");
      return Math.round(performance.now() - started);
    };
    const messages = async () => (await request(`/api/threads/${thread}/messages?limit=200`, {}, url) as any).messages as any[];
    const lastPrompt = () => readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).at(-1);
    const lastLaunch = () => JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).argv as string[];
    const compactDump = () => existsSync(env.FAKE_CLAUDE_COMPACT_DUMP) ? JSON.parse(readFileSync(env.FAKE_CLAUDE_COMPACT_DUMP, "utf8")) : null;
    return { session, bot, thread, task, send, messages, lastPrompt, lastLaunch, compactDump,
      close: async () => { try { await session.close(); } finally { await removeTempDir(scratch); } } };
  } catch (error) {
    await session.close();
    await removeTempDir(scratch);
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const words = (prompt: any) => JSON.stringify(prompt);
/** Each run's times to the next reply, kept with the fixtures' other evidence. */
const record = (entry: Record<string, unknown>) => {
  const dir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "warm-summary-timings.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), compactMs: COMPACT_MS, ...entry })}\n`);
};

it("before: the next turn waits for Claude Code to summarize a conversation past its point", () => fixture({ OMB_WARM_SUMMARY: "0" }, async (f) => {
  for (const text of ["MSG-1 build the landing page", "MSG-2 make the title bold", "MSG-3 and the subtitle"]) await f.send(text);
  await sleep(COMPACT_MS + 3_000);
  const before = await f.send("MSG-4 what changed?");
  record({ case: "before", nextReplyMs: before });
  expect(before).toBeGreaterThanOrEqual(COMPACT_MS);
  expect(f.compactDump()).toBeNull();
}), 120_000);

it("after: the conversation is summarized while idle, so the next turn starts small and fast and keeps the last messages word for word", () => fixture({}, async (f) => {
  for (const text of ["MSG-1 build the landing page", "MSG-2 make the title bold", "MSG-3 and the subtitle"]) await f.send(text);
  const before = f.task().resumeCursors.claude;
  await sleep(COMPACT_MS + 3_000);
  // The summary ran on a fork of the conversation's session, with Claude Code's own /compact.
  const dump = f.compactDump();
  expect(dump.prompt).toMatch(/^\/compact Keep the person's latest requests/);
  expect(dump.argv.slice(dump.argv.indexOf("--resume"), dump.argv.indexOf("--resume") + 3)).toEqual(["--resume", before, "--fork-session"]);
  expect(dump.argv).not.toContain("--no-session-persistence");
  const fork = f.task().resumeCursors.claude;
  expect(fork).not.toBe(before);
  expect((await f.messages()).some((m) => m.kind === "activity" && /summarized this conversation while it was idle; the latest messages carry on word for word/.test(m.tool?.name))).toBe(true);

  const after = await f.send("MSG-4 what changed?");
  record({ case: "after", nextReplyMs: after });
  expect(after).toBeLessThan(COMPACT_MS / 2);
  const launch = f.lastLaunch();
  expect(launch[launch.indexOf("--resume") + 1]).toBe(fork);
  // The person's last two messages and the replies since went word for word; the first went into the summary.
  const prompt = words(f.lastPrompt());
  expect(prompt).toContain("MSG-2 make the title bold");
  expect(prompt).toContain("MSG-3 and the subtitle");
  expect(prompt).toContain("MSG-4 what changed?");
  expect(prompt).not.toContain("MSG-1 build the landing page");
}), 120_000);

it("a message sent while the summary it needs is being written waits for it rather than starting a second one", () => fixture({}, async (f) => {
  for (const text of ["MSG-1 build the landing page", "MSG-2 make the title bold", "MSG-3 and the subtitle"]) await f.send(text);
  await sleep(1_000);
  const waited = await f.send("MSG-4 what changed?");
  record({ case: "sent during the summary it needs", nextReplyMs: waited });
  // It waited out the rest of the summary (about 5 s), not a whole second compaction on top (11 s or more).
  expect(waited).toBeLessThan(COMPACT_MS + 3_000);
  const launch = f.lastLaunch();
  expect(launch[launch.indexOf("--resume") + 1]).toBe(f.task().resumeCursors.claude);
  expect(f.compactDump()).not.toBeNull();
  expect(words(f.lastPrompt())).toContain("MSG-3 and the subtitle");
}), 120_000);

it("a message sent during a summary the turn did not need is never held up by it", () => fixture({ FAKE_CLAUDE_CONTEXT_GROWTH: "100000:10000" }, async (f) => {
  for (const text of ["MSG-1 build the landing page", "MSG-2 make the title bold", "MSG-3 and the subtitle"]) await f.send(text);
  const session = f.task().resumeCursors.claude;
  // 1/100 of 3 minutes: the summary starts after 1.8 s and runs for 6 s.
  await sleep(3_000);
  expect(f.compactDump()).not.toBeNull();
  const overtook = await f.send("MSG-4 what changed?");
  record({ case: "sent during a summary it did not need", nextReplyMs: overtook });
  // Held up, it would have waited out the rest of the summary (about 5 s).
  expect(overtook).toBeLessThan(3_000);
  await sleep(COMPACT_MS);
  // The abandoned fork never replaced the session the turn ran on.
  expect(f.task().resumeCursors.claude).toBe(session);
  expect((await f.messages()).some((m) => m.kind === "activity" && /while it was idle/.test(m.tool?.name ?? ""))).toBe(false);
}), 120_000);
