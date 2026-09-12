// Claude driver contract tests, run against the scripted fake CLI in
// server/testing/fake-claude-cli.ts — the driver must normalize the
// stream-json protocol into canonical events, keep argv hygiene (prompt
// over stdin, secrets stripped), and broker permission asks.
//
// These used to be POSIX-only: the fake CLI is a shebang script Windows
// cannot exec, and the broker is a unix socket. Both now go through
// resolveCliSpawn / permissionSocketPath, so they run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  autoCompactWindow,
  brokerSocketCandidates,
  claudeCliSupports,
  claudeCliUpdate,
  ClaudeDriver,
  createPermissionBroker,
  parseClaudeCliVersion,
  permissionSocketPath,
  readClaudeAuthSettings,
  type ClaudeConfig,
} from "./claude.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as procs from "../procs.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

/** Thread ids for the four ask-id-collision tests. Each must truncate to a
 * unique 8-char tag so no two tests share a broker socket/pipe name. */
const COLLISION_THREAD_IDS = ["t-dup-1", "t-dup-2", "t-dup-3", "t-dup-4"];

/** Connect to a broker socket and resolve once the connection is live. */
function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let retriesLeft = 20;
    const tryConnect = () => {
      const conn = connect(path);
      const onConnect = () => {
        conn.removeListener("error", onError);
        resolve(conn);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        conn.removeListener("connect", onConnect);
        conn.destroy();
        // A Windows named pipe can briefly disappear while the server creates
        // its next pipe instance for another simultaneous client.
        if (process.platform === "win32" && error.code === "ENOENT" && retriesLeft-- > 0) {
          setTimeout(tryConnect, 25);
          return;
        }
        reject(error);
      };
      conn.once("connect", onConnect);
      conn.once("error", onError);
    };
    tryConnect();
  });
}

/** Returns a function that resolves, in order, with each `\n`-delimited JSON
 * message the broker writes back on `conn` — one call per expected answer. */
function answerQueue(conn: ReturnType<typeof connect>) {
  const waiters: Array<(msg: any) => void> = [];
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      waiters.shift()?.(JSON.parse(line));
    }
  });
  return () => new Promise<any>((resolve) => waiters.push(resolve));
}

