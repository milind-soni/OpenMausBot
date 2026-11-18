import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as procs from "../procs.ts";
import { CodexConnection, codexConfigDigest, codexContractDiff, codexLoginIdentity, codexSpawnContract, codexWarmSessions, type KeptCodex } from "./codex-warm.ts";
import { armedIdleCount, sessionIdlePolicy } from "./session-idle.ts";

const children: ChildProcessWithoutNullStreams[] = [];
/** Stays up, and echoes each line it is sent. */
const idleChild = () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout); setInterval(() => {}, 1000);"], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
};
const session = (overrides: Partial<KeptCodex<null>> = {}): KeptCodex<null> => ({
  connection: new CodexConnection(idleChild()), contract: "{}", nativeThreadId: "native-1", configDigest: "config", cwd: "/work", carried: null, ...overrides,
});
const contract = (overrides: Partial<Parameters<typeof codexSpawnContract>[0]> = {}) => codexSpawnContract({
  cli: "codex-not-installed", args: ["app-server", "-c", "model=\"a\""], env: { PATH: "/nowhere", CODEX_HOME: "/nowhere", TOKEN: "first-secret" }, cwd: "/work", box: {}, thread: { model: "a" }, login: null, ...overrides,
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
});

describe("a Codex app-server's launch contract", () => {
  it("names what changed and never carries a value", () => {
    const before = contract();
    expect(codexContractDiff(before, contract())).toEqual([]);
    expect(codexContractDiff(before, contract({ env: { PATH: "/nowhere", CODEX_HOME: "/nowhere", TOKEN: "second-secret", ADDED: "x" } }))).toEqual(["env:TOKEN", "env:ADDED"]);
    expect(codexContractDiff(before, contract({ args: ["app-server"], cwd: "/other", thread: { model: "b" }, login: "someone", box: { box: { allowEnv: ["A"] } } })))
      .toEqual(["args", "cwd", "box", "thread", "login"]);
    expect(before).not.toContain("first-secret");
    expect(codexConfigDigest({ mcp_servers: { a: { command: "x" }, b: { command: "y" } }, model: "m" }))
      .toBe(codexConfigDigest({ model: "m", mcp_servers: { b: { command: "y" }, a: { command: "x" } } }));
    expect(codexContractDiff(codexConfigDigest({ model: "m", plugins: { a: {} } }), codexConfigDigest({ model: "m", plugins: { a: { enabled: false } } }))).toEqual(["config:plugins"]);
    expect(before).not.toContain("model=");
  });

  it("holds one login across a renewed token, and tells accounts and sign-in kinds apart", () => {
    const login = (tokens: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ auth_mode: "chatgpt", tokens, last_refresh: tokens.access_token, ...extra });
    const first = codexLoginIdentity(login({ account_id: "account-1", access_token: "one" }));
    expect(codexLoginIdentity(login({ account_id: "account-1", access_token: "two" }))).toBe(first);
    expect(codexLoginIdentity(login({ account_id: "account-2", access_token: "one" }))).not.toBe(first);
    expect(codexLoginIdentity(JSON.stringify({ OPENAI_API_KEY: "key-1" }))).not.toBe(codexLoginIdentity(JSON.stringify({ OPENAI_API_KEY: "key-2" })));
    expect(codexLoginIdentity(login({ access_token: "one" }))).not.toBe(codexLoginIdentity(login({ access_token: "two" })));
    expect(codexLoginIdentity("{ half written")).not.toBe(first);
    expect(codexLoginIdentity(null)).toBeNull();
  });
});

describe("kept Codex app-servers", () => {
  it("hand a process back only to its own conversation, contract and native thread", async () => {
    const warm = codexWarmSessions<null>("instance-a");
    const kept = session();
    expect(warm.keep("thread-1", kept)).toBe(true);
    expect(warm.take("thread-2", "{}", "native-1")).toBeNull();
    expect(kept.connection.alive).toBe(true);
    expect(warm.take("thread-1", "{}", "native-1")).toBe(kept);
    expect(warm.has("thread-1")).toBe(false);

    expect(warm.keep("thread-1", kept)).toBe(true);
    expect(warm.take("thread-1", "{}", "native-2")).toBeNull();
    await warm.retired();
    expect(kept.connection.alive).toBe(false);

    const other = session({ contract: contract() });
    expect(warm.keep("thread-1", other)).toBe(true);
    expect(warm.take("thread-1", contract({ cwd: "/other" }), "native-1")).toBeNull();
    await warm.retired();
    expect(other.connection.alive).toBe(false);
  });

  it("close an idle process after the idle time, and stop counting one that is taken or gone", async () => {
    vi.spyOn(procs, "killCliTree").mockImplementation(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      return true;
    });
    const warm = codexWarmSessions<null>("instance-b");
    const armedBefore = armedIdleCount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const taken = session(), idle = session(), dying = session();
    warm.keep("taken", taken);
    warm.keep("idle", idle);
    warm.keep("dying", dying);
    expect(armedIdleCount()).toBe(armedBefore + 3);
    expect(warm.take("taken", "{}", "native-1")).toBe(taken);
    const exited = once(dying.connection.child, "exit");
    dying.connection.child.kill("SIGKILL");
    await exited;
    expect(warm.has("dying")).toBe(false);
    expect(armedIdleCount()).toBe(armedBefore + 1);

    vi.advanceTimersByTime(sessionIdlePolicy("CODEX").idleMs - 1);
    expect(warm.has("idle")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(warm.has("idle")).toBe(false);
    vi.useRealTimers();
    await warm.retired();
    expect(idle.connection.alive).toBe(false);
    expect(taken.connection.alive).toBe(true);
    expect(armedIdleCount()).toBe(armedBefore);
  });

  it("refuse an app-server's request while no turn is running, and keep the thread's token total", async () => {
    const warm = codexWarmSessions<null>("instance-c");
    const kept = session();
    const lines = createInterface({ input: kept.connection.child.stdout });
    const replies: any[] = [];
    lines.on("line", (line) => replies.push(JSON.parse(line)));
    warm.keep("thread-1", kept);
    // The child echoes, so what is written to it comes back as if the app-server had sent it.
    kept.connection.write({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "helper-thread", tokenUsage: { total: { inputTokens: 900, outputTokens: 900 } } } });
    kept.connection.write({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "native-1", tokenUsage: { total: { inputTokens: 14, outputTokens: 6, cachedInputTokens: 8 } } } });
    kept.connection.write({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "rm -rf scratch" } });
    await expect.poll(() => replies.find((reply) => reply.id === 100 && reply.error)).toMatchObject({ error: { code: -32601 } });
    expect(replies.some((reply) => reply.id === 100 && reply.result !== undefined)).toBe(false);
    expect(kept.connection.usageTotal).toEqual({ input: 14, output: 6, cachedInput: 8 });
    await warm.closeAll("test");
    expect(kept.connection.alive).toBe(false);
  });

  it("keep nothing when switched off", () => {
    vi.stubEnv("OMB_CODEX_SESSION_KEEP", "0");
    const warm = codexWarmSessions<null>("instance-d");
    expect(warm.keep("thread-1", session())).toBe(false);
    vi.unstubAllEnvs();
  });
});
