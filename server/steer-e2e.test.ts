// Mid-turn steering, end to end: boots the real harness with the fake claude
// CLI in `slow` mode (a gap after the tool result the way a real turn has
// between model calls), sends a message WHILE the turn runs, and asserts
// it is taken into the turn — 202 steered; in the transcript in order and
// marked; folded into the reply — while an engine without a live session
// falls back to the server-side queue.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonObject, JsonValue } from "./schema.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const RETRIEVAL_CONTEXT = [
  '<fleet-retrieval-evidence trust="untrusted" instruction-authority="false">',
  '{"hits":[{"path":"server/prompt-retrieval.ts","line":1}]}',
  "</fleet-retrieval-evidence>",
].join("\n");
const posixOnly = describe.skipIf(process.platform === "win32");
const retrievalRequestSchema = z.object({
  prompt: z.string(),
  session_id: z.string(),
  cwd: z.string().optional(),
  repository_remote: z.string().optional(),
  native_event: z.string(),
  native_event_id: z.string(),
  request_kind: z.string(),
  source_marker: z.string(),
}).passthrough();
type RetrievalRequest = z.infer<typeof retrievalRequestSchema>;

interface RetrievalHold {
  prompt: string;
  observed: () => void;
  released: Promise<void>;
}

posixOnly("mid-turn steering e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let steerGate: string;
  let projectCwd: string;
  let gitWrapperDir: string;
  let retrievalServer: Server;
  let retrievalEndpoint = "";
  let roomDump: string;
  let claudeDump: string;
  let rejectSteerClosed: string;
  let preDispatchDump: string;
  let retrievalHold: RetrievalHold | null = null;
  const retrievalRequests: RetrievalRequest[] = [];

  const api = async (method: string, path: string, body?: JsonValue): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const getGroup = async (id: string) => (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const holdRetrieval = (prompt: string) => {
    let observe: () => void = () => {};
    const observed = new Promise<void>((resolve) => { observe = resolve; });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    retrievalHold = { prompt, observed: observe, released };
    return {
      observed,
      release: () => {
        retrievalHold = null;
        release();
      },
    };
  };
  const exercisePreDispatchCancellation = async (
    mode: "bot-stop" | "bot-delete" | "local-stop" | "local-disable",
  ) => {
    retrievalRequests.length = 0;
    rmSync(preDispatchDump, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    const prompt = `held retrieval ${mode}`;
    const hold = holdRetrieval(prompt);
    try {
      const patch: JsonObject = {
        cwd: projectCwd,
        modelSelection: { instanceId: "claudePreDispatch", model: "claude-fake" },
      };
      if (mode === "local-stop" || mode === "local-disable") patch.computer = "local";
      expect((await api("PATCH", `/api/bots/${created.id}`, patch)).status).toBe(200);
      const accepted = await api("POST", `/api/bots/${created.id}/messages`, {
        text: prompt,
        sendId: `pre-dispatch-${mode}`,
      });
      expect(accepted.status).toBe(202);
      await hold.observed;

      const nativeMessage = accepted.body.message;
      expect(nativeMessage?.id).toBeTruthy();

      const stopped = mode === "bot-delete"
        ? await api("DELETE", `/api/bots/${created.id}`)
        : mode === "local-stop"
          ? await api("POST", "/api/local-computer/interrupt", {})
          : mode === "local-disable"
            ? await api("PATCH", `/api/bots/${created.id}`, { computer: "off" })
          : await api("POST", `/api/bots/${created.id}/interrupt`, {
              threadId: created.threadId,
            });
      expect(stopped.status).toBe(200);
      hold.release();

      if (mode !== "bot-delete") {
        await waitFor(async () => (await getBot(created.id)).busy === false, `${mode} cancellation to settle`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      expect(existsSync(preDispatchDump)).toBe(false);
      expect(retrievalRequests).toHaveLength(1);
      expect(retrievalRequests[0]).toMatchObject({
        prompt,
        session_id: created.threadId,
        native_event_id: nativeMessage.id,
        request_kind: "user_task",
      });
      const survivor = await getBot(created.id);
      if (mode === "bot-delete") {
        expect(survivor).toBeUndefined();
      } else {
        expect(survivor.messages.some(
          (message: any) => message.role === "bot"
            && message.kind === "text"
            && message.text.startsWith("reply to:"),
        )).toBe(false);
      }
    } finally {
      hold.release();
      await api("DELETE", `/api/bots/${created.id}`).catch(() => undefined);
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    projectCwd = join(home, "canary-project");
    execFileSync("git", ["init", "--quiet", projectCwd]);
    execFileSync("git", ["-C", projectCwd, "remote", "add", "origin", "https://github.com/lightcloud00/claudecode-workspace.git"]);
    const realGit = (process.env.PATH ?? "")
      .split(":")
      .map((directory) => join(directory, "git"))
      .find((candidate) => existsSync(candidate));
    if (!realGit) throw new Error("git is required for the retrieval fixture");
    gitWrapperDir = join(home, "test-bin");
    mkdirSync(gitWrapperDir);
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const gitWrapper = join(gitWrapperDir, "git");
    writeFileSync(gitWrapper, [
      "#!/bin/sh",
      `if [ "$1" = "-C" ] && [ "$2" = ${shellQuote(projectCwd)} ] && [ "$3" = "remote" ] && [ "$4" = "get-url" ] && [ "$5" = "origin" ]; then`,
      "  printf '%s\\n' 'https://github.com/lightcloud00/claudecode-workspace.git'",
      "  exit 0",
      "fi",
      `exec ${shellQuote(realGit)} "$@"`,
      "",
    ].join("\n"));
    chmodSync(gitWrapper, 0o755);
    retrievalServer = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", async () => {
        const body = retrievalRequestSchema.parse(JSON.parse(raw));
        retrievalRequests.push(body);
        // Mirror the real fail-closed project-identity boundary. A bot's
        // private scratch workspace is not a mapped repository, so it gets
        // no evidence and the unrelated queueing fixture stays byte-identical.
        if (!body.repository_remote) {
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
          return;
        }
        const hold = retrievalHold;
        if (hold?.prompt === body.prompt) {
          hold.observed();
          await hold.released;
        }
        const value = {
          schema: "aos.openmausbot-retrieval-adapter.v1",
          status: "context_ready",
          surface: "openmausbot",
          interface: "loopback",
          context: RETRIEVAL_CONTEXT,
          content_trust: "untrusted_retrieval_evidence",
          instruction_authority: false,
          tool_authority: false,
          write_authority: false,
          selector_authority: false,
          promotion_authority: false,
          prompt_or_content_recorded_by_adapter: false,
          native_event: body.native_event,
          native_event_id: body.native_event_id,
          session_key_hash: createHash("sha256").update(String(body.session_id)).digest("hex"),
          request_kind: body.request_kind,
          source_marker: body.source_marker,
        };
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      });
    });
    await new Promise<void>((resolve, reject) => {
      retrievalServer.once("error", reject);
      retrievalServer.listen(0, "127.0.0.1", () => resolve());
    });
    const retrievalAddress = retrievalServer.address();
    if (!retrievalAddress) throw new Error("retrieval fixture did not bind");
    // SAFETY: listen() used an IP host and numeric port, so Node returns AddressInfo here.
    const retrievalPort = (retrievalAddress as AddressInfo).port;
    retrievalEndpoint = `http://127.0.0.1:${retrievalPort}/v1/retrieve`;
    roomDump = join(home, "room-provider-prompt.json");
    claudeDump = join(home, "claude-provider-prompt.json");
    preDispatchDump = join(home, "pre-dispatch-provider-prompt.json");
    rejectSteerClosed = join(home, "reject-steer-closed.marker");
    steerGate = join(home, "delayed-steer.gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: {
            driver: "claudeAgent",
            environment: {
              FAKE_CLAUDE_MODE: "slow",
              FAKE_CLAUDE_SLOW_MS: "2000",
              FAKE_CLAUDE_WAIT_FOR_STEER: "1",
              FAKE_CLAUDE_DUMP: claudeDump,
            },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudeRace: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_STEER_GATE: steerGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudeReject: {
            driver: "claudeAgent",
            environment: {
              FAKE_CLAUDE_MODE: "reject-steer",
              FAKE_CLAUDE_STEER_CLOSED_MARKER: rejectSteerClosed,
            },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudeRoom: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: roomDump },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudePreDispatch: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: preDispatchDump },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // no live session: a message while busy uses the server-side queue
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
        },
      }),
    );
    const childEnv: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_PROMPT_RETRIEVAL_URL: retrievalEndpoint,
    };
    childEnv.PATH = process.env.PATH
      ? `${gitWrapperDir}:${process.env.PATH}`
      : gitWrapperDir;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 60_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    await new Promise<void>((resolve) => retrievalServer?.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  it(
    "a message during a Claude turn is steered into it: 202, in the transcript in order and marked, folded into the reply",
    async () => {
      retrievalRequests.length = 0;
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        cwd: projectCwd,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
      });
      const instances = (await api("GET", "/api/instances")).body.instances;
      expect(instances.find((i: any) => i.instanceId === "claude").capabilities.queueing).toBe(true);

      expect((await api("POST", `/api/bots/${created.id}/messages`, {
        text: "first",
        sendId: "retrieval-first-0001",
      })).status).toBe(202);
      await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
      await waitFor(async () => existsSync(claudeDump), "the Claude fixture environment dump");
      const fixtureEnvironment = z.object({
        env: z.object({
          FAKE_CLAUDE_SLOW_MS: z.literal("2000"),
          FAKE_CLAUDE_WAIT_FOR_STEER: z.literal("1"),
        }).passthrough(),
        prompt: z.object({
          message: z.object({ content: z.string() }).passthrough(),
        }).passthrough(),
      }).parse(JSON.parse(readFileSync(claudeDump, "utf8")));
      expect(fixtureEnvironment.env.FAKE_CLAUDE_WAIT_FOR_STEER).toBe("1");
      expect(fixtureEnvironment.prompt.message.content).toContain(RETRIEVAL_CONTEXT);
      // the fake pauses after its tool result; this lands inside that gap
      await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");
      const second = await api("POST", `/api/bots/${created.id}/messages`, {
        text: "and also this",
        sendId: "retrieval-steer-0001",
      });
      expect(second.status).toBe(202);
      expect(second.body.steered).toBe(true);

      await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
      const bot = await getBot(created.id);
      const textMessages = bot.messages.filter((m: any) => m.kind === "text");
      // Retrieval evidence reaches the provider-bound prompt but never the
      // two durable user transcript messages.
      expect(textMessages.filter((m: any) => m.role === "user").map((m: any) => m.text))
        .toEqual(["first", "and also this"]);
      expect(textMessages.filter((m: any) => m.role === "user").every(
        (m: any) => !m.text.includes("fleet-retrieval-evidence"),
      )).toBe(true);
      const finalReply = textMessages.find((m: any) => m.text.startsWith("reply to:"));
      expect(finalReply.text).toContain(RETRIEVAL_CONTEXT);
      expect(finalReply.text).toContain(`steered: and also this\n\n${RETRIEVAL_CONTEXT}`);
      const steered = bot.messages.find((m: any) => m.text === "and also this");
      expect(steered.steered).toBe(true);
      // one turn, not two: exactly one reply
      expect(bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"))).toHaveLength(1);
      expect(retrievalRequests).toHaveLength(2);
      expect(retrievalRequests[0]).toMatchObject({
        prompt: "first",
        session_id: created.threadId,
        cwd: projectCwd,
        repository_remote: "lightcloud00/claudecode-workspace",
        native_event: "pre_llm_call",
        request_kind: "user_task",
        source_marker: "openmausbot-native-v1",
      });
      expect(retrievalRequests[0]?.native_event_id).toBe(
        textMessages.find((m: any) => m.role === "user" && m.text === "first")?.id,
      );
      expect(retrievalRequests[1]).toMatchObject({
        prompt: "and also this",
        session_id: `${created.threadId}:steer:retrieval-steer-0001`,
        cwd: projectCwd,
        repository_remote: "lightcloud00/claudecode-workspace",
        native_event: "pre_llm_call",
        native_event_id: "retrieval-steer-0001",
        request_kind: "steer_attempt",
        source_marker: "openmausbot-native-v1",
      });
    },
    40_000,
  );

  it("rejects a delayed steer acknowledgement after the bot is deleted", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claudeRace", model: "claude-fake" },
    });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first race turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the race turn to start");
    await waitFor(
      async () => (await getBot(created.id))?.messages.some((message: any) => message.kind === "activity"),
      "the race turn tool chip",
    );

    // The fake has paused stdin after the first prompt. This exceeds a pipe's
    // writable buffer, so the steer promise cannot acknowledge until the gate
    // opens; meanwhile the first turn is free to settle normally.
    const delayed = api("POST", `/api/bots/${created.id}/messages`, {
      text: `delayed ownership check ${"x".repeat(900_000)}`,
      threadId: created.threadId,
    });
    const prematurelySettled = await Promise.race([
      delayed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(prematurelySettled).toBe(false);

    // Delete while the adapter write is still held. Waiting for the original
    // turn to settle first leaves a polling race where a buffered write can
    // acknowledge between the busy read and deletion.
    expect((await api("DELETE", `/api/bots/${created.id}`)).status).toBe(200);
    writeFileSync(steerGate, "open");

    const rejected = await delayed;
    expect(rejected.status).toBe(404);
    expect(rejected.body.error).toMatch(/no such bot/i);
  }, 40_000);

  it("Stop during held retrieval never starts the provider", async () => {
    await exercisePreDispatchCancellation("bot-stop");
  }, 30_000);

  it("deleting a bot during held retrieval never starts its provider", async () => {
    await exercisePreDispatchCancellation("bot-delete");
  }, 30_000);

  it("local-computer Stop during held retrieval never starts the provider", async () => {
    await exercisePreDispatchCancellation("local-stop");
  }, 30_000);

  it("disabling local computer during held retrieval never starts the provider", async () => {
    await exercisePreDispatchCancellation("local-disable");
  }, 30_000);

  it("routine cancellation owns pending retrieval before adapter interruption", () => {
    const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    expect(source).toMatch(
      /interruptTurn: async \(botId, threadId, runOn\) => \{\s+cancelDirectDispatch\(threadId\);\s+const bot/,
    );
  });

  it("a room turn uses its pinned project and keeps retrieval out of the transcript", async () => {
    retrievalRequests.length = 0;
    rmSync(roomDump, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    let room: any;
    try {
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "claudeRoom", model: "claude-fake" },
      });
      room = (await api("POST", "/api/groups", {
        name: "Retrieval room",
        memberIds: [created.id],
        setup: {
          bulletin: "",
          defaultResponder: { kind: "member", botId: created.id },
        },
      })).body.group;
      expect((await api("PATCH", `/api/groups/${room.id}`, { cwd: projectCwd })).status).toBe(200);
      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "room project lookup",
        sendId: "room-retrieval-0001",
      })).status).toBe(202);

      await waitFor(async () => existsSync(roomDump), "the room provider prompt");
      await waitFor(async () => (await getGroup(room.id)).busyBotId == null, "the room turn to settle");
      const settled = await getGroup(room.id);
      const userMessage = settled.messages.find((m: any) => m.role === "user" && m.text === "room project lookup");
      expect(userMessage).toBeTruthy();
      expect(settled.messages.filter((m: any) => m.kind === "text").every(
        (m: any) => !m.text.includes("fleet-retrieval-evidence"),
      )).toBe(true);

      expect(retrievalRequests).toHaveLength(1);
      expect(retrievalRequests[0]).toMatchObject({
        prompt: "room project lookup",
        session_id: room.threadId,
        cwd: projectCwd,
        repository_remote: "lightcloud00/claudecode-workspace",
        native_event: "pre_llm_call",
        native_event_id: userMessage.id,
        request_kind: "room_turn",
        source_marker: "openmausbot-native-v1",
      });
      const providerDump = JSON.parse(readFileSync(roomDump, "utf8"));
      expect(providerDump.prompt.message.content).toContain(RETRIEVAL_CONTEXT);
    } finally {
      if (room) {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      }
      await api("DELETE", `/api/bots/${created.id}`).catch(() => undefined);
    }
  }, 30_000);

  it("a failed steer leaves the normal thread key available for the queued turn", async () => {
    retrievalRequests.length = 0;
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      cwd: projectCwd,
      modelSelection: { instanceId: "claudeReject", model: "claude-fake" },
    });

    expect((await api("POST", `/api/bots/${created.id}/messages`, {
      text: "first rejected steer turn",
      sendId: "reject-first-0001",
    })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the reject fixture turn to start");
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"),
      "the reject fixture tool chip",
    );
    await waitFor(async () => existsSync(rejectSteerClosed), "the reject fixture stdin to close");

    const second = await api("POST", `/api/bots/${created.id}/messages`, {
      text: "queued after rejected steer",
      sendId: "reject-second-0001",
    });
    expect(second.status).toBe(202);
    expect(second.body.steered).not.toBe(true);
    expect(second.body.queued === true || second.body.message).toBeTruthy();

    await waitFor(async () => {
      const bot = await getBot(created.id);
      return bot.busy === false
        && bot.messages.filter((m: any) => m.kind === "text" && m.text.startsWith("reply to:")).length >= 2;
    }, "the queued fallback turn to settle", 40_000);
    const bot = await getBot(created.id);
    const fallbackMessage = bot.messages.find((m: any) => m.role === "user" && m.text === "queued after rejected steer");
    expect(fallbackMessage).toBeTruthy();
    expect(fallbackMessage.text).not.toContain("fleet-retrieval-evidence");

    expect(retrievalRequests).toHaveLength(3);
    expect(retrievalRequests[1]).toMatchObject({
      prompt: "queued after rejected steer",
      session_id: `${created.threadId}:steer:reject-second-0001`,
      native_event_id: "reject-second-0001",
      request_kind: "steer_attempt",
    });
    expect(retrievalRequests[2]).toMatchObject({
      prompt: "queued after rejected steer",
      session_id: created.threadId,
      cwd: projectCwd,
      repository_remote: "lightcloud00/claudecode-workspace",
      native_event_id: fallbackMessage.id,
      request_kind: "user_task",
    });
    const fallbackReply = bot.messages
      .filter((m: any) => m.kind === "text" && m.text.startsWith("reply to:"))
      .at(-1);
    expect(fallbackReply.text).toContain(RETRIEVAL_CONTEXT);
  }, 50_000);

  it("an engine without a live session preserves the message in the server-side queue", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the queued message to begin its turn",
    );
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queued turn to settle");
  }, 45_000);
});
