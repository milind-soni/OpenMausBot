// Harness recall, end to end and across engines (Phase 1 part 2,
// docs/superpowers/specs/2026-09-15-phase-1-recall-design.md): a fact told
// in one thread and a fact kept in MEMORY.md reach a NEW task's turn as a
// numbered block in the turn text; the chip says so; the usage row books
// it; a reply's Sources line moves to the chip; the off switch and the
// short-message guard hold. Same POSIX gating as branching.test.ts.
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

interface Msg { id: string; role: string; kind: string; text?: string; tool?: { name: string; output?: string } }

const ENGINES = [
  { id: "claude", driver: "claudeAgent", cli: "fake-claude-cli.ts", env: { FAKE_CLAUDE_DUMP_EACH_TURN: "1" } },
  { id: "codex", driver: "codex", cli: "fake-codex-app-server.ts", env: { FAKE_CODEX_MODE: "resume" } },
  { id: "acp", driver: "grokAgent", cli: "fake-acp-cli.ts", env: { FAKE_ACP_MODE: "echo-gated" } },
  { id: "pi", driver: "piAgent", cli: "fake-pi-cli.ts", env: {} },
] as const;

function harness(label: string, serverEnv: Record<string, string>, config: Record<string, unknown> = {}, engineEnv: Record<string, string> = {}) {
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
  const memoryFile = (botId: string, text: string) => {
    const dir = join(home, ".openmausbot", "workspaces", botId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), text);
  };
  beforeAll(async () => {
    for (const e of ENGINES) chmodSync(fake(e.cli), 0o755);
    home = mkdtempSync(join(tmpdir(), `omb-recall-${label}-`));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const instances: Record<string, unknown> = {};
    for (const e of ENGINES) instances[e.id] = { driver: e.driver, environment: { ...e.env, ...engineEnv, FAKE_CLAUDE_DUMP: join(home, `${e.id}.dump.json`) }, config: { cli: fake(e.cli), fullAuto: true } };
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
  afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(child ? home : home); });
  return { api, getBot, turn, ledger, memoryFile, home: () => home, stderr: () => stderr };
}

const chips = (messages: Msg[]) => messages.filter((m) => m.kind === "activity" && m.tool?.name.startsWith("recalled "));

posixOnly("harness recall on every fake engine", () => {
  const h = harness("on", {}, { recall: { captures: false } });

  it.each(ENGINES)("$id: a new task's turn carries what memory and an earlier thread said, and the chip and ledger say so", async (engine) => {
    const bot = (await h.api("POST", "/api/bots", { name: `Recall ${engine.id}` })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: engine.id, model: "fake-model" } })).status).toBe(200);
    h.memoryFile(bot.id, "- 2026-09-01 · the staging database is called moonbase\n");
    // nothing to recall yet: the memory line shares no term with this message
    const first = await h.turn(bot.id, "Remember this: the deploy password hint is blue-falcon-42");
    expect(chips(first.messages as Msg[])).toHaveLength(0);
    expect(h.ledger(bot.threadId).at(-1)?.recall).toBeUndefined();
    // a new task: fresh session, and the question touches both facts
    const opened = (await h.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Follow-up" })).body.task;
    expect((await h.getBot(bot.id)).threadId).toBe(opened.threadId);
    const second = await h.turn(bot.id, "What is the deploy password hint, and what is the staging database called?");
    const chip = chips(second.messages as Msg[]);
    expect(chip).toHaveLength(1);
    // the echo fake's reply in the first thread repeats the person's words,
    // so on ACP the earlier thread yields two matching messages, not one
    const conversations = engine.id === "acp" ? 2 : 1;
    expect(chip[0]!.tool!.name).toBe(`recalled 1 note · ${conversations} conversation${conversations === 1 ? "" : "s"}`);
    expect(chip[0]!.tool!.output).toContain("[1] MEMORY.md · file MEMORY.md");
    expect(chip[0]!.tool!.output).toContain(`[2] chat "`);
    expect(chip[0]!.tool!.output).toContain(`thread ${bot.threadId}`);
    // the chip precedes the reply, after the person's message
    const ids = (second.messages as Msg[]).map((m) => m.id);
    expect(ids.indexOf(chip[0]!.id)).toBeGreaterThan(ids.findIndex((id) => (second.messages as Msg[]).find((m) => m.id === id)?.role === "user"));
    // the ledger books it on this turn's row
    expect(h.ledger(opened.threadId).at(-1)?.recall).toMatchObject({ notes: 1, conversations, captures: 0 });
    expect(h.ledger(opened.threadId).at(-1)?.recall.bytes).toBeGreaterThan(200);
    // and the engine saw the block ahead of the message, numbered, fenced
    const prompt = engine.id === "claude"
      ? JSON.stringify(JSON.parse(readFileSync(join(h.home(), "claude.dump.json"), "utf8")).prompt)
      : engine.id === "acp"
        ? (second.messages as Msg[]).filter((m) => m.role === "bot" && m.kind === "text").at(-1)!.text!
        : null;
    if (prompt) {
      expect(prompt).toContain("[Your own notes and earlier conversations");
      expect(prompt).toContain("[1] MEMORY.md");
      expect(prompt).toContain("moonbase");
      expect(prompt).toContain("[2] chat");
      expect(prompt).toContain("blue-falcon-42");
      expect(prompt).toContain("[end of recalled material — the user's message follows]");
      expect(prompt.indexOf("[end of recalled material")).toBeLessThan(prompt.indexOf("What is the deploy password hint"));
    }
    // the stored user message is the person's text alone: the block never replays
    const userRows = (second.messages as Msg[]).filter((m) => m.role === "user" && m.kind === "text");
    expect(userRows.at(-1)!.text).toBe("What is the deploy password hint, and what is the staging database called?");
    // a nod is not a question: nothing is recalled for it
    const nod = await h.turn(bot.id, "ok");
    expect(chips(nod.messages as Msg[])).toHaveLength(1);
    expect(h.ledger(opened.threadId).at(-1)?.recall).toBeUndefined();
    // the metrics count it
    const metrics = (await h.api("GET", "/api/metrics?from=2026-01-01&to=2026-12-31")).body;
    expect(metrics.bots.find((b: any) => b.botId === bot.id)).toMatchObject({ recalls: 1 });
  }, 90_000);
});

