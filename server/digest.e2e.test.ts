// The work digest, end to end and across engines (Phase 0, item 0.1 with
// the standing "every engine" rule): boots the real harness server with one
// fake instance per engine family the repo has a fake for, runs one turn on
// each, and asserts that exactly one `digest` row lands after the reply,
// naming the tools that engine's protocol exposed. Then the "done when" of
// the phase: a turn on one engine that changes a project file yields a
// digest naming the file, and a different engine taking over the same
// thread is shown that digest in its replay.
//
// Same POSIX gating as branching.test.ts (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  id: string;
  role: string;
  kind: string;
  text?: string;
  turnId?: string;
  tool?: { name: string };
  digest?: { turnId: string; tools: Array<{ name: string; count: number }>; files?: { added: string[]; changed: string[] }; hookCoverage: string };
}

/** One row per engine family with a fake in server/testing. `tools` is what
 * that fake's default turn is known to emit through its protocol. */
const ENGINES = [
  { id: "acp", driver: "grokAgent", cli: "fake-acp-cli.ts", env: {}, tools: ["run"] },
  { id: "claude", driver: "claudeAgent", cli: "fake-claude-cli.ts", env: {}, tools: ["Bash"] },
  { id: "codex", driver: "codex", cli: "fake-codex-app-server.ts", env: {}, tools: ["*"] },
  { id: "pi", driver: "piAgent", cli: "fake-pi-cli.ts", env: { FAKE_PI_MODE: "tooluse" }, tools: ["bash"] },
] as const;

