// Harness-owned compaction, end to end and across engines (Phase 1 part 1,
// docs/superpowers/specs/2026-09-15-phase-1-long-threads-design.md): each
// fake reports more input tokens than the (forced-small) window allows, so
// the second turn's size crosses the budget and the THIRD turn compacts
// first — one compaction record by the harness, a fresh session, and the
// replay carrying the summary. A thread under budget never compacts, and
// the off switch holds. Same POSIX gating as branching.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg { id: string; role: string; kind: string; text?: string; compaction?: { summary: string; firstKeptId: string; tokensBefore: number; by: string } }

// every fake reports 200k input tokens per turn against a 100k window (budget 60k)
const BIG = "200000";
const ENGINES = [
  { id: "claude", driver: "claudeAgent", cli: "fake-claude-cli.ts", env: { FAKE_CLAUDE_INPUT_TOKENS: BIG, FAKE_CLAUDE_DUMP_EACH_TURN: "1" } },
  // the fake honours thread/resume only in its "resume" mode; the default mode stalls any second turn on a thread
  { id: "codex", driver: "codex", cli: "fake-codex-app-server.ts", env: { FAKE_CODEX_INPUT_TOKENS: BIG, FAKE_CODEX_MODE: "resume" } },
  { id: "acp", driver: "grokAgent", cli: "fake-acp-cli.ts", env: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_INPUT_TOKENS: BIG } },
  { id: "pi", driver: "piAgent", cli: "fake-pi-cli.ts", env: { FAKE_PI_INPUT_TOKENS: BIG } },
] as const;

