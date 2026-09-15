// Engine hooks, end to end (Phase 0, item 0.2): the real harness server with
// the fake Claude CLI honouring the hooks block of its private --settings
// file. A PostToolUse hook delivers the full tool result to the harness,
// which spills it to a private file, attaches it to the tool's activity row,
// and lets the turn's digest claim full evidence. A forged bearer is refused.
// With OMB_HOOKS=0 the driver registers nothing and the digest says so.
//
// Same POSIX gating as branching.test.ts (the fake CLI is a shebang script).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  id: string;
  role: string;
  kind: string;
  text?: string;
  tool?: { name: string; itemId?: string; outputPath?: string; fullResult?: boolean; output?: string };
  digest?: { hookCoverage: string; tools: Array<{ name: string; count: number }> };
}

const BIG = `line ${"x".repeat(80)}\n`.repeat(200); // ~17 KB: past the 6 KB preview

function harness(label: string, serverEnv: Record<string, string>, instanceEnv: Record<string, string> = {}) {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), `omb-hooks-${label}-`));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: {
            FAKE_CLAUDE_HOOKS: "1",
            FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
              { name: "Bash", input: { command: "cat big.log" }, ok: true, output: BIG },
              { name: "Read", input: { file_path: "a.ts" }, ok: true, output: "const a = 1;" },
            ]),
            // a case's own knobs win over the defaults above
            ...instanceEnv,
          },
          config: { cli: FAKE_CLAUDE },
        },
      },
    }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), ...serverEnv };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
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
  return {
    api,
    getBot,
    waitFor,
    home: () => home,
    runTurn: async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" } })).status).toBe(200);
      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "read the big log" })).status).toBe(202);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !!b && !b.busy && b.messages.some((m: Msg) => m.kind === "digest");
      }, "the turn to settle with a digest");
      return getBot(created.id);
    },
  };
}