posixOnly("work digest e2e (every fake engine)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const gate = () => join(home, "acp.gate");
  const started = () => join(home, "acp.started");

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const settled = async (id: string) => {
    const b = await getBot(id);
    return !!b && !b.busy && b.messages.some((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
  };

  beforeAll(async () => {
    for (const e of ENGINES) chmodSync(fake(e.cli), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-digest-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const instances: Record<string, unknown> = {};
    for (const e of ENGINES) {
      instances[e.id] = { driver: e.driver, environment: e.env, config: { cli: fake(e.cli), fullAuto: true } };
    }
    // a gated ACP instance for the file-change test, and a second plain ACP
    // instance that echoes its prompt so the replay can be read back
    instances.gated = {
      driver: "grokAgent",
      environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_STARTED_FILE: started() },
      config: { cli: fake("fake-acp-cli.ts"), fullAuto: true },
    };
    instances.echo = {
      driver: "grokAgent",
      environment: { FAKE_ACP_MODE: "echo-gated" },
      config: { cli: fake("fake-acp-cli.ts"), fullAuto: true },
    };
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances }));

    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it.each(ENGINES)("$id: one settled turn yields exactly one digest naming its tools", async (engine) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: engine.id, model: "fake-model" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "do one thing" })).status).toBe(202);
    await waitFor(() => settled(created.id), `${engine.id} to settle`);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: Msg) => m.kind === "digest"), `${engine.id} digest`);

    const bot = await getBot(created.id);
    const digests: Msg[] = bot.messages.filter((m: Msg) => m.kind === "digest");
    const reply: Msg = bot.messages.find((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
    expect(digests).toHaveLength(1);
    const [d] = digests;
    expect(d!.role).toBe("bot");
    expect(d!.text).toMatch(/^\[digest\]/);
    expect(d!.digest?.turnId).toBeTruthy();
    if (reply.turnId) expect(d!.digest?.turnId).toBe(reply.turnId);
    const names = d!.digest!.tools.map((t) => t.name);
    if (engine.tools[0] === "*") expect(names.length).toBeGreaterThan(0);
    else for (const name of engine.tools) expect(names).toContain(name);
    // every activity row of the turn is attributed to it
    const activities: Msg[] = bot.messages.filter((m: Msg) => m.kind === "activity" && m.tool);
    for (const a of activities) expect(a.turnId).toBe(d!.digest?.turnId);
    expect(d!.digest!.tools.reduce((n, t) => n + t.count, 0)).toBe(activities.length);
  }, 45_000);

  it("books per-turn measurement for every engine: shape, coverage, duration, and serves the summary", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const metrics = await api("GET", `/api/metrics?from=${today}&to=${today}`);
    expect(metrics.status).toBe(200);
    expect(metrics.body.total.turns).toBeGreaterThanOrEqual(ENGINES.length);
    for (const engine of ENGINES) {
      const row = metrics.body.engines.find((e: { driverKind: string }) => e.driverKind === engine.driver);
      expect(row, `metrics for ${engine.driver}`).toBeTruthy();
      expect(row.turns).toBeGreaterThanOrEqual(1);
      expect(row.coverage.preview + row.coverage.full + row.coverage.none).toBe(row.turns);
      expect(row.promptBytes.turns).toBe(row.turns);
      expect(row.promptBytes.stable).toBeGreaterThan(0);
      expect(row.durationMs.turns).toBe(row.turns);
      // cache share is a number where the engine reports cached tokens, else honestly null
      expect(row.cacheHitShare.share === null || typeof row.cacheHitShare.share === "number").toBe(true);
    }
  });

  it("names the project files a turn changed, and a different engine taking over sees that in its replay", async () => {
    const project = mkdtempSync(join(tmpdir(), "omb-digest-project-"));
    writeFileSync(join(project, "README.md"), "hello");
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { cwd: project })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "gated", model: "fake-model" } })).status).toBe(200);

    // the turn is held open by the gate; "the engine" changes a file meanwhile
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "raise the retry limit" })).status).toBe(202);
    // busy flips at claim, BEFORE the pre-turn checkpoint; the fake's
    // started marker is written when the prompt reaches it, after that
    await waitFor(async () => existsSync(started()), "the gated turn to reach the engine");
    writeFileSync(join(project, "retry.ts"), "export const RETRY_LIMIT = 5;");
    writeFileSync(gate(), "go");
    await waitFor(() => settled(created.id), "the gated turn to settle");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: Msg) => m.kind === "digest"), "digest with files");
    const digest: Msg = (await getBot(created.id)).messages.find((m: Msg) => m.kind === "digest");
    expect(digest.digest?.files?.added).toEqual(["retry.ts"]);

    // switch engines: the echoing instance replays the thread, digest included
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "echo", model: "fake-model" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "what did you change?" })).status).toBe(202);
    await waitFor(async () => {
      const b = await getBot(created.id);
      return !b.busy && b.messages.filter((m: Msg) => m.role === "bot" && m.kind === "text" && m.text).length >= 2;
    }, "the echo engine to reply");
    const replies: Msg[] = (await getBot(created.id)).messages.filter((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
    const echoed = replies.at(-1)!.text!;
    expect(echoed).toContain("did in an earlier turn");
    expect(echoed).toContain("retry.ts");

    // item 0.7: a compaction record replaces the earlier history in rebuilds
    const bot = await getBot(created.id);
    const compacted = await api("POST", `/api/bots/${created.id}/tasks/${bot.threadId}/compact`, { summary: "The retry limit was raised to 5 in retry.ts." });
    expect(compacted.status).toBe(201);
    expect(compacted.body.compaction).toMatchObject({ by: "person", summary: "The retry limit was raised to 5 in retry.ts." });
    expect((await getBot(created.id)).messages.some((m: Msg) => m.kind === "compaction")).toBe(true);
    // switch engines again so the harness rebuilds the context (the gate is
    // already open, so the gated instance now echoes its prompt at once)
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "gated", model: "fake-model" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "and now?" })).status).toBe(202);
    await waitFor(async () => {
      const b = await getBot(created.id);
      return !b.busy && b.messages.filter((m: Msg) => m.role === "bot" && m.kind === "text" && m.text).length >= 3;
    }, "the echo engine to reply after compaction");
    const afterCompaction = (await getBot(created.id)).messages.filter((m: Msg) => m.role === "bot" && m.kind === "text" && m.text).at(-1)!.text!;
    expect(afterCompaction).toContain("[Summary of the conversation before this point: The retry limit was raised to 5 in retry.ts.]");
    expect(afterCompaction).not.toContain("raise the retry limit");
    expect(afterCompaction).toContain("and now?");
    await removeTempDir(project);
  }, 60_000);
});
