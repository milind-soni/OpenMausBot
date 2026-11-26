import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as procs from "../procs.ts";
import { CodexConnection, codexConfigDigest, codexContractDiff, codexIdentityInputs, codexLoginIdentity, codexOutsideIdentity, codexOwnLogin, codexSpawnContract, codexWarmSessions, type KeptCodex } from "./codex-warm.ts";
import { armedIdleCount, sessionIdlePolicy } from "./session-idle.ts";

const children: ChildProcessWithoutNullStreams[] = [];
/** Stays up, and echoes each line it is sent. */
const idleChild = () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout); setInterval(() => {}, 1000);"], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
};
const session = (overrides: Partial<KeptCodex<null>> = {}): KeptCodex<null> => ({
  connection: new CodexConnection(idleChild()), contract: "{}", nativeThreadId: "native-1", configDigest: "config", cwd: "/work", identity: { cli: "codex-not-installed", env: { PATH: "/nowhere", CODEX_HOME: "/nowhere" }, ownLogin: false }, provider: null, model: null, carried: null, ...overrides,
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

  it("computes what can change outside OpenMausBot, config.toml, the CLI and the login, exactly as the contract does", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-identity-"));
    const write = (account: string) => writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account, access_token: "t" } }));
    writeFileSync(join(home, "config.toml"), "model = \"a\"\n");
    write("account-1");
    const env = { PATH: "/nowhere", CODEX_HOME: home, SECRET: "not part of it" };
    const made = (login: string | null) => JSON.parse(codexSpawnContract({ cli: "codex-not-installed", args: [], env, cwd: "/work", box: {}, thread: {}, login }));
    const inputs = codexIdentityInputs("codex-not-installed", env, true);
    expect(inputs.env).toEqual({ CODEX_HOME: home, HOME: undefined, USERPROFILE: undefined, PATH: "/nowhere" });
    const before = codexOutsideIdentity(inputs);
    expect(before).toEqual({ config: made(codexOwnLogin(true, env)).config, cli: made(null).cli, login: made(codexOwnLogin(true, env)).login });
    expect(before.login).not.toBeNull();
    write("account-2");
    expect(codexOutsideIdentity(inputs)).toEqual({ ...before, login: codexOwnLogin(true, env) });
    expect(codexOutsideIdentity(inputs).login).not.toBe(before.login);
    writeFileSync(join(home, "config.toml"), "model = \"b\"\n");
    expect(codexOutsideIdentity(inputs).config).not.toBe(before.config);
    expect(codexOutsideIdentity(codexIdentityInputs("codex-not-installed", env, false)).login).toBeNull();
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