posixOnly("engine hooks e2e (PreToolUse command filters, per-bot flag)", () => {
  // the fake's scripted call runs an unbounded test command; with the
  // bot's commandFilters flag on, the PreToolUse hook rewrites it before
  // it runs, and the harness counts the rewrite on the turn's usage row
  const h = harness("filters", {}, {
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "Bash", input: { command: "pnpm test" }, ok: true, output: "ok" }]),
  });

  it("rewrites a known noisy command through updatedInput when the bot's flag is on, and leaves it alone when off", async () => {
    const on = (await h.api("POST", "/api/bots")).body.bot;
    expect((await h.api("PATCH", `/api/bots/${on.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, commandFilters: true })).status).toBe(200);
    expect((await h.api("GET", "/api/bots")).body.bots.find((b: any) => b.id === on.id).commandFilters).toBe(true);
    expect((await h.api("POST", `/api/bots/${on.id}/messages`, { text: "run the tests" })).status).toBe(202);
    await h.waitFor(async () => {
      const b = await h.getBot(on.id);
      return !!b && !b.busy && b.messages.some((m: Msg) => m.kind === "digest");
    }, "the filtered turn to settle");
    const filteredRow = (await h.getBot(on.id)).messages.find((m: Msg) => m.kind === "activity" && m.tool?.name === "Bash");
    expect(JSON.stringify(filteredRow.tool)).toContain("pnpm test 2>&1 | tail -n 200");

    const off = (await h.api("POST", "/api/bots")).body.bot;
    expect((await h.api("PATCH", `/api/bots/${off.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" } })).status).toBe(200);
    expect((await h.api("POST", `/api/bots/${off.id}/messages`, { text: "run the tests" })).status).toBe(202);
    await h.waitFor(async () => {
      const b = await h.getBot(off.id);
      return !!b && !b.busy && b.messages.some((m: Msg) => m.kind === "digest");
    }, "the unfiltered turn to settle");
    const plainRow = (await h.getBot(off.id)).messages.find((m: Msg) => m.kind === "activity" && m.tool?.name === "Bash");
    expect(JSON.stringify(plainRow.tool)).not.toContain("tail -n 200");

    // the rewrite is measurable: /api/metrics counts it for the flagged bot only
    const metrics = (await h.api("GET", "/api/metrics")).body;
    expect(metrics.bots.find((b: any) => b.botId === on.id)?.filteredCommands).toBe(1);
    expect(metrics.bots.find((b: any) => b.botId === off.id)?.filteredCommands).toBe(0);
  }, 90_000);
});

posixOnly("engine hooks e2e (fake Claude honouring the settings hooks)", () => {
  const h = harness("on", {});

  it("delivers full tool results through PostToolUse: spilled to a private file, attached to the activity row, digest evidence full", async () => {
    const bot = await h.runTurn();
    const tools: Msg[] = bot.messages.filter((m: Msg) => m.kind === "activity" && m.tool);
    expect(tools.map((m) => m.tool!.name)).toEqual(["Bash", "Read"]);
    for (const row of tools) {
      expect(row.tool!.itemId).toBeTruthy();
      expect(row.tool!.fullResult).toBe(true);
      expect(row.tool!.outputPath).toContain(join(h.home(), ".openmausbot", "tool-results"));
      expect(existsSync(row.tool!.outputPath!)).toBe(true);
      expect(statSync(row.tool!.outputPath!).mode & 0o777).toBe(0o600);
    }
    const bash = tools[0]!.tool!;
    const spilled = readFileSync(bash.outputPath!, "utf8");
    expect(spilled.length).toBeGreaterThan(10_000);
    expect(spilled).toContain(BIG.slice(0, 200));
    // the row's own preview stays bounded; the file has the rest
    expect((bash.output ?? "").length).toBeLessThan(7_000);
    const digest: Msg = bot.messages.find((m: Msg) => m.kind === "digest");
    expect(digest.digest?.hookCoverage).toBe("full");
    expect(digest.text).not.toContain("from tool previews");
  }, 60_000);

  it("refuses a hook call whose bearer is not a live hooks capability", async () => {
    const forged = await h.api("POST", "/api/internal/hook", { event: "PostToolUse", payload: { tool_use_id: "x" } }, { authorization: "Bearer not-a-real-token" });
    expect(forged.status).toBe(401);
  });
});

posixOnly("engine hooks e2e: compaction", () => {
  const dumpPath = join(tmpdir(), `omb-hooks-dump-${process.pid}-${Date.now()}.json`);
  const h = harness("compact", {}, { FAKE_CLAUDE_DUMP: dumpPath, FAKE_CLAUDE_COMPACT: "1", FAKE_CLAUDE_TURN_STATE: join(tmpdir(), `omb-hooks-turns-${process.pid}-${Date.now()}`), FAKE_CLAUDE_PROMPTS: join(tmpdir(), `omb-hooks-prompts-${process.pid}-${Date.now()}.ndjson`) });

  it("records the compaction in the transcript and hands the latest digests back to the engine as plain-text context", async () => {
    const bot = await h.runTurn();
    // the fake ran PreCompact then SessionStart(compact) at the start of its
    // SECOND turn; run one more turn so the first turn's digest exists first
    expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "and again, after compaction" })).status).toBe(202);
    await h.waitFor(async () => {
      const b = await h.getBot(bot.id);
      return !b.busy && b.messages.filter((m: Msg) => m.kind === "digest").length >= 2;
    }, "the second turn to settle with its digest");
    const after = await h.getBot(bot.id);
    // finding F1: the second turn must have reused the live CLI process. The
    // fake dumps only the FIRST prompt each process receives, so a dump
    // holding the first message proves no respawn happened in between.
    const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as { prompt: { message?: { content?: string } } };
    expect(dump.prompt.message?.content).toBe("read the big log");
    const chips: Msg[] = after.messages.filter((m: Msg) => m.kind === "activity" && m.tool?.name.startsWith("context compact"));
    expect(chips.map((m) => m.tool!.name)).toEqual([
      "context compaction started (auto)",
      "context compacted — re-sent the last 1 digest",
    ]);
    // the fake echoes what SessionStart's stdout gave it, which must be the
    // first turn's digest line
    const replies: Msg[] = after.messages.filter((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
    expect(replies.at(-1)!.text).toContain("[What ");
    expect(replies.at(-1)!.text).toContain("did in an earlier turn");
    expect(replies.at(-1)!.text).toContain("Bash ×1");
  }, 90_000);
});

posixOnly("engine hooks e2e with OMB_HOOKS=0", () => {
  const h = harness("off", { OMB_HOOKS: "0" });

  it("registers nothing: rows keep only previews and the digest says so", async () => {
    const bot = await h.runTurn();
    const tools: Msg[] = bot.messages.filter((m: Msg) => m.kind === "activity" && m.tool);
    expect(tools.length).toBe(2);
    for (const row of tools) {
      expect(row.tool!.fullResult).toBeUndefined();
      expect(row.tool!.outputPath).toBeUndefined();
    }
    const digest: Msg = bot.messages.find((m: Msg) => m.kind === "digest");
    expect(digest.digest?.hookCoverage).toBe("preview");
  }, 60_000);
});