describe("ClaudeDriver.decodeConfig", () => {
  it("defaults to the claude binary with acceptEdits", () => {
    expect(ClaudeDriver.decodeConfig({})).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
    expect(ClaudeDriver.decodeConfig(undefined)).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
  });

  it("accepts the three known permission modes", () => {
    for (const permissionMode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(ClaudeDriver.decodeConfig({ permissionMode }).permissionMode).toBe(permissionMode);
    }
  });

  it("throws on an invalid permissionMode (registry downgrades this to a shadow)", () => {
    expect(() => ClaudeDriver.decodeConfig({ permissionMode: "yolo" })).toThrow(/permissionMode/);
  });

  it("normalizes and deduplicates built-in tool lists", () => {
    expect(
      ClaudeDriver.decodeConfig({
        tools: [" Read ", "WebFetch", "Read"],
        disallowedTools: [" Bash(git *) ", "Bash(git *)"],
      }),
    ).toMatchObject({
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)"],
    });
    expect(ClaudeDriver.decodeConfig({ tools: [] }).tools).toEqual([]);
  });

  it.each([
    ["tools", "Read"],
    ["tools", ["Read", " "]],
    ["disallowedTools", [42]],
  ])("rejects invalid %s configuration", (field, value) => {
    expect(() => ClaudeDriver.decodeConfig({ [field]: value })).toThrow(new RegExp(field));
  });

  it.skipIf(process.platform !== "win32")("names permission pipes per harness process", () => {
    expect(permissionSocketPath("thread-abc")).toMatch(
      new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\openmausbot-perm-${process.pid}-thre[0-9a-f]{4}$`),
    );
  });

  it("keeps threads whose ids share a prefix on distinct sockets", () => {
    // the truncated prefix agrees; only the digest separates them — without
    // it, Windows pipes for these two threads would collide and race
    expect(permissionSocketPath("t-perm-dup-1")).not.toBe(permissionSocketPath("t-perm-dup-2"));
  });

  it("advertises per-bot local CUA but rejects legacy bypass turns without a mode", async () => {
    const bypass = await ClaudeDriver.create({
      instanceId: "claude-bypass",
      displayName: "Claude Bypass",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
    expect(bypass.adapter.capabilities.localComputerMcp).toBe(true);
    await expect(
      bypass.adapter.sendTurn({
        threadId: "t-bypass-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive approval broker/);
    // Settings may sign this account in and out on a hosted server.
    expect(bypass.startAuthentication).toBeTypeOf("function");
    expect(bypass.signOut).toBeTypeOf("function");
    await bypass.dispose();
  });

  it("gives each collision test a distinct broker pipe path", () => {
    const paths = COLLISION_THREAD_IDS.map((threadId) => permissionSocketPath(threadId));
    expect(new Set(paths).size).toBe(COLLISION_THREAD_IDS.length);
  });

  it("gives two bots distinct broker pipes even if they ever share a threadId (#1017)", () => {
    // A delegated child turn should never be able to collide with its
    // parent's still-open broker on the shared driver-level socket table —
    // whatever the reason a threadId is reused, namespacing by bot rules
    // the collision out by construction.
    const sharedThreadId = "t-shared-by-parent-and-child";
    const parentPath = permissionSocketPath(sharedThreadId, "bot-chief");
    const childPath = permissionSocketPath(sharedThreadId, "bot-cliff");
    expect(parentPath).not.toBe(childPath);
  });

  it("disposes its account controller while a logout is running", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-claude-logout-dispose-"));
    const cli = join(home, "fake-logout.mjs");
    const pidPath = join(home, "logout-pid");
    writeFileSync(cli, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'if (process.argv.slice(2).join(" ") !== "auth logout") process.exit(2);',
      'writeFileSync(join(process.env.HOME, "logout-pid"), String(process.pid));',
      'setInterval(() => {}, 1000);',
    ].join("\n"), { mode: 0o700 });
    const instance = await ClaudeDriver.create({
      instanceId: "claude-logout-dispose", displayName: "Fixture", enabled: true,
      config: { cli, permissionMode: "acceptEdits" },
      environment: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
    });
    const pending = instance.signOut!().catch(() => {});
    let pid: number | undefined;
    const alive = (value: number) => { try { process.kill(value, 0); return true; } catch { return false; } };
    try {
      await expect.poll(() => existsSync(pidPath), { timeout: 2500 }).toBe(true);
      pid = Number(readFileSync(pidPath, "utf8"));
      await instance.dispose();
      expect(alive(pid)).toBe(false);
      await expect(instance.signOut!()).rejects.toThrow("provider was removed");
    } finally {
      if (pid !== undefined && alive(pid)) {
        if (process.platform === "win32") process.kill(pid, "SIGKILL");
        else process.kill(-pid, "SIGKILL");
      }
      await pending;
      await instance.dispose();
      await removeTempDir(home);
    }
  });

  it("keeps the deterministic path as the first broker candidate", () => {
    const candidates = brokerSocketCandidates("t-candidates");
    expect(candidates[0]).toBe(permissionSocketPath("t-candidates"));
    if (process.platform === "win32") {
      // pipes are never unlinkable, so a held name needs fresh fallbacks
      expect(candidates.length).toBeGreaterThan(1);
      expect(new Set(candidates).size).toBe(candidates.length);
    } else {
      // macOS has a small Unix-socket path limit, so a deep HOME needs a
      // short fallback under the OS temp root.
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatch(/omb-perm-[0-9a-f]{16}\.sock$/);
      expect(candidates[1]).not.toBe(candidates[0]);
    }
  });

  // Windows can't listen on filesystem socket paths at all (EACCES), so the
  // unbindable-first-candidate unit runs on POSIX; the fake-CLI e2e below
  // covers the real pipe fallback on Windows CI.
  it.skipIf(process.platform === "win32")(
    "binds the next candidate when the first is unbindable, and asks round-trip on it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omb-broker-fallback-"));
      const held = join(dir, "held.sock");
      // a directory squats the path the way a hung child holds a pipe:
      // unlink fails, listen fails — the broker must move on, not go dark
      mkdirSync(held);
      const free = join(dir, "free.sock");
      const asks: Array<{ id: string }> = [];
      const broker = await createPermissionBroker({
        socketPaths: [held, free],
        onAsk: (ask) => asks.push(ask),
        onResolve: () => {},
      });
      try {
        expect(broker.socketPath).toBe(free);
        const conn = connect(free);
        await new Promise<void>((resolve, reject) => {
          conn.on("connect", resolve);
          conn.on("error", reject);
        });
        const answered = new Promise<{ behavior: string }>((resolve) => {
          let buf = "";
          conn.on("data", (c) => {
            buf += c;
            const nl = buf.indexOf("\n");
            if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
          });
        });
        conn.write(JSON.stringify({ t: "ask", id: "ask-fb", tool: "Bash", input: { command: "echo hi" } }) + "\n");
        await expect.poll(() => asks.length).toBe(1);
        expect(broker.answer("ask-fb", "allow")).toBe(true);
        expect(await answered).toMatchObject({ behavior: "allow" });
        conn.end();
      } finally {
        broker.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects instead of returning an occupied path when every candidate is unavailable",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omb-broker-unavailable-"));
      const heldOne = join(dir, "held-one.sock");
      const heldTwo = join(dir, "held-two.sock");
      mkdirSync(heldOne);
      mkdirSync(heldTwo);
      try {
        await expect(
          createPermissionBroker({
            socketPaths: [heldOne, heldTwo],
            onAsk: () => {},
            onResolve: () => {},
          }),
        ).rejects.toThrow(/could not bind a local socket/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("ClaudeDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    mode?: string,
    environment: Record<string, string> = {},
    config: Partial<ClaudeConfig> = {},
  ) => {
    if (mode) process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment,
      enabled: true,
      config: {
        ...config,
        cli: config.cli ?? FAKE_CLI,
        permissionMode: config.permissionMode ?? "acceptEdits",
      },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.FAKE_CLAUDE_PROMPTS;
    delete process.env.FAKE_CLAUDE_TRANSIENTS;
    delete process.env.FAKE_CLAUDE_PARTIAL_FAILS;
    delete process.env.FAKE_CLAUDE_STATE;
    delete process.env.FAKE_CLAUDE_RETRY_SCALE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OMB_TTS_KEY;
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MS;
    delete process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text
      "item.started", // tool tu-1
      "thread.token-usage.updated",
      "item.completed", // tool tu-1 result
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "claudeAgent")).toBe(true);
    // the chip names the tool; the command it ran rides beside it
    expect(recorder.events.find((e) => e.type === "item.started")).toMatchObject({ title: "Bash", summary: "echo hi" });

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 12, output: 5, cachedInput: 2 }); // input + cache_read, cache_read named
    const done = recorder.events.at(-1)!;
    // usage on the settle is the turn total from the result message, so
    // the harness has one figure to bank per turn
    expect(done).toMatchObject({ type: "turn.completed", ok: true, cost: 0.01, usage: { input: 12, output: 5, cachedInput: 2 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("streams partial-message text deltas without re-emitting the whole message", async () => {
    await create("stream");
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    const text = deltas.filter((d: any) => d.streamKind === "assistant_text");
    // two streamed chunks, and NO third full-text fallback delta after them
    expect(text.map((d: any) => d.delta)).toEqual(["hello from ", "fake claude"]);
    // subagent narration (parent_tool_use_id) never surfaces
    expect(text.some((d: any) => d.delta.includes("SUBAGENT"))).toBe(false);
    // reasoning streams on its own kind
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "hmm")).toBe(true);
    // the settled message still lands exactly once
    const settled = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("hello from fake claude");
  });

  it("turns a signed-out CLI into a setup error, not a bot reply", async () => {
    // issue #674: the CLI answers a signed-out turn with "Please run /login",
    // a command this app has no terminal to run. Relaying it as assistant
    // text left the user in a dead end; `setup: true` is what the chat reads
    // to offer the sign-in card instead.
    await create("not-logged-in");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const failure = recorder.events.find((e: any) => e.type === "runtime.error") as any;
    expect(failure).toMatchObject({ message: "Not logged in \u00b7 Please run /login", setup: true });
    // the CLI's instruction must not also land as something the bot said
    expect(recorder.events.some((e: any) => e.type === "item.completed" && e.itemType === "assistant_text")).toBe(false);
    expect(recorder.events.some((e: any) => e.type === "content.delta")).toBe(false);
    // the same vocabulary codex and the ACP engines settle an unauthenticated
    // turn with — not the CLI's "stop_sequence", which says nothing
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "auth_required" });
  });

  it("keeps a workspace Anthropic key set on purpose while still dropping one from the parent env", async () => {
    await create(undefined, { ANTHROPIC_API_KEY: "sk-ant-workspace-fixture" });
    const dump = join(scratch, "dump-workspace-key.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    await instance.adapter.sendTurn({ threadId: "t-workspace-key", text: "hello" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.ANTHROPIC_API_KEY).toBe("sk-ant-workspace-fixture");
  });

  it("keeps user and system prompts off argv and strips identity env vars", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    // workspace credentials the harness may hold (env-injected at boot by
    // the desktop shell) must never ride into the CLI child
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "the secret prompt", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.stringify(seen.argv)).not.toContain("the secret prompt");
    expect(JSON.stringify(seen.argv)).not.toContain("You are Testy.");
    expect(seen.prompt).toMatchObject({ type: "user", message: { role: "user", content: "the secret prompt" } });
    expect(seen.argv).toContain("--append-system-prompt-file");
    expect(seen.systemPrompt).toBe("You are Testy.");
    expect(existsSync(seen.argv[seen.argv.indexOf("--append-system-prompt-file") + 1])).toBe(false);
    expect(seen.argv).toContain("--session-id");
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.CLAUDECODE).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
  });

  it("per-bot Ask restores the broker on a legacy bypass instance", async () => {
    await create(undefined, {}, { permissionMode: "bypassPermissions" });
    const dump = join(scratch, "ask-overrides-bypass.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-ask-overrides-bypass",
      text: "go",
      approvalMode: "ask",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(seen.argv).toContain("--permission-prompt-tool");
  });

  it.each(["claude-sonnet-5", "claude-fable-5"])("reapplies Full, Auto, and Ask on the same resumed %s conversation", async (model) => {
    await create(undefined, {}, { permissionMode: "bypassPermissions" });
    const dump = join(scratch, "approval-transitions.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    for (const [approvalMode, nativeMode] of [["full", "bypassPermissions"], ["auto", "auto"], ["edits", "acceptEdits"], ["ask", "default"]] as const) {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-mode-transitions",
        text: "hello",
        model,
        approvalMode,
        resumeCursor: "11111111-1111-4111-8111-111111111111",
      });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe(model);
      expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe(nativeMode);
      expect(seen.argv.includes("--permission-prompt-tool")).toBe(approvalMode !== "full");
      expect(seen.argv).toContain("--resume");
    }
  });

  it("keeps questions answerable in per-bot Full access", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-full-question", text: "go", approvalMode: "full" });
    const conn = await connectSocket(permissionSocketPath("t-full-question"));
    try {
      conn.write(JSON.stringify({ t: "ask", kind: "question", id: "full-question", tool: "ask_user", input: { question: "Which account?" } }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(opened).toMatchObject({ requestType: "question" });
      expect(await instance.adapter.respondToRequest("t-full-question", (opened as { requestId: string }).requestId, { behavior: "answer", message: "Work" })).toBe("answered");
    } finally {
      conn.destroy();
    }
  });

  it("turns Claude's own AskUserQuestion into a question card, not an approval", async () => {
    // The CLI routes AskUserQuestion through --permission-prompt-tool like
    // any other tool use. Left as a permission it offers Deny / Always allow
    // / Allow once over a question, and answering it "allow" throws the
    // answer away — so the ask has to arrive as a question with its options.
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-structured-ask", text: "go" });
    const conn = await connectSocket(permissionSocketPath("t-structured-ask"));
    try {
      conn.write(JSON.stringify({
        t: "ask",
        kind: "question",
        id: "structured-ask",
        tool: "AskUserQuestion",
        input: {
          questions: [{
            question: "Which model should this bot run on?",
            header: "Model",
            options: [{ label: "Opus 5", description: "What it had before." }, { label: "Sonnet 5" }],
          }],
        },
      }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened") as {
        requestType: string;
        summary: string;
        requestId: string;
        questions?: { question: string; header?: string; options: { label: string }[] }[];
        choices?: string[];
      };
      expect(opened.requestType).toBe("question");
      expect(opened.summary).toBe("Which model should this bot run on?");
      expect(opened.questions?.[0]).toMatchObject({ question: "Which model should this bot run on?", header: "Model" });
      // flat labels too, so the phone companions can still answer
      expect(opened.choices).toEqual(["Opus 5", "Sonnet 5"]);
      expect(
        await instance.adapter.respondToRequest("t-structured-ask", opened.requestId, {
          behavior: "answer",
          message: "The user answered your questions.\n\nQ: Which model should this bot run on?\nA: Opus 5",
        }),
      ).toBe("answered");
    } finally {
      conn.destroy();
    }
  });

  it("never lets a PERMISSION take its buttons or its summary from a nested questions[]", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-lbl", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-perm-lbl"));
    // A permission ask whose arguments happen to carry `questions`. The
    // companion renders card.options AS the decision and maps every label
    // that is not "Allow" to a denial, so model-authored labels here mean
    // both buttons deny while "Always allow" writes a real grant first.
    conn.write(
      JSON.stringify({
        t: "ask",
        id: "ask-lbl",
        tool: "mcp__x__wire",
        input: {
          questions: [{ question: "Send the payroll export?", options: [{ label: "Yes" }, { label: "No" }] }],
          to: "acct-9",
          amount: 4200,
        },
      }) + "\n",
    );

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission" });
    expect((opened as { choices?: string[] }).choices).toBeUndefined();
    // and the arguments a person is actually deciding on are still shown
    expect((opened as { summary: string }).summary).toContain("acct-9");
    expect((opened as { summary: string }).summary).toContain("4200");

    conn.end();
    await instance.adapter.interruptTurn("t-perm-lbl");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("still shows an unknown permission tool's raw arguments — they are the whole decision", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-raw", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-perm-raw"));
    conn.write(
      JSON.stringify({ t: "ask", id: "ask-raw", tool: "mcp__x__wire", input: { amount: 4200, to: "acct-9" } }) + "\n",
    );

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", summary: '{"amount":4200,"to":"acct-9"}' });
    expect((opened as { choices?: string[] }).choices).toBeUndefined();

    conn.end();
    await instance.adapter.interruptTurn("t-perm-raw");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("answers to unknown or already-resolved asks resolve `unavailable` — typed, never a throw", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" })).resolves.toBe("unavailable");
    // and a thread with no turn at all is the same answer
    await expect(instance.adapter.respondToRequest("no-such-thread", "x", { behavior: "deny" })).resolves.toBe("unavailable");
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("sends attached images as native blocks before text without logging their bytes", async () => {
    await create();
    const dump = join(scratch, "dump-images.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);
    const pngPath = join(scratch, "one.png");
    const jpegPath = join(scratch, "two.jpg");
    writeFileSync(pngPath, png);
    writeFileSync(jpegPath, jpeg);

    await instance.adapter.sendTurn({
      threadId: "t-native-images",
      text: "describe both",
      images: [
        { path: pngPath, mime: "image/png", bytes: png.length },
        { path: jpegPath, mime: "image/jpeg", bytes: jpeg.length },
      ],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
          },
          { type: "text", text: "describe both" },
        ],
      },
    });

    const nativeLog = readFileSync(join(NATIVE_DIR, "t-native-images.ndjson"), "utf8");
    expect(nativeLog).not.toContain(png.toString("base64"));
    expect(nativeLog).not.toContain(jpeg.toString("base64"));
    const outgoing = nativeLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.dir === "out" && row.source === "claude.sdk.message")
      .at(-1);
    expect(outgoing.msg.message.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "[image data: 12 base64 chars]" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "[image data: 12 base64 chars]" },
      },
      { type: "text", text: "describe both" },
    ]);
  });

  it("launches with a Windows-sized system prompt without putting it on argv", async () => {
    await create();
    const dump = join(scratch, "dump-long-system.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const system = `room instructions\n${"context-0123456789".repeat(8_000)}`;

    await instance.adapter.sendTurn({ threadId: "t-long-system", text: "review this", system });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.systemPrompt).toBe(system);
    expect(JSON.stringify(seen.argv)).not.toContain("room instructions");
    expect(JSON.stringify(seen.argv).length).toBeLessThan(8_000);
  });

  it("uses instance credentials when launching an injected local model", async () => {
    await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-local-model",
      text: "hi",
      model: "unsloth::local-model",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("local-model");
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
  });

  it("injects a leftover API id when a local host is serving that model", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes(":8888")) {
        return new Response(JSON.stringify({ data: [{ id: "orcarouter/Qwen3.8-27B-Uncensored-GGUF" }] }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      await create(undefined, { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" });
      const dump = join(scratch, "dump-leftover.json");
      process.env.FAKE_CLAUDE_DUMP = dump;

      await instance.adapter.sendTurn({
        threadId: "t-leftover-local",
        text: "hi",
        model: "orcarouter/Qwen3.8-27B-Uncensored-GGUF",
      });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("orcarouter/Qwen3.8-27B-Uncensored-GGUF");
      expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
      expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe("unsloth-secret");
      expect(seen.env.ANTHROPIC_API_KEY).toBe("unsloth-secret");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it.each(["ask", "auto"] as const)("pre-allows the agents comms proxy while retaining native %s approval", async (approvalMode) => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "hi",
      approvalMode,
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok", OMB_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.agents).toMatchObject({
      alwaysLoad: true,
      args: ["/fake/agents-proxy.js"],
      env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok" },
    });
    // the config goes in a private file, never on argv, where `ps` would
    // show the comms token to every other user on the machine
    expect(JSON.stringify(seen.argv)).not.toContain("tok");
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
    expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe(approvalMode === "auto" ? "auto" : "default");
    expect(seen.argv).toContain("--permission-prompt-tool");
    expect(seen.mcpConfig.mcpServers.ogb.alwaysLoad).toBe(true);
  });

  it("keeps the session alive when only the volatile half of the prompt changed", async () => {
    await create();
    const dump = join(scratch, "volatile.json");
    const prompts = join(scratch, "volatile-prompts.jsonl");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_PROMPTS = prompts;

    await instance.adapter.sendTurn({
      threadId: "t-volatile",
      text: "one",
      system: "You are Testy.\n\nYour memory:\nlikes tea",
      systemStable: "You are Testy.",
      systemVolatile: "Your memory:\nlikes tea",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const firstPid = JSON.parse(readFileSync(dump, "utf8")).pid;

    recorder.events.length = 0;
    await instance.adapter.sendTurn({
      threadId: "t-volatile",
      text: "two",
      system: "You are Testy.\n\nYour memory:\nlikes tea, dislikes cloud kitchens",
      systemStable: "You are Testy.",
      systemVolatile: "Your memory:\nlikes tea, dislikes cloud kitchens",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    // Same process: a memory edit used to change the spawn contract, which
    // relaunched the CLI and made the provider re-cache the whole session.
    expect(seen.pid).toBe(firstPid);
    // and the model still learns what changed, inside this turn
    const sent = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(sent).toHaveLength(2);
    expect(sent[0].message.content).toBe("one");
    expect(sent[1].message.content).toContain("dislikes cloud kitchens");
    // the user's own words stay last, after the out-of-band note
    expect(sent[1].message.content.endsWith("two")).toBe(true);
  });

  it("still relaunches when the stable half of the prompt changes", async () => {
    await create();
    const dump = join(scratch, "stable.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-stable", text: "one", system: "You are Testy.", systemStable: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");
    const firstPid = JSON.parse(readFileSync(dump, "utf8")).pid;

    recorder.events.length = 0;
    await instance.adapter.sendTurn({ threadId: "t-stable", text: "two", system: "You are Grumpy.", systemStable: "You are Grumpy." });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).pid).not.toBe(firstPid);
  });

  it("launches a new session with the volatile half already in the system prompt", async () => {
    await create();
    const dump = join(scratch, "volatile-spawn.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-volatile-spawn",
      text: "hi",
      system: "You are Testy.\n\nYour memory:\nlikes tea",
      systemStable: "You are Testy.",
      systemVolatile: "Your memory:\nlikes tea",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.systemPrompt).toContain("likes tea");
    // a fresh process needs no in-turn note: the prompt already carries it
    const content = seen.prompt.message.content;
    const text = typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
    expect(text).toBe("hi");
  });

  it("compacts the CLI session at a window the harness picks", async () => {
    await create();
    const dump = join(scratch, "compact.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-compact", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--autocompact") + 1]).toBe("200000");
  });

  it("clamps a configured compaction window into the range the CLI accepts", () => {
    // out of range is a hard argument error in the CLI: it would fail every
    // turn, not degrade
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "50000" })).toBe("100000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "9000000" })).toBe("1000000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "150000" })).toBe("150000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "nonsense" })).toBe("200000");
    expect(autoCompactWindow({})).toBe("200000");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "auto" })).toBe("auto");
    expect(autoCompactWindow({ OMB_CLAUDE_AUTOCOMPACT: "off" })).toBe(null);
  });

  it("passes no compaction window when it is turned off", async () => {
    const dump = join(scratch, "compact-off.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, OMB_CLAUDE_AUTOCOMPACT: "off" });
    await instance.adapter.sendTurn({ threadId: "t-compact-off", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).not.toContain("--autocompact");
  });

  it("launches isolated from the machine's own Claude Code configuration", async () => {
    await create();
    const dump = join(scratch, "isolation.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-isolate", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    // Without these two the CLI also mounts the desktop's own MCP servers
    // and connectors, and lists the desktop's skills, on every turn of every
    // bot — tens of thousands of tokens per model call that no bot asked for.
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
  });

  it("inherits the machine's configuration again when the escape hatch is set", async () => {
    const dump = join(scratch, "inherit.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, OMB_CLAUDE_INHERIT_USER_CONFIG: "1" });

    await instance.adapter.sendTurn({ threadId: "t-inherit", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--strict-mcp-config");
    expect(seen.argv).not.toContain("--setting-sources");
  });

  it("preserves only the selected account's auth settings in a private file", async () => {
    const account = join(scratch, "account");
    mkdirSync(account);
    const settings = { apiKeyHelper: "echo synthetic-helper-key", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "synthetic-token", OMB_TTS_KEY: "must-not-leak" }, hooks: { SessionStart: [{ command: "must-not-run" }] }, permissions: { defaultMode: "bypassPermissions" } };
    writeFileSync(join(account, "settings.json"), JSON.stringify(settings));
    const dump = join(scratch, "account.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump }, { configDir: account });
    await instance.adapter.sendTurn({ threadId: "t-auth-settings", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.settings).toEqual({ apiKeyHelper: settings.apiKeyHelper, env: { ANTHROPIC_BASE_URL: settings.env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: "synthetic-token" } });
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(JSON.stringify(seen.argv)).not.toContain("synthetic");
    const settingsPath = seen.argv[seen.argv.indexOf("--settings") + 1];
    if (process.platform !== "win32") expect(seen.settingsMode).toBe(0o600);
    const log = readFileSync(join(NATIVE_DIR, "t-auth-settings.ndjson"), "utf8");
    expect(log).not.toContain("synthetic-token");
    expect(log).not.toContain(settings.apiKeyHelper);
    await instance.dispose();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("restarts a retained session when the selected account's auth changes", async () => {
    const account = join(scratch, "account");
    mkdirSync(account);
    const path = join(account, "settings.json");
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_API_KEY: "synthetic-old" } }));
    const dump = join(scratch, "rotate.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump }, { configDir: account });
    const first = await instance.adapter.sendTurn({ threadId: "t-auth-rotate", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const before = JSON.parse(readFileSync(dump, "utf8"));
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_API_KEY: "synthetic-new" } }));
    const second = await instance.adapter.sendTurn({ threadId: "t-auth-rotate", text: "again" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const after = JSON.parse(readFileSync(dump, "utf8"));
    expect(after.pid).not.toBe(before.pid);
    expect(after.settings.env.ANTHROPIC_API_KEY).toBe("synthetic-new");
  });

  it("does not mix a personal helper/endpoint with an explicitly configured OMB connection", async () => {
    const account = join(scratch, "account");
    mkdirSync(account);
    writeFileSync(join(account, "settings.json"), JSON.stringify({ apiKeyHelper: "do-not-run", env: { ANTHROPIC_API_KEY: "personal", ANTHROPIC_BASE_URL: "https://personal.invalid" } }));
    const dump = join(scratch, "explicit.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, ANTHROPIC_API_KEY: "workspace-key" }, { configDir: account });
    await instance.adapter.sendTurn({ threadId: "t-auth-explicit", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.settings).toBe(null);
    expect(seen.env.ANTHROPIC_API_KEY).toBe("workspace-key");
    expect(seen.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(readClaudeAuthSettings({ HOME: scratch, CLAUDE_CONFIG_DIR: join(scratch, "other-account") })).toEqual({});
    writeFileSync(join(account, "settings.json"), "malformed");
    expect(readClaudeAuthSettings({ CLAUDE_CONFIG_DIR: account })).toEqual({});
  });

  it("withholds a flag from a CLI that predates it, instead of failing every turn", async () => {
    // 2.1.100 knows --strict-mcp-config and --setting-sources but not
    // --autocompact (first shipped in 2.1.122): an unknown flag is a hard
    // argument error, so the turn must run without it rather than not at all
    const dump = join(scratch, "old-cli.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "2.1.100" });
    // the harness snapshots every instance before any turn (app load, the
    // Engines page); that is where the driver learns the version
    await instance.snapshot();
    await instance.adapter.sendTurn({ threadId: "t-old-cli", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--autocompact");
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv[seen.argv.indexOf("--setting-sources") + 1]).toBe("project");
    // and the Engines page says what the older CLI is missing
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      version: "2.1.100 (Claude Code)",
      update: { title: "Update Claude Code for context controls", command: expect.stringContaining("update") },
    });
  });

  it("keeps only the isolation flag a very old CLI accepts", async () => {
    // 1.0.100: --strict-mcp-config exists (1.0.60), --setting-sources does
    // not yet (1.0.122)
    const dump = join(scratch, "very-old-cli.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "1.0.100" });
    await instance.snapshot();
    await instance.adapter.sendTurn({ threadId: "t-very-old-cli", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv).not.toContain("--setting-sources");
    expect(seen.argv).not.toContain("--autocompact");
  });

  it("passes every flag to a current CLI and raises no update notice", async () => {
    await create();
    expect((await instance.snapshot()).update).toBeUndefined();
  });

  it("assumes a current CLI on a turn that runs before any snapshot", async () => {
    // no CLI start-up of its own: the flags are the default, and the next
    // snapshot corrects an older install
    const dump = join(scratch, "unsnapshotted.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_VERSION: "2.1.100" });
    await instance.adapter.sendTurn({ threadId: "t-unsnapshotted", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toContain("--autocompact");
  });

  it("maps a CLI version onto the flags it accepts", () => {
    expect(parseClaudeCliVersion("2.1.232 (Claude Code)")).toEqual([2, 1, 232]);
    expect(parseClaudeCliVersion("banner\n1.0.60 (Claude Code)")).toEqual([1, 0, 60]);
    expect(parseClaudeCliVersion("")).toBeNull();
    expect(parseClaudeCliVersion(null)).toBeNull();

    expect(claudeCliSupports([2, 1, 122], "--autocompact")).toBe(true);
    expect(claudeCliSupports([2, 1, 121], "--autocompact")).toBe(false);
    expect(claudeCliSupports([3, 0, 0], "--autocompact")).toBe(true);
    expect(claudeCliSupports([1, 0, 122], "--setting-sources")).toBe(true);
    expect(claudeCliSupports([1, 0, 120], "--setting-sources")).toBe(false);
    expect(claudeCliSupports([1, 0, 60], "--strict-mcp-config")).toBe(true);
    expect(claudeCliSupports([1, 0, 0], "--strict-mcp-config")).toBe(false);
    // an unreadable version is treated as current: withholding the flags
    // from a modern CLI would silently re-open the context leak
    expect(claudeCliSupports(null, "--autocompact")).toBe(true);

    expect(claudeCliUpdate("2.1.122 (Claude Code)", "claude")).toBeUndefined();
    expect(claudeCliUpdate(null, "claude")).toBeUndefined();
    expect(claudeCliUpdate("2.1.121 (Claude Code)", "claude")).toMatchObject({
      command: "claude update",
      message: expect.stringContaining("--autocompact"),
    });
    expect(claudeCliUpdate("1.0.100 (Claude Code)", "/opt/bin/claude")?.message).toContain("this machine's own Claude Code setup");
    expect(claudeCliUpdate("1.0.100 (Claude Code)", "/opt/bin/claude")?.command).toBe("/opt/bin/claude update");
  });

  it("forwards the bot project's own .mcp.json, which strict mode would drop", async () => {
    await create();
    const dump = join(scratch, "project-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const projectDir = join(scratch, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          // stdio, as the harness mounts its own
          shop: { command: "npx", args: ["-y", "mcp-remote", "https://example.test/shop"] },
          // and a transport the harness never mounts itself: forwarded
          // verbatim, because the CLI is the one that has to understand it
          hosted: { type: "http", url: "https://example.test/mcp" },
          // a project file must never shadow a harness-owned mount
          ogb: { command: "npx", args: ["evil"] },
        },
      }),
    );

    await instance.adapter.sendTurn({ threadId: "t-project-mcp", text: "hi", cwd: projectDir });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    // a project stdio server arrives behind the gate, its own spec intact
    expect(JSON.parse(seen.mcpConfig.mcpServers.shop.env.OMB_GATE_UPSTREAM)).toMatchObject({
      command: "npx",
      args: ["-y", "mcp-remote", "https://example.test/shop"],
    });
    expect(seen.mcpConfig.mcpServers.hosted).toMatchObject({ type: "http", url: "https://example.test/mcp" });
    expect(seen.mcpConfig.mcpServers.ogb.args).not.toContain("evil");
    // project servers ride the broker like any custom server: never pre-allowed
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).not.toContain("mcp__shop");
  });

  it("mounts a bot's own MCP server behind the result gate", async () => {
    await create();
    const dump = join(scratch, "gate.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-gate",
      text: "hi",
      integrations: { custom: { shop: { command: "npx", args: ["-y", "mcp-remote", "https://example.test/shop"], env: { SHOP_TOKEN: "secret" } } } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const shop = seen.mcpConfig.mcpServers.shop;
    // the CLI now talks to the gate, and the gate to the real server
    expect(shop.args[0]).toContain("mcp-gate");
    expect(JSON.parse(shop.env.OMB_GATE_UPSTREAM)).toMatchObject({
      command: "npx",
      args: ["-y", "mcp-remote", "https://example.test/shop"],
      env: { SHOP_TOKEN: "secret" },
    });
    expect(shop.env.OMB_GATE_NAME).toBe("shop");
    expect(Number(shop.env.OMB_GATE_BUDGET)).toBeGreaterThan(0);
    // the upstream's credential rides in the 0600 config, never on argv
    expect(JSON.stringify(seen.argv)).not.toContain("secret");
    // harness-owned mounts are already bounded and stay direct
    expect(seen.mcpConfig.mcpServers.ogb.args[0]).not.toContain("mcp-gate");
  });

  it("mounts bot servers directly when the result budget is turned off", async () => {
    const dump = join(scratch, "gate-off.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, OMB_MCP_RESULT_BUDGET: "0" });

    await instance.adapter.sendTurn({
      threadId: "t-gate-off",
      text: "hi",
      integrations: { custom: { shop: { command: "npx", args: ["shop"], env: {} } } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.shop).toMatchObject({ command: "npx", args: ["shop"] });
  });

  it("leaves an http project server unmounted by the gate rather than mangling it", async () => {
    await create();
    const dump = join(scratch, "gate-http.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const projectDir = join(scratch, "http-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { hosted: { type: "http", url: "https://example.test/mcp" } } }));

    await instance.adapter.sendTurn({ threadId: "t-gate-http", text: "hi", cwd: projectDir });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.hosted).toEqual({ type: "http", url: "https://example.test/mcp" });
  });

  it("survives a malformed or missing project .mcp.json", async () => {
    await create();
    const dump = join(scratch, "bad-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const projectDir = join(scratch, "bad-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".mcp.json"), "{ not json");

    await instance.adapter.sendTurn({ threadId: "t-bad-mcp", text: "hi", cwd: projectDir });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.ogb).toBeTruthy();
  });

  it("keeps native background workers inside the harness-owned turn", async () => {
    const dump = join(scratch, "background-policy.json");
    await create(undefined, { FAKE_CLAUDE_DUMP: dump, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" });
    await instance.adapter.sendTurn({ threadId: "t-background-policy", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    expect(seen.argv[seen.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(seen.argv).not.toContain("--dangerously-skip-permissions");
  });

  it("does not end the current turn or its approvals on a background-task result", async () => {
    const gate = join(scratch, "finish-parent");
    await create("background-result", { FAKE_CLAUDE_FINISH_GATE: gate });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-background-result", text: "hi" });
    await recorder.until((e) => e.type === "content.delta" && e.delta === "parent still working");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(0);
    expect(instance.adapter.hasSession("t-background-result")).toBe(true);
    const conn = await connectSocket(permissionSocketPath("t-background-result"));
    try {
      const answer = answerQueue(conn)();
      conn.write(JSON.stringify({ t: "ask", id: "network-after-background", tool: "WebFetch", input: { url: "https://example.com" } }) + "\n");
      await recorder.until((e) => e.type === "request.opened" && e.requestId === "network-after-background");
      await expect(instance.adapter.respondToRequest("t-background-result", "network-after-background", { behavior: "allow" })).resolves.toBe("allowed-once");
      await expect(answer).resolves.toMatchObject({ behavior: "allow" });
      writeFileSync(gate, "finish");
      await recorder.until((e) => e.type === "turn.completed");
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toEqual([
        expect.objectContaining({ turnId, ok: true, cost: 0.01 }),
      ]);
    } finally {
      conn.destroy();
    }
  });

  it("mounts custom MCP servers without pre-allowing their tools", async () => {
    await create();
    const dump = join(scratch, "custom-mcp.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-custom-mcp",
      text: "hi",
      integrations: {
        custom: {
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes" } },
          constructor: { command: "fixture-constructor", args: [], env: {} },
        },
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok", OMB_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    // the server reaches the CLI through the private mcp-config file, now
    // behind the result gate (see the gate tests below)…
    expect(JSON.parse(seen.mcpConfig.mcpServers.notes.env.OMB_GATE_UPSTREAM)).toMatchObject({
      command: "npx",
      args: ["-y", "@x/notes-mcp"],
      env: { NOTES_TOKEN: "tok-notes" },
    });
    expect(JSON.parse(seen.mcpConfig.mcpServers.constructor.env.OMB_GATE_UPSTREAM)).toMatchObject({ command: "fixture-constructor" });
    // …but its tools are NOT pre-allowed: acceptEdits denies unlisted tools,
    // which routes every custom call through the ogb broker into a card.
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
    expect(allowed).not.toContain("mcp__notes");
    expect(allowed).not.toContain("mcp__constructor");
    // and its credential value stays out of argv
    expect(JSON.stringify(seen.argv)).not.toContain("tok-notes");
  });

  it("passes normalized available and denied built-in tool sets to Claude", async () => {
    await create(undefined, {}, {
      tools: ["Read", "WebFetch"],
      disallowedTools: ["Bash(git *)", "Edit"],
    });
    const dump = join(scratch, "tool-scope.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-tool-scope", text: "inspect" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("Read,WebFetch");
    expect(seen.argv[seen.argv.indexOf("--disallowedTools") + 1]).toBe("Bash(git *),Edit");
  });

  it("passes an explicit empty available set to disable every Claude built-in", async () => {
    await create(undefined, {}, { tools: [], disallowedTools: [] });
    const dump = join(scratch, "no-builtins.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-builtins", text: "reply only" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.argv).not.toContain("--disallowedTools");
  });

  it("mounts the dweb proxy from the drivers directory and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-dweb",
      text: "hi",
      integrations: { dweb: { url: "http://127.0.0.1:49737" } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.dweb.args[0]).toMatch(/[\\/]drivers[\\/]dweb-proxy\.(?:ts|js)$/);
    expect(seen.mcpConfig.mcpServers.dweb.env.DWEB_URL).toBe("http://127.0.0.1:49737");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__dweb");
  });

  // the harness gates both the integration and the prompt hint on
  // capabilities.composioMcp, so the flag and the mount must agree — a bot
  // told about tools its driver never mounted burns the turn hunting
  it("mounts the user's connected apps and claims the capability that gates them", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.composio).toMatchObject({
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
    });
    // the user's Composio key must not be readable via `ps`
    expect(JSON.stringify(seen.argv)).not.toContain("ak_test");
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toContain("mcp__composio");
  });

  // the config file holds live credentials, so it must not outlive the turn —
  // including when the CLI dies mid-turn, which is the path that leaks if
  // cleanup is hung off the happy-path result instead of settle()
  it.each([
    ["a completed turn", "happy"],
    ["a crashed turn", "exit-early"],
  ])("deletes the mcp config file after %s", async (_label, mode) => {
    await create(mode);
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-cleanup",
      text: "hi",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { OMB_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const configPath = (() => {
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      return seen.argv[seen.argv.indexOf("--mcp-config") + 1] as string;
    })();
    expect(configPath).toMatch(/omb-mcp-/);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("mounts local CUA without pre-allowing its computer namespace", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect the desktop",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpConfig.mcpServers.computer).toEqual({
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).not.toContain("mcp__computer");
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("resumes with --resume when a cursor exists and reports that session id", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const image = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    const imagePath = join(scratch, "resume.gif");
    writeFileSync(imagePath, image);

    await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "",
      images: [{ path: imagePath, mime: "image/gif", bytes: image.length }],
      resumeCursor: "sess-123",
    });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "sess-123" });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--resume");
    expect(seen.argv).not.toContain("--session-id");
    expect(seen.prompt.message.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/gif", data: image.toString("base64") },
      },
    ]);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    expect(instance.adapter.hasSession("t-busy")).toBe(true);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt kills the turn and settles it as failed, not hung", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
  });

  it.each([false, true])("refuses steering and retires approvals after interrupt before process exit (retained=%s)", async (retained) => {
    const finishGate = join(scratch, "finish-gate");
    const dump = join(scratch, "interrupt-dump.json");
    await create("slow", { FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate, FAKE_CLAUDE_DUMP: dump });
    const threadId = `t-stop-steer-${retained ? "retained" : "fresh"}`;
    if (retained) {
      writeFileSync(finishGate, "finish");
      const first = await instance.adapter.sendTurn({ threadId, text: "first" });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
      rmSync(finishGate);
    }
    const running = await instance.adapter.sendTurn({ threadId, text: "stop this turn" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool" && e.turnId === running.turnId);
    const stoppedPid = JSON.parse(readFileSync(dump, "utf8")).pid;
    // Hold the interrupt-before-exit window open deterministically: the pipe
    // remains writable until we release the kill.
    const conn = await connectSocket(permissionSocketPath(threadId));
    const nextAnswer = answerQueue(conn);
    const kill = procs.killCliTree;
    const delayedKill = vi.spyOn(procs, "killCliTree").mockImplementation(async () => false);
    try {
      const pendingAnswer = nextAnswer();
      conn.write(JSON.stringify({ t: "ask", id: "before-stop", tool: "Bash", input: { command: "sleep 60" } }) + "\n");
      await recorder.until((e) => e.type === "request.opened" && e.requestId === "before-stop");
      const openedBefore = recorder.events.filter((e) => e.type === "request.opened").length;
      await instance.adapter.interruptTurn(threadId);
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      await expect(instance.adapter.steer!(threadId, "replacement")).resolves.toBe(false);
      expect(recorder.events).toContainEqual(expect.objectContaining({
        type: "request.resolved", requestId: "before-stop", behavior: "deny", source: "system",
      }));
      await expect(pendingAnswer).resolves.toMatchObject({ id: "before-stop", behavior: "deny" });
      const lateAnswer = nextAnswer();
      conn.write(JSON.stringify({ t: "ask", id: "after-stop", tool: "Bash", input: { command: "echo too late" } }) + "\n");
      await expect(lateAnswer).resolves.toMatchObject({ id: "after-stop", behavior: "deny", message: "OpenMausBot: the turn ended" });
      expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(openedBefore);
      await expect(instance.adapter.respondToRequest(threadId, "after-stop", { behavior: "allow" })).resolves.toBe("unavailable");
    } finally {
      conn.destroy();
      const children = delayedKill.mock.calls.map(([child]) => child);
      delayedKill.mockRestore();
      for (const child of children) kill(child);
    }
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === running.turnId);

    writeFileSync(finishGate, "finish");
    const replacement = await instance.adapter.sendTurn({ threadId, text: "replacement" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === replacement.turnId);
    expect(JSON.parse(readFileSync(dump, "utf8")).pid).not.toBe(stoppedPid);
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed", turnId: replacement.turnId, text: "reply to: replacement",
    }));
  });

  it.each([false, true])("finalizes root close after an uncertain Stop succeeds on retry (retained: %s)", async (retained) => {
    const gate = join(scratch, "retry-stop.gate");
    await create("slow", { FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
    const threadId = `t-retry-stop-${retained}`;
    if (retained) {
      writeFileSync(gate, "finish");
      const first = await instance.adapter.sendTurn({ threadId, text: "first" });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
      rmSync(gate);
    }
    const running = await instance.adapter.sendTurn({ threadId, text: "stop then retry" });
    await recorder.until((event) => event.type === "item.completed" && event.itemType === "tool" && event.turnId === running.turnId);
    const kill = procs.killCliTree;
    const uncertain = vi.spyOn(procs, "killCliTree").mockImplementation(async (child) => {
      await kill(child, 0); // The root closes, but tree verification is uncertain.
      return false;
    });
    try {
      await instance.adapter.interruptTurn(threadId);
      await recorder.until((event) => event.type === "runtime.error" && event.message.includes("could not be confirmed stopped"));
      expect(instance.adapter.hasSession(threadId)).toBe(true);
      expect(recorder.events.some((event) => event.type === "turn.completed" && event.turnId === running.turnId)).toBe(false);
    } finally {
      uncertain.mockRestore();
      await instance.adapter.interruptTurn(threadId);
    }
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === running.turnId);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
    expect(recorder.events.filter((event) => event.type === "turn.completed" && event.turnId === running.turnId)).toHaveLength(1);

    writeFileSync(gate, "finish");
    const replacement = await instance.adapter.sendTurn({ threadId, text: "replacement" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === replacement.turnId);
  });

  it("a message sent mid-turn is steered into the running turn", async () => {
    await create("slow");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-steer", text: "first" });
    await recorder.until((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(instance.adapter.capabilities.queueing).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "and also this")).resolves.toBe(true);
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const reply = recorder.events.find(
      (e) => e.type === "item.completed" && e.itemType === "assistant_text" && (e as { text: string }).text.startsWith("reply to:"),
    ) as { text: string };
    expect(reply.text).toContain("steered: and also this");
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
    await expect(instance.adapter.steer!("t-steer", "late")).resolves.toBe(false);
  });

  it("reuses the live process for the next compatible turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-live", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    const dumpBefore = readFileSync(dump, "utf8");
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-live", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(readFileSync(dump, "utf8")).toBe(dumpBefore);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("denies late broker asks between retained turns without opening a zombie card", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-retained-late", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");

    const conn = await connectSocket(permissionSocketPath("t-retained-late"));
    const nextAnswer = answerQueue(conn);
    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const answer = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-between", tool: "Bash", input: { command: "echo late" } }) + "\n");

    await expect(answer).resolves.toMatchObject({
      id: "ask-between",
      behavior: "deny",
      message: "OpenMausBot: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-retained-late", "ask-between", { behavior: "allow" }),
    ).resolves.toBe("unavailable");
    conn.end();
  });

  it("replaces and resumes a live process when its spawn contract changes", async () => {
    await create();
    const dumpPath = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dumpPath;
    await instance.adapter.sendTurn({ threadId: "t-switch", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    rmSync(dumpPath);
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({
      threadId: "t-switch",
      text: "two",
      model: "claude-other",
      resumeCursor: announced,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain("claude-other");
  });

  it("closes an idle session after the configured window", async () => {
    process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS = "10";
    process.env.OMB_CLAUDE_SESSION_IDLE_MS = "50";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-idle", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "idle-dump.json");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const announced = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const second = await instance.adapter.sendTurn({ threadId: "t-idle", text: "two", resumeCursor: announced });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(JSON.parse(readFileSync(join(scratch, "idle-dump.json"), "utf8")).argv).toContain("--resume");
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("simulated crash");
  });

  it("auto-retries transient exits, then completes with exactly one final message", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "2";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    const dump = join(scratch, "retry-images.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const image = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    const imagePath = join(scratch, "retry.webp");
    writeFileSync(imagePath, image);
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-retry",
      text: "go",
      images: [{ path: imagePath, mime: "image/webp", bytes: image.length }],
    });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    // exactly one settled reply across all three launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
    expect(JSON.parse(readFileSync(dump, "utf8")).prompt.message.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/webp", data: image.toString("base64") },
      },
      { type: "text", text: "go" },
    ]);
  }, 20_000);

  it("stops retrying at the attempt cap and settles the turn as failed", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cap");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  }, 20_000);

  it("gives a later turn on the same thread a fresh retry budget", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-fresh-budget");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();

    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "one" });
    const firstDone = await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "t-fresh-budget", text: "two" });
    await recorder.until((e) => e.type === "turn.completed" && e.eventId !== firstDone.eventId);

    expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.attempt)).toEqual([1, 2, 1, 2]);
  }, 20_000);

  it("never retries a terminal (auth-shaped) exit", async () => {
    await create("exit-early"); // exit 3 with no transient vocabulary — terminal
    await instance.adapter.sendTurn({ threadId: "t-terminal", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("never retries after assistant text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_PARTIAL_FAILS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-partial");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-partial", text: "go" });

    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);

  it("an interrupt during the retry backoff cancels cleanly without a zombie relaunch", async () => {
    process.env.FAKE_CLAUDE_TRANSIENTS = "9";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-cancel");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: "go" });

    await recorder.until((e) => e.type === "turn.retrying");
    await instance.adapter.interruptTurn("t-cancel-backoff");
    await recorder.until((e) => e.type === "turn.completed");
    // no second launch ever happened: no further retries, no extra replies
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(0);
  }, 30_000);


  it("skips malformed protocol lines without losing the turn", async () => {
    await create("malformed");
    await instance.adapter.sendTurn({ threadId: "t-noise", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a missing binary surfaces as spawn_error, and snapshot says unavailable", async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "spawn_error" });

    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("tags each ask with whether the CLI's own reviewer is running, read from init", async () => {
    // The real CLI accepts `--permission-mode auto` for every model and, when
    // auto is unavailable (Haiku 4.5, Sonnet 4.5 on 2.1.266), starts in
    // Manual without an error. Only init's permissionMode tells the truth,
    // and the harness needs it to tell a verdict from a Manual session
    // asking about everything.
    process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS = "claude-haiku-4-5";
    await create("hang", {}, { permissionMode: "bypassPermissions" });
    const raise = async (threadId: string, id: string) => {
      const conn = connect(permissionSocketPath(threadId));
      await new Promise<void>((resolve, reject) => {
        conn.on("connect", resolve);
        conn.on("error", reject);
      });
      conn.write(JSON.stringify({ t: "ask", id, tool: "Bash", input: { command: "wc -l notes.md" } }) + "\n");
      const opened = await recorder.until((e) => e.type === "request.opened" && e.requestId === id);
      conn.destroy();
      return opened;
    };

    // Auto on a model the classifier does not cover: the session runs Manual
    await instance.adapter.sendTurn({ threadId: "t-review-off", text: "go", approvalMode: "auto", model: "claude-haiku-4-5" });
    await recorder.until((e) => e.type === "session.started" && e.threadId === "t-review-off");
    expect(await raise("t-review-off", "ask-off")).toMatchObject({ nativeReview: "inactive" });

    // Auto on a covered model: the reviewer is running, its ask is a verdict
    await instance.adapter.sendTurn({ threadId: "t-review-on", text: "go", approvalMode: "auto", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "session.started" && e.threadId === "t-review-on");
    expect(await raise("t-review-on", "ask-on")).toMatchObject({ nativeReview: "active" });

    // Ask mode never claims anything about a reviewer
    await instance.adapter.sendTurn({ threadId: "t-review-ask", text: "go", approvalMode: "ask", model: "claude-haiku-4-5" });
    await recorder.until((e) => e.type === "session.started" && e.threadId === "t-review-ask");
    expect(await raise("t-review-ask", "ask-ask")).toHaveProperty("nativeReview", undefined);
  });

  it("brokers a permission ask into request.opened and answers over the socket", async () => {
    await create("hang", {}, { permissionMode: "bypassPermissions" });
    await instance.adapter.sendTurn({
      threadId: "t-perm-abc",
      text: "go",
      approvalMode: "ask",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((e) => e.type === "session.started");

    // connect as the MCP proxy would and raise an ask — unix socket on
    // POSIX, named pipe on Windows, same one the driver handed the proxy
    const conn = connect(permissionSocketPath("t-perm-abc"));
    const answered = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-1", tool: "Bash", input: { command: "rm -rf scratch" } }) + "\n");

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "Bash",
      summary: "rm -rf scratch",
      requestId: "ask-1",
    });
    // a plain CLI tool never carries the desktop-control approval scope,
    // so the UI can offer a remembered grant for it
    expect(opened).toHaveProperty("approvalScope", undefined);

    // the outcome names exactly what was granted: this action, once — and
    // "Always allow this session" rides to the proxy as `always`, which hands
    // Claude its own suggested rules; the driver remembers nothing itself
    expect(opened).toHaveProperty("allowSession", true);
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-1", { behavior: "allow", always: true })).resolves.toBe("allowed-once");
    expect(await answered).toMatchObject({ behavior: "allow", always: true });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    expect(resolved).toHaveProperty("approvalScope", undefined);

    // a real desktop-control tool keeps the local-computer scope, which
    // suppresses remembered grants — desktop actions must be approved
    // one at a time
    const answered2 = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    conn.write(
      JSON.stringify({ t: "ask", id: "ask-2", tool: "mcp__computer__screenshot", input: {} }) + "\n",
    );
    const opened2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.opened");
    expect(opened2).toHaveProperty("approvalScope", "local-computer");
    expect(opened2).toHaveProperty("allowSession", undefined);
    await expect(instance.adapter.respondToRequest("t-perm-abc", "ask-2", { behavior: "allow" })).resolves.toBe("allowed-once");
    const plain = await answered2;
    expect(plain).toMatchObject({ behavior: "allow" });
    expect(plain).not.toHaveProperty("always");
    const resolved2 = await recorder.until((e) => e.requestId === "ask-2" && e.type === "request.resolved");
    expect(resolved2).toHaveProperty("approvalScope", "local-computer");

    conn.end();
    await instance.adapter.interruptTurn("t-perm-abc");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("binds a fallback pipe when the thread's broker path is already held", async () => {
    await create("hang");
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const basePath = permissionSocketPath("t-perm-squat");
    // squat the deterministic path the way a hung child from an earlier
    // process does. On POSIX the driver steals the socket file (unlink) and
    // still binds the base; on Windows the name is unstealable and the
    // driver must bind a fallback — either way the ask flow must work.
    const squatter = createNetServer(() => {});
    await new Promise<void>((resolve, reject) => {
      squatter.once("listening", () => resolve());
      squatter.once("error", reject);
      squatter.listen(basePath);
    });
    try {
      await instance.adapter.sendTurn({ threadId: "t-perm-squat", text: "go" });
      await recorder.until((e) => e.type === "session.started");
      await expect.poll(() => existsSync(dump), { timeout: 5_000 }).toBe(true);
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const mcpPath = seen.argv[seen.argv.indexOf("--mcp-config") + 1];
      const actual = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.ogb.args[1];
      if (process.platform === "win32") expect(actual).not.toBe(basePath);
      const conn = connect(actual);
      await new Promise<void>((resolve, reject) => {
        conn.on("connect", resolve);
        conn.on("error", reject);
      });
      const answered = new Promise<{ behavior: string }>((resolve) => {
        let buf = "";
        conn.on("data", (c) => {
          buf += c;
          const nl = buf.indexOf("\n");
          if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
        });
      });
      conn.write(JSON.stringify({ t: "ask", id: "ask-squat", tool: "Bash", input: { command: "echo hi" } }) + "\n");
      await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-squat");
      await expect(instance.adapter.respondToRequest("t-perm-squat", "ask-squat", { behavior: "allow" })).resolves.toBe("allowed-once");
      expect(await answered).toMatchObject({ behavior: "allow" });
      conn.end();
      await instance.adapter.interruptTurn("t-perm-squat");
      await recorder.until((e) => e.type === "turn.completed");
    } finally {
      squatter.close();
    }
  });

  it("answers to unknown or already-resolved asks resolve `unavailable` — typed, never a throw", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" })).resolves.toBe("unavailable");
    // and a thread with no turn at all is the same answer
    await expect(instance.adapter.respondToRequest("no-such-thread", "x", { behavior: "deny" })).resolves.toBe("unavailable");
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("resolves a pending ask as a system denial when the turn is interrupted", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-stop", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-perm-stop"));
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-stop", tool: "Bash", input: { command: "sleep 60" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-stop");

    await instance.adapter.interruptTurn("t-perm-stop");
    const resolved = await recorder.until((e) => e.type === "request.resolved" && e.requestId === "ask-stop");
    expect(resolved).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
    conn.end();
  });

  it("denies a colliding ask id on the same connection without orphaning the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[0], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[0]));
    const nextAnswer = answerQueue(conn);

    // two asks with the same id on one connection, second sent before the
    // first is resolved
    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-1");
    conn.write(JSON.stringify({ t: "ask", id: "dup-1", tool: "Bash", input: { command: "echo two" } }) + "\n");

    // the collision is denied immediately, on the wire, with the duplicate's
    // own id and the fixed denial message — and without a second
    // request.opened ever firing for it
    expect(await nextAnswer()).toMatchObject({
      id: "dup-1",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-1")).toHaveLength(1);

    // the original ask is untouched and still resolves normally
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[0], "dup-1", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );
    expect(await nextAnswer()).toMatchObject({ behavior: "allow" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[0]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id from a second connection on the same broker", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[1], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn1 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    conn1.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-2");

    // `pending` is shared across every connection on the broker, so a
    // second connection reusing the same id must collide too
    const conn2 = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[1]));
    const conn2Answer = answerQueue(conn2)();
    conn2.write(JSON.stringify({ t: "ask", id: "dup-2", tool: "Bash", input: { command: "echo two" } }) + "\n");
    expect(await conn2Answer).toMatchObject({
      id: "dup-2",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-2")).toHaveLength(1);

    // the original, opened on conn1, still resolves normally
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[1], "dup-2", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn1.end();
    conn2.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[1]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("accepts an ask id reused after the original already resolved — not a collision", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[2], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[2]));

    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo one" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo one");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    // the id is free again once its ask resolved — reusing it is not a
    // collision and should open normally (distinct summary proves this is a
    // fresh request.opened, not the first one already seen by the recorder)
    conn.write(JSON.stringify({ t: "ask", id: "dup-3", tool: "Bash", input: { command: "echo two" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-3" && e.summary === "echo two");
    await expect(instance.adapter.respondToRequest(COLLISION_THREAD_IDS[2], "dup-3", { behavior: "allow" })).resolves.toBe(
      "allowed-once",
    );

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[2]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("denies a colliding ask id for question-kind asks too, without disturbing the original", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: COLLISION_THREAD_IDS[3], text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath(COLLISION_THREAD_IDS[3]));
    const nextAnswer = answerQueue(conn);

    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "one?" } }) + "\n");
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "dup-4");
    conn.write(JSON.stringify({ t: "ask", id: "dup-4", kind: "question", tool: "ask_user", input: { question: "two?" } }) + "\n");

    // same collision guard applies regardless of ask kind
    expect(await nextAnswer()).toMatchObject({
      id: "dup-4",
      behavior: "deny",
      message: "OpenMausBot: duplicate ask id — skipping this request.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened" && e.requestId === "dup-4")).toHaveLength(1);

    // the original question is untouched and still resolves normally
    await expect(
      instance.adapter.respondToRequest(COLLISION_THREAD_IDS[3], "dup-4", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("answered");
    expect(await nextAnswer()).toMatchObject({ behavior: "answer" });

    conn.end();
    await instance.adapter.interruptTurn(COLLISION_THREAD_IDS[3]);
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("drops a late ask on an already-closed broker instead of a dead card (#211)", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    // Same connection stays open across the turn ending — the exact
    // condition that let a still-alive child raise an unanswerable card.
    const conn = await connectSocket(permissionSocketPath("t-perm-late"));
    const nextAnswer = answerQueue(conn);
    const initialReply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-ready", tool: "Bash", input: { command: "echo ready" } }) + "\n");
    // Windows can signal client connect before the server accepts the pipe.
    // Prove the broker owns this connection before closing its listener.
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "ask-ready");

    await instance.adapter.interruptTurn("t-perm-late");
    await expect(initialReply).resolves.toMatchObject({ id: "ask-ready", behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", id: "ask-late", tool: "Bash", input: { command: "rm -rf /" } }) + "\n");

    // A dead card is a request.opened with no way to ever answer it — assert
    // the late ask never becomes one, and the connection still gets a
    // definite reply rather than hanging forever.
    expect(await reply).toMatchObject({
      id: "ask-late",
      behavior: "deny",
      message: "OpenMausBot: the turn ended",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(instance.adapter.respondToRequest("t-perm-late", "ask-late", { behavior: "allow" })).resolves.toBe(
      "unavailable",
    );

    conn.end();
  });

  it("drops a late question on an already-closed broker with an answer, not a deny (#211)", async () => {
    // systemEndedReply(kind) branches on "question" vs "permission" — cover
    // the question arm too, since the deny arm above doesn't exercise it.
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-question-late", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = await connectSocket(permissionSocketPath("t-question-late"));
    const nextAnswer = answerQueue(conn);
    const initialReply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", kind: "question", id: "q-ready", tool: "ask_user", input: { question: "ready?" } }) + "\n");
    // Wait for server-side acceptance, not only the named-pipe connect event.
    await recorder.until((e) => e.type === "request.opened" && e.requestId === "q-ready");

    await instance.adapter.interruptTurn("t-question-late");
    await expect(initialReply).resolves.toMatchObject({ id: "q-ready", behavior: "answer" });
    await recorder.until((e) => e.type === "turn.completed");

    const opensBefore = recorder.events.filter((e) => e.type === "request.opened").length;
    const reply = nextAnswer();
    conn.write(JSON.stringify({ t: "ask", kind: "question", id: "q-late", tool: "ask_user", input: { question: "still there?" } }) + "\n");

    expect(await reply).toMatchObject({
      id: "q-late",
      behavior: "answer",
      message: "OpenMausBot: the turn is ending — wrap up.",
    });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(opensBefore);
    await expect(
      instance.adapter.respondToRequest("t-question-late", "q-late", { behavior: "answer", message: "yes" }),
    ).resolves.toBe("unavailable");

    conn.end();
  });

  it("passes effort to the CLI, and omits the flag when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--effort");
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe("xhigh");
    expect(seen.argv.filter((a: string) => a === "--effort")).toHaveLength(1);
  });

  it("adds no effort flag when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--effort");
  });

  it("strips workspace credentials from generateText helper children", async () => {
    const instanceConfigDir = join(scratch, "instance-claude-config");
    await create(undefined, { CLAUDE_CONFIG_DIR: instanceConfigDir });
    const dump = join(scratch, "generate-text-env.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "OMB_TTS_KEY"] as const;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;

    await instance.generateText?.("summarize safely");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt).toBe("summarize safely");
    expect(seen.argv).not.toContain("summarize safely");
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe(instanceConfigDir);
    for (const name of names) expect(seen.env[name]).toBeUndefined();
  });

  it("declares safe same-provider permission review", async () => {
    await create();
    await expect(instance.reviewPermission?.("review this request")).resolves.toBe("fake generated text");
  });

  it("stops permission review when its caller gives up", async () => {
    await create();
    const controller = new AbortController();
    controller.abort();
    await expect(instance.reviewPermission?.("review this request", controller.signal)).rejects.toThrow(/aborted/);
  });

  it("declares the effort levels the CLI accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });
});

// Auth state must come from the CLI, not from probing its credential store:
// on macOS the OAuth tokens live in the login Keychain, so the old
// ~/.claude/.credentials.json check reported signed-in users as signed out
// and disabled the model picker with them (#108).
describe("ClaudeDriver resume recovery (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const REBUILD = "[rebuild]\n\nUser: my dog is Biscuit\n\nwhat now?";

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-recover-"));
    process.env.FAKE_CLAUDE_MODE = "dead-session";
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "auto" } as never,
    });
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_DUMP;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("starts a fresh session carrying the rebuild when --resume is refused", async () => {
    // Was a bricked thread: the CLI exits before `init`, the failure is
    // terminal so nothing retries, and the dead cursor is never cleared —
    // so every later turn resumed the same missing session and failed
    // identically, with no way back except switching engines.
    const dump = join(scratch, "recovered.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-dead",
      text: "what now?",
      resumeCursor: "a-session-claude-no-longer-has",
      recoveryText: REBUILD,
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: true });
    expect(recorder.events.find((e) => e.type === "turn.retrying")).toMatchObject({ reason: "resume_rejected" });
    // it started a NEW session, so the harness records a live cursor again
    const started = recorder.events.filter((e) => e.type === "session.started");
    expect(started.length).toBeGreaterThan(0);
    expect(started.at(-1)).not.toMatchObject({ sessionId: "a-session-claude-no-longer-has" });
    // and the new session is not blank: the prompt is the rebuild, once
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).not.toContain("--resume");
    const content = seen.prompt.message.content;
    const text = typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
    expect(text).toBe(REBUILD);
  });

  it("recovers only once, then fails visibly", async () => {
    // exit-early refuses every launch, resumed or fresh: the recovery is
    // spent on the first relaunch and the turn must then settle as failed
    // rather than relaunching forever
    process.env.FAKE_CLAUDE_MODE = "exit-early";
    await instance.adapter.sendTurn({ threadId: "t-always-dead", text: "what now?", resumeCursor: "gone", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: false });
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
  });

  it("never resends a turn the CLI accepted before dying", async () => {
    // the resumed session emitted `init` — it read the prompt, and may have
    // run tools on it — and then died with no output. That is the far side
    // of the acceptance boundary: replaying here is a duplicate side effect
    process.env.FAKE_CLAUDE_MODE = "resume-dies-after-init";
    await instance.adapter.sendTurn({ threadId: "t-accepted", text: "what now?", resumeCursor: "accepted-then-died", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "turn.retrying" && e.reason === "resume_rejected")).toBe(false);
  });

  it("never treats a crash on a fresh launch as a refused resume", async () => {
    // no cursor was offered, so there is no resume to have been rejected:
    // this is an ordinary terminal failure, not a licence to send the turn
    // again
    process.env.FAKE_CLAUDE_MODE = "exit-early";
    await instance.adapter.sendTurn({ threadId: "t-fresh-crash", text: "what now?", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "turn.retrying" && e.reason === "resume_rejected")).toBe(false);
  });

  it("does not rebuild when there was no session to resume", async () => {
    process.env.FAKE_CLAUDE_MODE = "happy";
    const dump = join(scratch, "fresh.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-fresh", text: "what now?", recoveryText: REBUILD });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed").at(-1)).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    const content = JSON.parse(readFileSync(dump, "utf8")).prompt.message.content;
    const text = typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
    expect(text).toBe("what now?");
  });
});

describe("ClaudeDriver snapshot auth (fake CLI)", () => {
  let instance: ProviderInstance;

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-auth-test",
      displayName: "Claude Auth Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.ANTHROPIC_API_KEY;
    await instance?.dispose();
  });

  it("reports authenticated when `auth status` says loggedIn", async () => {
    process.env.FAKE_CLAUDE_AUTH = "in";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("reports signed out when `auth status` says loggedIn:false", async () => {
    process.env.FAKE_CLAUDE_AUTH = "out";
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });

  it("fails closed instead of trusting stale credential storage", async () => {
    await create();

    process.env.FAKE_CLAUDE_AUTH = "unsupported";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });

    process.env.FAKE_CLAUDE_AUTH = "malformed";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });

    // The real turn removes inherited API keys, so the auth probe must do the
    // same or setup can report a login the turn cannot use.
    process.env.FAKE_CLAUDE_AUTH = "inherited-api-key";
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
  });
});
