import { copyFileSync, appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineCompactResult, ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { flushNativeLog } from "./native.ts";
import { NATIVE_DIR } from "../config.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const MODEL = "gpt-fake-default";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (condition: () => boolean, what: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((wake) => setTimeout(wake, 10));
  }
};

describe("Codex's own compaction of a kept app-server's thread (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let home: string;
  let log: string;
  let cli = FAKE_CLI;
  let thread: number;

  const create = async (environment: Record<string, string> = {}, options: { cli?: string; endpoint?: { url: string; models: string[] } } = {}) => {
    instance = await CodexDriver.create({
      instanceId: "codex-compact-test", displayName: "Codex Test", enabled: true,
      environment: { HOME: scratch, USERPROFILE: scratch, CODEX_HOME: home, FAKE_CODEX_MODE: "resume", FAKE_CODEX_CALL_LOG: log, FAKE_CODEX_THREAD_IDS: "distinct",
        FAKE_CODEX_INTERRUPT_GRACE_MS: "300", ...(options.endpoint ? { OPENMAUSBOT_CODEX_API_KEY: "synthetic-endpoint-key" } : {}), ...environment },
      config: { cli: options.cli ?? cli, fullAuto: false, ...(options.endpoint ? { endpoint: options.endpoint } : {}) },
    });
    recorder = recordEvents(instance.adapter);
  };
  const calls = (method?: string): Array<{ pid: number; method: string; params: any }> =>
    (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []).filter((call) => !method || call.method === method);
  const runTurn = async (threadId: string, text: string, resumeCursor?: string) => {
    const { turnId } = await instance.adapter.sendTurn({ threadId, text, model: MODEL, ...(resumeCursor ? { resumeCursor } : {}) });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const started = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId) as { sessionId: string } | undefined;
    return { done, session: started!.sessionId, events: recorder.events.filter((event) => event.turnId === turnId) };
  };
  const compact = (threadId: string, session: string, options: { signal?: AbortSignal; model?: string; selectionNow?: () => { instanceId: string; model: string } } = {}): Promise<EngineCompactResult> =>
    instance.adapter.compactSession!(threadId, { session, model: options.model ?? MODEL, ...(options.selectionNow ? { selectionNow: options.selectionNow } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  const pidOf = () => calls("turn/start").at(-1)!.pid;
  const closes = (threadId: string) => {
    flushNativeLog(threadId);
    return readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((entry) => entry.source === "codex.session").map((entry) => entry.msg);
  };
  const kept = async (environment: Record<string, string> = {}, options: { cli?: string } = {}) => {
    await create(environment, options);
    const threadId = `t-compact-${++thread}`;
    const first = await runTurn(threadId, "one");
    const pid = pidOf();
    await until(() => calls("config/read").filter((call) => call.pid === pid).length >= 2, "the kept process's configuration re-read");
    return { threadId, session: first.session, pid };
  };
  const authenticate = (account: string) => writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account, access_token: "token" } }));

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-compact-"));
    home = join(scratch, ".codex");
    mkdirSync(home);
    mkdirSync(NATIVE_DIR, { recursive: true });
    authenticate("account-1");
    writeFileSync(join(home, "config.toml"), "model_reasoning_summary = \"none\"\n");
    log = join(scratch, "calls.ndjson");
    cli = FAKE_CLI;
    thread = 0;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      await instance?.dispose();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("compacts on the kept process with no new process, thread or handshake, and the next turn goes on in it", async () => {
    const { threadId, session, pid } = await kept();
    const before = recorder.events.length;
    await expect(compact(threadId, session)).resolves.toEqual({ ok: true, usage: null, model: MODEL });
    expect(calls("thread/compact/start")).toEqual([{ pid, method: "thread/compact/start", params: { threadId: session } }]);
    expect(recorder.events.slice(before).filter((event) => event.type === "context.compacted" || event.type === "turn.started" || event.type === "turn.completed")).toEqual([]);
    expect(alive(pid)).toBe(true);
    expect(instance.adapter.hasSession(threadId)).toBe(false);

    const second = await runTurn(threadId, "two", session);
    expect(second.done).toMatchObject({ ok: true, usage: { input: 7, output: 3, cachedInput: 4 } });
    expect(calls("turn/start").map((call) => [call.pid, call.params.threadId])).toEqual([[pid, session], [pid, session]]);
    expect(calls("initialize").filter((call) => call.pid === pid)).toHaveLength(1);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("thread/resume")).toHaveLength(0);
    expect(second.events.find((event) => event.type === "session.started")).toMatchObject({ sessionId: session });
  });

  it("confirms the configuration on the connection itself, after the re-read the last turn started, and before it asks to compact", async () => {
    const { threadId, session, pid } = await kept();
    await compact(threadId, session);
    const order = calls().filter((call) => call.pid === pid).map((call) => call.method);
    expect(order.slice(order.indexOf("turn/start"))).toEqual(["turn/start", "config/read", "config/read", "thread/compact/start"]);
  });

  it("serves a conversation in its own process only: a session that is not the kept one, or no kept process, sends nothing and starts nothing", async () => {
    const { threadId, session, pid } = await kept();
    const launches = () => calls("initialize").length + calls("thread/start").length;
    const before = launches();
    await expect(compact("t-nothing-kept", "codex-thread-x")).resolves.toMatchObject({ ok: false });
    expect(launches()).toBe(before);
    await expect(compact(threadId, "codex-thread-other")).resolves.toMatchObject({ ok: false });
    await expect(compact("t-another-conversation", session)).resolves.toMatchObject({ ok: false });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(launches()).toBe(before);
    expect(alive(pid)).toBe(true);
  });

  it("refuses when the account was signed into another one since the last turn, with the same configuration, sending nothing to the old process", async () => {
    const { threadId, session, pid } = await kept();
    authenticate("account-2");
    const result = await compact(threadId, session);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("login") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
    expect(closes(threadId).at(-1)).toMatchObject({ close: expect.stringContaining("login") });
  });

  it("refuses when the account changed while its configuration was being read, before the request is sent", async () => {
    const hold = join(scratch, "config-hold");
    const { threadId, session, pid } = await kept({ FAKE_CODEX_CONFIG_HOLD_FILE: hold });
    writeFileSync(hold, "");
    const pending = compact(threadId, session);
    await until(() => calls("config/read").filter((call) => call.pid === pid).length >= 3, "the configuration read the compaction makes");
    authenticate("account-2");
    rmSync(hold);
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining("login") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("refuses when the model's provider changed while the configuration was being read, before the request is sent", async () => {
    const hold = join(scratch, "config-hold");
    const { threadId, session, pid } = await kept({ FAKE_CODEX_CONFIG_HOLD_FILE: hold });
    writeFileSync(hold, "");
    let model = MODEL;
    const pending = compact(threadId, session, { selectionNow: () => ({ instanceId: "codex-compact-test", model }) });
    await until(() => calls("config/read").filter((call) => call.pid === pid).length >= 3, "the configuration read the compaction makes");
    model = "magpie::m1";
    rmSync(hold);
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining("provider") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("refuses when the conversation moved to another engine instance with a model of the same name while the configuration was being read", async () => {
    const hold = join(scratch, "config-hold");
    const { threadId, session, pid } = await kept({ FAKE_CODEX_CONFIG_HOLD_FILE: hold });
    writeFileSync(hold, "");
    let instanceId = "codex-compact-test";
    const pending = compact(threadId, session, { selectionNow: () => ({ instanceId, model: MODEL }) });
    await until(() => calls("config/read").filter((call) => call.pid === pid).length >= 3, "the configuration read the compaction makes");
    instanceId = "another-codex";
    rmSync(hold);
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining("instance") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("holds one login across a token the CLI renewed", async () => {
    const { threadId, session } = await kept();
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "account-1", access_token: "renewed" } }));
    await expect(compact(threadId, session)).resolves.toMatchObject({ ok: true });
  });

  it("refuses when config.toml changed since the last turn", async () => {
    const { threadId, session, pid } = await kept();
    writeFileSync(join(home, "config.toml"), "model_reasoning_summary = \"auto\"\n");
    expect(await compact(threadId, session)).toMatchObject({ ok: false, reason: expect.stringContaining("config") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("refuses when the CLI was replaced in place since the last turn", async () => {
    cli = join(scratch, "fake-codex.ts");
    copyFileSync(FAKE_CLI, cli);
    chmodSync(cli, 0o755);
    const { threadId, session, pid } = await kept();
    appendFileSync(cli, "\n// updated in place\n");
    expect(await compact(threadId, session)).toMatchObject({ ok: false, reason: expect.stringContaining("cli") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("refuses when the configuration the process reports now is not the one it ended its turn with", async () => {
    const rules = join(scratch, "native-rules.txt");
    const { threadId, session, pid } = await kept({ FAKE_CODEX_INSTRUCTIONS_FILE: rules });
    writeFileSync(rules, "Native rules written after the turn.");
    expect(await compact(threadId, session)).toMatchObject({ ok: false, reason: expect.stringContaining("configuration changed") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("treats a configuration read that fails as a check that failed, not as one that passed", async () => {
    const broken = join(scratch, "config-broken");
    const { threadId, session, pid } = await kept({ FAKE_CODEX_CONFIG_ERROR_FILE: broken });
    writeFileSync(broken, "");
    expect(await compact(threadId, session)).toMatchObject({ ok: false, reason: expect.stringContaining("confirm") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("refuses a model of another provider than the thread's, which the next turn would not resume", async () => {
    const { threadId, session, pid } = await kept();
    expect(await compact(threadId, session, { model: "magpie::m1" })).toMatchObject({ ok: false, reason: expect.stringContaining("provider") });
    expect(calls("thread/compact/start")).toEqual([]);
    expect(alive(pid)).toBe(false);
    const again = await runTurn(threadId, "two", session);
    expect(again.done).toMatchObject({ ok: true });
    expect(calls("thread/resume")).toHaveLength(1);
  });

  describe("a configuration read that never answers", () => {
    it.each(["deadline", "stop", "exit", "stopAll"] as const)("ends on %s with the connection closed, and the conversation's next message goes through", async (how) => {
      if (how === "deadline") vi.stubEnv("FAKE_CODEX_COMPACT_TIMEOUT_MS", "300");
      const { threadId, session, pid } = await kept({ FAKE_CODEX_CONFIG_HANG_AFTER_TURNS: "1" });
      const stop = new AbortController();
      const pending = compact(threadId, session, { signal: stop.signal });
      await until(() => instance.adapter.hasSession(threadId), "the compaction to take the thread");
      if (how === "stop") stop.abort();
      if (how === "exit") process.kill(pid, "SIGKILL");
      if (how === "stopAll") void instance.adapter.stopAll();
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(calls("thread/compact/start")).toEqual([]);
      await until(() => !alive(pid), "the connection to close");
      expect(instance.adapter.hasSession(threadId)).toBe(false);
      const next = await runTurn(threadId, "carry on", session);
      expect(next.done).toMatchObject({ ok: true });
      expect(calls("thread/resume")).toHaveLength(1);
    }, 30_000);
  });

  describe("the compaction's own configuration read never answering", () => {
    it.each(["deadline", "stop", "exit"] as const)("ends on %s with the connection closed and no request sent, and the conversation's next message goes through", async (how) => {
      if (how === "deadline") vi.stubEnv("FAKE_CODEX_COMPACT_TIMEOUT_MS", "300");
      const hang = join(scratch, "config-hang");
      const { threadId, session, pid } = await kept({ FAKE_CODEX_CONFIG_HANG_FILE: hang });
      writeFileSync(hang, "");
      const stop = new AbortController();
      const pending = compact(threadId, session, { signal: stop.signal });
      await until(() => calls("config/read").filter((call) => call.pid === pid).length >= 3, "the configuration read the compaction makes");
      if (how === "stop") stop.abort();
      if (how === "exit") process.kill(pid, "SIGKILL");
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(calls("thread/compact/start")).toEqual([]);
      await until(() => !alive(pid), "the connection to close");
      expect(instance.adapter.hasSession(threadId)).toBe(false);
      rmSync(hang);
      const next = await runTurn(threadId, "carry on", session);
      expect(next.done).toMatchObject({ ok: true });
      expect(calls("thread/resume")).toHaveLength(1);
    }, 30_000);
  });

  describe("a compaction in flight", () => {
    it("holds the thread, and is ended with its connection by stopAll", async () => {
      const { threadId, session, pid } = await kept({ FAKE_CODEX_COMPACT: "hang" });
      const pending = compact(threadId, session);
      await until(() => calls("thread/compact/start").length === 1, "the compaction request");
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      expect(instance.adapter.enginePid?.(threadId)).toBe(pid);
      await instance.adapter.stopAll();
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(alive(pid)).toBe(false);
      await expect(compact(threadId, session)).resolves.toMatchObject({ ok: false });
    });

    it("is ended with its connection when the provider is removed", async () => {
      const { threadId, session, pid } = await kept({ FAKE_CODEX_COMPACT: "hang" });
      const pending = compact(threadId, session);
      await until(() => calls("thread/compact/start").length === 1, "the compaction request");
      await instance.dispose();
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(alive(pid)).toBe(false);
      await expect(compact(threadId, session)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("removed") });
    });

    it("interrupts the compaction's own turn when stopped, then closes the connection", async () => {
      const { threadId, session, pid } = await kept({ FAKE_CODEX_COMPACT: "hang" });
      const stop = new AbortController();
      const pending = compact(threadId, session, { signal: stop.signal });
      await until(() => calls("thread/compact/start").length === 1, "the compaction request");
      stop.abort();
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(calls("turn/interrupt")).toEqual([{ pid, method: "turn/interrupt", params: { threadId: session, turnId: "compact-turn-1" } }]);
      expect(alive(pid)).toBe(false);
      expect((await runTurn(threadId, "carry on", session)).done).toMatchObject({ ok: true });
    });

    it("fails at its deadline, with the connection closed", async () => {
      vi.stubEnv("FAKE_CODEX_COMPACT_TIMEOUT_MS", "400");
      const { threadId, session, pid } = await kept({ FAKE_CODEX_COMPACT: "hang" });
      await expect(compact(threadId, session)).resolves.toMatchObject({ ok: false, reason: "timed out" });
      expect(alive(pid)).toBe(false);
    });

    it("fails when the process exits under it", async () => {
      const { threadId, session, pid } = await kept({ FAKE_CODEX_COMPACT: "hang" });
      const pending = compact(threadId, session);
      await until(() => calls("thread/compact/start").length === 1, "the compaction request");
      process.kill(pid, "SIGKILL");
      await expect(pending).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("exited") });
    });

    it.each(["error", "unsupported"])("fails when Codex answers the request with an error (%s), and does not return the connection", async (mode) => {
      const { threadId, session, pid } = await kept({ FAKE_CODEX_COMPACT: mode });
      await expect(compact(threadId, session)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("refused") });
      expect(alive(pid)).toBe(false);
      expect(closes(threadId).at(-1)).toMatchObject({ close: expect.stringContaining("compaction not completed") });
    });
  });

  it("settles on the compaction's own turn, not on a helper thread's completion or usage", async () => {
    const hold = join(scratch, "compact-hold");
    const { threadId, session } = await kept({ FAKE_CODEX_COMPACT_HELPER: "1", FAKE_CODEX_COMPACT_HOLD_FILE: hold });
    flushNativeLog(threadId);
    rmSync(join(NATIVE_DIR, `${threadId}.ndjson`), { force: true });
    writeFileSync(hold, "");
    let finished = false;
    const pending = compact(threadId, session).then((result) => { finished = true; return result; });
    await until(() => {
      flushNativeLog(threadId);
      const file = join(NATIVE_DIR, `${threadId}.ndjson`);
      return existsSync(file) && readFileSync(file, "utf8").includes('"itemType":"marker"');
    }, "the notification the app-server sent after the helper's");
    expect(finished).toBe(false);
    rmSync(hold);
    await expect(pending).resolves.toEqual({ ok: true, usage: null, model: MODEL });
    const next = await runTurn(threadId, "two", session);
    expect(next.done).toMatchObject({ ok: true, usage: { input: 7, output: 3, cachedInput: 4 } });
  });

  it("names a Fast turn's base model, because the compaction runs on the thread's own tier", async () => {
    await create();
    const threadId = "t-fast";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "one", model: `${MODEL}+priority` });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const started = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId) as { sessionId: string };
    await until(() => calls("config/read").length >= 2, "the kept process's configuration re-read");
    await expect(compact(threadId, started.sessionId, { model: `${MODEL}+priority` })).resolves.toMatchObject({ ok: true, model: MODEL });
  });

  it("keeps a custom endpoint model's +suffix whole: only a service tier a turn applied is the base model's", async () => {
    const model = "vendor/model+preview";
    await create({}, { endpoint: { url: "http://127.0.0.1:1/v1", models: [model] } });
    const threadId = "t-suffix";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "one", model });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const started = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId) as { sessionId: string };
    await until(() => calls("config/read").length >= 2, "the kept process's configuration re-read");
    await expect(compact(threadId, started.sessionId, { model })).resolves.toMatchObject({ ok: true, model });
  });

  it("names the model the kept process last ran, not the one selected since", async () => {
    const { threadId, session } = await kept();
    await expect(compact(threadId, session, { model: "gpt-another-model" })).resolves.toMatchObject({ ok: true, model: MODEL });
  });

  it("returns the usage Codex reported for the compaction, and the next turn counts from there", async () => {
    const { threadId, session } = await kept({ FAKE_CODEX_COMPACT_USAGE: JSON.stringify({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 20 }) });
    await expect(compact(threadId, session)).resolves.toEqual({ ok: true, usage: { input: 50, output: 5, cachedInput: 20 }, model: MODEL });
    const next = await runTurn(threadId, "two", session);
    expect(next.done).toMatchObject({ ok: true, usage: { input: 7, output: 3, cachedInput: 4 } });
  });

  it("returns no usage, and leaves the next turn's count alone, when Codex sends no usage notification at all", async () => {
    const { threadId, session } = await kept({ FAKE_CODEX_COMPACT_NO_USAGE: "1" });
    await expect(compact(threadId, session)).resolves.toEqual({ ok: true, usage: null, model: MODEL });
    const next = await runTurn(threadId, "two", session);
    expect(next.done).toMatchObject({ ok: true, usage: { input: 7, output: 3, cachedInput: 4 } });
  });

  it("returns the connection to a pool that closes it with the rest when the provider is removed", async () => {
    const { threadId, session, pid } = await kept();
    await compact(threadId, session);
    expect(alive(pid)).toBe(true);
    await instance.dispose();
    expect(alive(pid)).toBe(false);
  });
});