posixOnly("the reply's Sources line finishes the chip (Claude fake, scripted replies)", () => {
  const h = harness("sources", {}, { recall: { captures: false } }, {
    FAKE_CLAUDE_REPLIES: JSON.stringify(["noted", "The hint is blue-falcon-42.\n\nSources: [1]"]),
    FAKE_CLAUDE_REPLY_STATE: join(tmpdir(), `omb-recall-replies-${process.pid}-${Date.now()}.json`),
  });

  it("moves the line off the stored reply, onto the chip and into the ledger", async () => {
    const bot = (await h.api("POST", "/api/bots", { name: "Cites" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" } })).status).toBe(200);
    await h.turn(bot.id, "Remember this: the deploy password hint is blue-falcon-42");
    const opened = (await h.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Later" })).body.task;
    const second = await h.turn(bot.id, "What is the deploy password hint?");
    const reply = (second.messages as Msg[]).filter((m) => m.role === "bot" && m.kind === "text").at(-1)!.text!;
    expect(reply).toBe("The hint is blue-falcon-42.");
    const chip = chips(second.messages as Msg[]);
    expect(chip[0]!.tool!.name).toBe("recalled 1 conversation · used [1]");
    expect(h.ledger(opened.threadId).at(-1)?.recall).toMatchObject({ conversations: 1, used: 1 });
    const metrics = (await h.api("GET", "/api/metrics?from=2026-01-01&to=2026-12-31")).body;
    expect(metrics.bots.find((b: any) => b.botId === bot.id)).toMatchObject({ recalls: 1, recallsUsed: 1 });
  }, 60_000);
});

posixOnly("harness recall stays out of the way when switched off", () => {
  const h = harness("off", {}, { recall: { auto: false } });

  it("recalls nothing", async () => {
    const bot = (await h.api("POST", "/api/bots", { name: "Off" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } })).status).toBe(200);
    h.memoryFile(bot.id, "- 2026-09-01 · the staging database is called moonbase\n");
    await h.turn(bot.id, "Remember this: the deploy password hint is blue-falcon-42");
    const opened = (await h.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Later" })).body.task;
    const second = await h.turn(bot.id, "What is the staging database called?");
    expect(chips(second.messages as Msg[])).toHaveLength(0);
    expect(h.ledger(opened.threadId).at(-1)?.recall).toBeUndefined();
    const reply = (second.messages as Msg[]).filter((m) => m.role === "bot" && m.kind === "text").at(-1)!.text!;
    expect(reply).not.toContain("[Your own notes and earlier conversations");
  }, 60_000);
});