function harness(label: string, serverEnv: Record<string, string>, config: Record<string, unknown> = {}) {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home = "";
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots?messages=200")).body.bots.find((b: any) => b.id === id);
  const turn = async (botId: string, text: string) => {
    const before = new Set(((await getBot(botId)).messages as Msg[]).map((m) => m.id));
    expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const b = await getBot(botId);
      const fresh = (b.messages as Msg[]).filter((m) => !before.has(m.id));
      if (!b.busy && fresh.some((m) => m.role === "bot" && m.kind === "text" && m.text)) return b;
      if (Date.now() > deadline) throw new Error(`no reply to "${text}". stderr: ${stderr.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  beforeAll(async () => {
    for (const e of ENGINES) chmodSync(fake(e.cli), 0o755);
    home = mkdtempSync(join(tmpdir(), `omb-compaction-${label}-`));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const instances: Record<string, unknown> = {};
    for (const e of ENGINES) instances[e.id] = { driver: e.driver, environment: { ...e.env, FAKE_CLAUDE_DUMP: join(home, `${e.id}.dump.json`) }, config: { cli: fake(e.cli), fullAuto: true } };
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances, ...config }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), ...serverEnv };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);
  afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); });
  return { api, getBot, turn, home: () => home, stderr: () => stderr };
}

posixOnly("harness-owned compaction (every fake engine, window forced to 100k)", () => {
  const h = harness("on", { OMB_CONTEXT_WINDOW: "100000" });

  it.each(ENGINES)("$id: the turn after the budget is crossed compacts first, starts fresh, and carries the summary", async (engine) => {
    const bot = (await h.api("POST", "/api/bots", { name: `Long ${engine.id}` })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: engine.id, model: "fake-model" } })).status).toBe(200);
    await h.turn(bot.id, "first: remember the codeword PLUM");
    await h.turn(bot.id, "second: remember the codeword PEAR");
    // every settled turn reports 200k > the 60k budget, but the last two
    // exchanges are always kept verbatim: nothing is old enough to fold
    // until a third exchange exists, so turn 4 is the first to compact
    const third = await h.turn(bot.id, "third: remember the codeword FIG");
    expect((third.messages as Msg[]).filter((m) => m.kind === "compaction")).toHaveLength(0);
    const pidBefore = engine.id === "claude" ? JSON.parse(readFileSync(join(h.home(), "claude.dump.json"), "utf8")).pid : null;
    const after = await h.turn(bot.id, "fourth: which codewords do you know?");
    // the turn was a rebuild on a fresh session, and the ledger says so
    const ledger = readFileSync(join(h.home(), ".openmausbot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.threadId === bot.threadId);
    expect(ledger.at(-1)).toMatchObject({ compacted: true, promptShape: { replayed: true } });
    // the model summary is a harness call: booked once, under a fingerprint
    // (only the Claude fake offers a one-shot; the others draft none)
    const harnessRows = ledger.filter((r) => r.trigger?.kind === "harness");
    // Claude and, since Phase 3 part 5 gave it a one-shot through `codex
    // exec`, Codex draft the summary with a model call; the rest do not
    expect(harnessRows).toHaveLength(engine.id === "claude" || engine.id === "codex" ? 1 : 0);
    if (engine.id === "claude") expect(harnessRows[0]).toMatchObject({ trigger: { call: "compaction-summary" }, costUsd: 0.0012, input: 120 });
    if (engine.id === "claude") expect(harnessRows[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // Claude keeps one process per thread; a reset must not land on the one
    // that still holds the whole thread
    if (engine.id === "claude") {
      expect(JSON.parse(readFileSync(join(h.home(), "claude.dump.json"), "utf8")).pid).not.toBe(pidBefore);
    }
    const records = (after.messages as Msg[]).filter((m) => m.kind === "compaction");
    expect(records).toHaveLength(1);
    expect(records[0]!.compaction).toMatchObject({ by: "harness" });
    expect(records[0]!.compaction!.tokensBefore).toBeGreaterThanOrEqual(200_000);
    expect(records[0]!.compaction!.summary).toContain("User asked: first: remember the codeword PLUM");
    // the kept exchange is the second one
    expect((after.messages as Msg[]).find((m) => m.id === records[0]!.compaction!.firstKeptId)?.text).toBe("second: remember the codeword PEAR");
    // the fresh session got the replay: summary lead, then the kept exchange
    const task = after.tasks.find((t: any) => t.threadId === bot.threadId);
    expect(task.contextReset).toBeFalsy();
    if (engine.id === "acp") {
      const reply = (after.messages as Msg[]).filter((m) => m.role === "bot" && m.kind === "text").at(-1)!.text!;
      expect(reply).toContain("[Summary of the conversation before this point");
      expect(reply).toContain("PLUM");
      expect(reply).toContain("second: remember the codeword PEAR");
      expect(reply).toContain("third: remember the codeword FIG");
    }
    if (engine.id === "claude") {
      const dump = JSON.parse(readFileSync(join(h.home(), "claude.dump.json"), "utf8"));
      expect(JSON.stringify(dump.prompt)).toContain("[Summary of the conversation before this point");
      // Phase 1 part 4: the turn after a compaction restates where the
      // conversation began, in the turn text
      expect(JSON.stringify(dump.prompt)).toContain("[Where this conversation stands, kept by OpenMausBot:");
      expect(JSON.stringify(dump.prompt)).toContain("first: remember the codeword PLUM");
      expect(ledger.at(-1)).toMatchObject({ recited: true });
    }
    // measured: the usage row of turn 3 says it followed a compaction
    const metrics = (await h.api("GET", "/api/metrics?from=2026-01-01&to=2026-12-31")).body;
    expect(metrics.bots.find((b: any) => b.botId === bot.id)?.compactions).toBe(1);
    // the fake keeps reporting 200k after the fresh start (a real engine
    // would report less), so the thread sits over budget forever; the
    // regrowth floor keeps the harness from compacting on every turn
    const again = await h.turn(bot.id, "fifth: and now?");
    expect((again.messages as Msg[]).filter((m) => m.kind === "compaction")).toHaveLength(1);
    // and the recitation was for the compaction turn only, not every turn
    if (engine.id === "claude") {
      const dump = JSON.parse(readFileSync(join(h.home(), "claude.dump.json"), "utf8"));
      expect(JSON.stringify(dump.prompt)).not.toContain("[Where this conversation stands");
    }
  }, 90_000);
});

posixOnly("harness-owned compaction stays out of the way", () => {
  const h = harness("off", { OMB_CONTEXT_WINDOW: "100000" }, { context: { autoCompact: false } });

  it("never compacts when switched off, even far over budget", async () => {
    const bot = (await h.api("POST", "/api/bots", { name: "Off" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" } })).status).toBe(200);
    for (const text of ["one", "two", "three", "four"]) await h.turn(bot.id, text);
    expect(((await h.getBot(bot.id)).messages as Msg[]).filter((m) => m.kind === "compaction")).toHaveLength(0);
  }, 60_000);
});