describe("a kept app-server lent for work of its own", () => {
  const answeringChild = () => {
    const child = spawn(process.execPath, ["-e", `let held = null; process.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\\n").filter(Boolean)) { const message = JSON.parse(line);
      if (message.method === "config/read") held = message.id; else if (message.release && held !== null) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: held, result: { config: { reread: true } } }) + "\\n"); } }); setInterval(() => {}, 1000);`], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    return child;
  };

  it("leaves the pool while lent, keeps no idle timer, and goes back with a new one", async () => {
    const warm = codexWarmSessions<null>("lend-a");
    const armedBefore = armedIdleCount();
    const kept = session();
    warm.keep("thread-1", kept);
    expect(armedIdleCount()).toBe(armedBefore + 1);
    expect(warm.lend("thread-2", "native-1")).toBeNull();
    expect(warm.lend("thread-1", "native-other")).toBeNull();
    expect(warm.has("thread-1")).toBe(true);
    const lease = warm.lend("thread-1", "native-1")!;
    expect(lease.session).toBe(kept);
    expect(warm.has("thread-1")).toBe(false);
    expect(armedIdleCount()).toBe(armedBefore);
    expect(warm.take("thread-1", "{}", "native-1")).toBeNull();
    expect(warm.keep("thread-1", session())).toBe(false);
    await lease.release();
    expect(warm.has("thread-1")).toBe(true);
    expect(armedIdleCount()).toBe(armedBefore + 1);
    expect(kept.connection.alive).toBe(true);
    expect(warm.take("thread-1", "{}", "native-1")).toBe(kept);
    expect(armedIdleCount()).toBe(armedBefore);
  });

  it("lends nothing that is not alive", async () => {
    const warm = codexWarmSessions<null>("lend-b");
    const dying = session();
    warm.keep("thread-1", dying);
    const exited = once(dying.connection.child, "exit");
    dying.connection.child.kill("SIGKILL");
    await exited;
    expect(warm.lend("thread-1", "native-1")).toBeNull();
  });

  it("settles once the configuration re-read after the last turn has landed", async () => {
    const warm = codexWarmSessions<null>("lend-c");
    const kept = session({ connection: new CodexConnection(answeringChild()), configDigest: "from the turn" });
    warm.keep("thread-1", kept);
    const lease = warm.lend("thread-1", "native-1")!;
    let settled = false;
    void lease.settled.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(kept.configDigest).toBe("from the turn");
    kept.connection.write({ release: true });
    await lease.settled;
    expect(kept.configDigest).toBe(codexConfigDigest({ reread: true }));
    await lease.release();
    await warm.closeAll("test");
  });

  it("is ended by closeAll while lent, and is not put back afterwards", async () => {
    const warm = codexWarmSessions<null>("lend-d");
    const armedBefore = armedIdleCount();
    const kept = session();
    warm.keep("thread-1", kept);
    const lease = warm.lend("thread-1", "native-1")!;
    await warm.closeAll("signed out");
    expect(lease.invalidated).toBe(true);
    expect(kept.connection.alive).toBe(false);
    await lease.release();
    expect(warm.has("thread-1")).toBe(false);
    expect(armedIdleCount()).toBe(armedBefore);
  });

  it("refuses a new loan while closeAll is closing", async () => {
    const warm = codexWarmSessions<null>("lend-e");
    const lent = session(), other = session();
    warm.keep("thread-1", lent);
    warm.keep("thread-2", other);
    const lease = warm.lend("thread-1", "native-1")!;
    const closing = warm.closeAll("signed out");
    expect(warm.lend("thread-2", "native-1")).toBeNull();
    await closing;
    expect(lease.invalidated).toBe(true);
    expect(other.connection.alive).toBe(false);
  });

  it("makes a discard wait until the tree is gone, retrying a kill that did not take, while retired() waits only for the first attempt", async () => {
    vi.stubEnv("FAKE_CODEX_STOP_RETRY_MS", "300");
    let kills = 0;
    vi.spyOn(procs, "killCliTree").mockImplementation(async (child) => {
      if (++kills === 1) return false;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      return true;
    });
    const warm = codexWarmSessions<null>("lend-g");
    const stubborn = session();
    warm.keep("thread-1", stubborn);
    const lease = warm.lend("thread-1", "native-1")!;
    let discarded = false;
    const discarding = lease.discard("test").then(() => { discarded = true; });
    await warm.retired();
    expect(discarded).toBe(false);
    expect(kills).toBe(1);
    await discarding;
    expect(kills).toBe(2);
    expect(stubborn.connection.alive).toBe(false);
    vi.unstubAllEnvs();
  });

  describe("a lent process whose first kill did not take", () => {
    const stubbornKill = () => {
      const state = { kills: 0 };
      vi.stubEnv("FAKE_CODEX_STOP_RETRY_MS", "300");
      vi.spyOn(procs, "killCliTree").mockImplementation(async (child) => {
        if (++state.kills === 1) return false;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        return true;
      });
      return state;
    };

    it("is waited for by closeAll while it is lent, but only for its first attempt by retired()", async () => {
      const state = stubbornKill();
      const warm = codexWarmSessions<null>("lend-i");
      const lent = session();
      warm.keep("thread-1", lent);
      warm.lend("thread-1", "native-1");
      let closed = false;
      const closing = warm.closeAll("signed out").then(() => { closed = true; });
      await warm.retired();
      expect(closed).toBe(false);
      expect(state.kills).toBe(1);
      await closing;
      expect(state.kills).toBe(2);
      expect(lent.connection.alive).toBe(false);
      vi.unstubAllEnvs();
    });

    it("is waited for by closeAll while a discard is already retrying, and killed once more only", async () => {
      const state = stubbornKill();
      const warm = codexWarmSessions<null>("lend-j");
      const lent = session();
      warm.keep("thread-1", lent);
      const lease = warm.lend("thread-1", "native-1")!;
      const discarding = lease.discard("test");
      await warm.retired();
      expect(state.kills).toBe(1);
      await warm.closeAll("signed out");
      expect(lent.connection.alive).toBe(false);
      expect(state.kills).toBe(2);
      await discarding;
      vi.unstubAllEnvs();
    });
  });

  it("does not retry a kill that did not take when an idle close or closeAll ends a process, as before", async () => {
    vi.stubEnv("FAKE_CODEX_STOP_RETRY_MS", "1");
    let kills = 0;
    vi.spyOn(procs, "killCliTree").mockImplementation(async () => { kills++; return false; });
    const warm = codexWarmSessions<null>("lend-h");
    const idle = session(), other = session();
    warm.keep("thread-1", idle);
    warm.keep("thread-2", other);
    await warm.close("thread-1", "idle");
    await warm.closeAll("test");
    await warm.retired();
    expect(kills).toBe(2);
    vi.unstubAllEnvs();
  });

  it("goes back to nowhere when its process exited meanwhile, and discard ends the process", async () => {
    const warm = codexWarmSessions<null>("lend-f");
    const gone = session(), thrown = session();
    warm.keep("thread-1", gone);
    warm.keep("thread-2", thrown);
    const first = warm.lend("thread-1", "native-1")!;
    const exited = once(gone.connection.child, "exit");
    gone.connection.child.kill("SIGKILL");
    await exited;
    await first.release();
    expect(warm.has("thread-1")).toBe(false);
    const second = warm.lend("thread-2", "native-1")!;
    await second.discard("test");
    expect(thrown.connection.alive).toBe(false);
    expect(warm.has("thread-2")).toBe(false);
    await second.release();
    expect(warm.has("thread-2")).toBe(false);
  });
});
