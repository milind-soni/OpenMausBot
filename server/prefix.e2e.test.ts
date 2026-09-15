// Prefix fixes, end to end (Phase 1 part 3,
// docs/superpowers/specs/2026-09-15-phase-1-prefix-design.md): a message
// that trips a bundled skill's trigger gets the skill's body in the TURN
// TEXT and keeps the live Claude process (no respawn: the stable prompt
// half did not move); the working folder sits in the volatile half; and a
// folder's AGENTS.md reaches the engine as a stable section. Same POSIX
// gating as branching.test.ts.
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

interface Msg { id: string; role: string; kind: string; text?: string }

function harness(label: string) {
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
  const ledger = (threadId: string) => {
    try {
      return readFileSync(join(home, ".openmausbot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.threadId === threadId && r.trigger?.kind !== "harness");
    } catch { return []; }
  };
  const dump = (engine: string) => JSON.parse(readFileSync(join(home, `${engine}.dump.json`), "utf8"));
  beforeAll(async () => {
    for (const cli of ["fake-claude-cli.ts", "fake-codex-app-server.ts", "fake-acp-cli.ts"]) chmodSync(fake(cli), 0o755);
    home = mkdtempSync(join(tmpdir(), `omb-prefix-${label}-`));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const instances = {
      claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_DUMP: join(home, "claude.dump.json"), FAKE_CLAUDE_DUMP_EACH_TURN: "1" }, config: { cli: fake("fake-claude-cli.ts"), fullAuto: true } },
      acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_DUMP: join(home, "acp.dump"), FAKE_ACP_DUMP_PROMPT: "1" }, config: { cli: fake("fake-acp-cli.ts"), fullAuto: true } },
    };
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances, recall: { captures: false } }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_SKILLS_DIR: join(SERVER_DIR, "testing", "skills") };
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
  return { api, getBot, turn, ledger, dump, home: () => home, stderr: () => stderr };
}

posixOnly("prefix fixes (Phase 1 part 3)", () => {
  const h = harness("skills");

  it("puts a triggered skill's body in the turn text and keeps the live Claude process", async () => {
    const bot = (await h.api("POST", "/api/bots", { name: "Prefix" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" } })).status).toBe(200);
    await h.turn(bot.id, "hello there, nothing special");
    const first = h.dump("claude");
    expect(JSON.stringify(first.prompt)).not.toContain("openmaus-skill");
    expect(first.systemPrompt ?? "").not.toContain("openmaus-skill");
    // the skills index still names the skill; the body is not in the prompt
    await h.turn(bot.id, "now please zorblat for me");
    const second = h.dump("claude");
    expect(second.pid).toBe(first.pid);
    expect(JSON.stringify(second.prompt)).toContain('<openmaus-skill id=\\"zorblat\\"');
    expect(JSON.stringify(second.prompt)).toContain("quantum-elk");
    expect(JSON.stringify(second.prompt).indexOf("openmaus-skill")).toBeLessThan(JSON.stringify(second.prompt).indexOf("now please zorblat"));
    // the stable half did not move: the ledger records no changed section
    const rows = h.ledger(bot.threadId);
    expect(rows.at(-1)?.promptShape?.stableChanged ?? []).toEqual([]);
    // the stored message is the person's text alone
    const users = ((await h.getBot(bot.id)).messages as Msg[]).filter((m) => m.role === "user" && m.kind === "text");
    expect(users.at(-1)!.text).toBe("now please zorblat for me");
  }, 60_000);

  it("keeps the working folder out of the stable half, and hands a folder's AGENTS.md to the engine", async () => {
    const project = mkdtempSync(join(tmpdir(), "omb-prefix-project-"));
    writeFileSync(join(project, "AGENTS.md"), "# House rules\nEnd every reply with the word ZEBRA.\n");
    const bot = (await h.api("POST", "/api/bots", { name: "Project" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, cwd: project })).status).toBe(200);
    await h.turn(bot.id, "what are the house rules here?");
    const dump = h.dump("claude");
    const system = String(dump.systemPrompt ?? "");
    expect(system).toContain("Standing instructions from the project's AGENTS.md");
    expect(system).toContain("End every reply with the word ZEBRA.");
    expect(system).toContain("Current working folder for this conversation");
    // two threads of one bot: the stable half is the same bytes, the folder differs
    const opened = (await h.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second" })).body.task;
    await h.turn(bot.id, "and again in a new thread?");
    const rows = h.ledger(opened.threadId);
    expect(rows.at(-1)?.promptShape?.stableBytes).toBe(h.ledger(bot.threadId).at(-1)?.promptShape?.stableBytes);
    await removeTempDir(project);
  }, 60_000);

  it("echoes the skill body inside the turn text on an ACP engine too", async () => {
    const bot = (await h.api("POST", "/api/bots", { name: "Acp" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } })).status).toBe(200);
    const b = await h.turn(bot.id, "zorblat please");
    const reply = (b.messages as Msg[]).filter((m) => m.role === "bot" && m.kind === "text").at(-1)!.text!;
    expect(reply).toContain('<openmaus-skill id="zorblat"');
    expect(reply).toContain("quantum-elk");
  }, 60_000);
});
