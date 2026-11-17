import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import type { WireMessage } from "../shared/wire.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

const OLD = /OLD_SECRET_ALPHA|OLD_BETA_REPLY|OLD_DELTA_REPLY|OLD_GAMMA_MORE|Earlier conversation summary/;

async function setup(extraEnv: NodeJS.ProcessEnv) {
  const fixture = await launchVerificationServer({ ...process.env, ...extraEnv }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const control = async (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const bot = (await control("new-bot", "--name", "Fresh probe")).bot;
  const thread: string = bot.activeTaskId;
  const api = (path: string, options: RequestInit = {}) => request(path, options, fixture.info.url);
  const messages = async () => (await api(`/api/threads/${thread}/messages?limit=200`) as { messages: WireMessage[] }).messages;
  const settled = async () => expect((await control("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  /** Set by a test while its turn must carry nothing from before the divider. */
  let oldLines = /(?!)/;
  const send = async (text: string) => {
    await control("send", "--bot", bot.id, "--task", thread, "--text", text);
    await settled();
    const sent = dump();
    const full = withoutTurnClock(String(sent.prompt.message.content));
    // Everything the provider got is checked (`full`); `prompt` is the line itself, under the reminder a new process opens with.
    expect(full).not.toMatch(oldLines);
    return { prompt: full.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, ""), full, pid: sent.pid as number, argv: sent.argv as string[] };
  };
  const startFresh = () => api(`/api/bots/${bot.id}/start-fresh`, { method: "POST", body: JSON.stringify({ threadId: thread }) });
  const close = async () => { try { await fixture.close(); } finally { expect(existsSync(fixture.info.dataDir)).toBe(false); } };
  const guard = () => { oldLines = OLD; };
  return { fixture, control, bot, thread, api, messages, settled, send, startFresh, guard, close };
}

it("sends the provider nothing from before the divider, while a warm session and the turn before it stay untouched", async () => {
  // The reply state keeps the scripted replies in order across the new process, so "OLD" only ever marks the turns before the divider.
  const dir = mkdtempSync(join(tmpdir(), "omb-fresh-start-"));
  const f = await setup({ FAKE_CLAUDE_REPLIES: JSON.stringify(["OLD_BETA_REPLY", "OLD_DELTA_REPLY", "after one", "after two", "after three"]), FAKE_CLAUDE_REPLY_STATE: join(dir, "replies") });
  try {
    const first = await f.send("OLD_SECRET_ALPHA remember this");
    expect(first.prompt).toBe("OLD_SECRET_ALPHA remember this");
    expect(first.argv).not.toContain("--resume");

    // Before the divider nothing changes: the warm process takes the turn, sent only the new line.
    const second = await f.send("OLD_GAMMA_MORE and this");
    expect(second.prompt).toBe("OLD_GAMMA_MORE and this");
    expect(second.pid).toBe(first.pid);

    // A summary written before the divider must not cross it either.
    await f.api(`/api/bots/${f.bot.id}/compact`, { method: "POST", body: JSON.stringify({ threadId: f.thread }) });
    await f.settled();
    expect((await f.messages()).some((m) => m.kind === "compaction" && m.compaction && !m.compaction.fresh)).toBe(true);

    f.guard();
    const reset = await f.startFresh() as { message: WireMessage | null };
    expect(reset.message?.compaction?.fresh).toBe(true);
    const shown = await f.messages();
    expect(shown.at(-1)?.compaction?.fresh).toBe(true);
    expect(shown.some((m) => m.text?.includes("OLD_SECRET_ALPHA"))).toBe(true);

    // The next turn is a new provider session, carrying only its own words.
    const third = await f.send("after the divider");
    expect(third.prompt).toBe("after the divider");
    expect(third.argv).not.toContain("--resume");
    expect(third.pid).not.toBe(first.pid);

    // After it, the new session continues normally.
    const fourth = await f.send("still fresh");
    expect(fourth.prompt).toBe("still fresh");
    expect(fourth.pid).toBe(third.pid);

    // A switched-in engine replays only what follows the divider.
    const codex = (await f.control("models")).instances.find((item: any) => item.instanceId === "codex");
    await f.api(`/api/bots/${f.bot.id}/tasks/${f.thread}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: codex.models.options[0].id }, requireAvailableModel: true }) });
    await f.control("send", "--bot", f.bot.id, "--task", f.thread, "--text", "now on another engine");
    await f.settled();
    const sent = readFileSync(join(f.fixture.info.dataDir, "native", `${f.thread}.ndjson`), "utf8").trim().split("\n").map((line) => JSON.parse(line)).findLast((entry) => entry.dir === "out" && entry.msg?.method === "turn/start");
    const joined = withoutTurnClock((sent.msg.params.input as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n"));
    expect(joined).toContain("User: after the divider");
    expect(joined).toContain("User: still fresh");
    expect(joined).not.toMatch(OLD);
    expect(joined.endsWith("now on another engine")).toBe(true);

    // A summary written after the divider covers only what follows it.
    await f.api(`/api/bots/${f.bot.id}/compact`, { method: "POST", body: JSON.stringify({ threadId: f.thread }) });
    await f.settled();
    const newest = (await f.messages()).findLast((m) => m.kind === "compaction" && !m.compaction?.fresh)!;
    expect(newest.compaction?.summary).toMatch(/after the divider|after one/);
    expect(newest.compaction?.summary).not.toMatch(OLD);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

it("does not resume the old session when the engine process has already exited", async () => {
  const f = await setup({ FAKE_CLAUDE_EXIT_AFTER_TURN: "1" });
  try {
    const first = await f.send("OLD_SECRET_ALPHA remember this");
    const second = await f.send("OLD_GAMMA_MORE and this");
    // Before the divider a cold turn resumes, as it always has.
    expect(second.argv).toContain("--resume");
    expect(second.prompt).toBe("OLD_GAMMA_MORE and this");
    expect(second.pid).not.toBe(first.pid);

    f.guard();
    await f.startFresh();
    const third = await f.send("after the divider");
    expect(third.prompt).toBe("after the divider");
    expect(third.argv).not.toContain("--resume");
  } finally { await f.close(); }
}, 120_000);

it("refuses while a turn is running, and a repeat press adds nothing", async () => {
  const f = await setup({ FAKE_CLAUDE_MODE: "hang" });
  try {
    await f.control("send", "--bot", f.bot.id, "--task", f.thread, "--text", "stuck turn");
    await expect.poll(async () => (await f.api(`/api/bots`) as { bots: Array<{ id: string; busy: boolean }> }).bots.find((b) => b.id === f.bot.id)?.busy, { timeout: 20_000 }).toBe(true);
    await expect(f.startFresh()).rejects.toThrow(/409|stop it before starting fresh/);
    await f.api(`/api/bots/${f.bot.id}/interrupt`, { method: "POST", body: JSON.stringify({ threadId: f.thread }) });
    await expect.poll(async () => (await f.api(`/api/bots`) as { bots: Array<{ id: string; busy: boolean }> }).bots.find((b) => b.id === f.bot.id)?.busy, { timeout: 20_000 }).toBe(false);

    await f.startFresh();
    expect(((await f.startFresh()) as { message: unknown }).message).toBeNull();
    expect((await f.messages()).filter((m) => m.compaction?.fresh)).toHaveLength(1);
  } finally { await f.close(); }
}, 90_000);
