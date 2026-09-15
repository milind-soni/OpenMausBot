// Typed turns, end to end and across engines (Phase 0, item 0.3 with the
// standing "every engine" rule). The first consumer is the goal room's
// coordinator decision: the harness appends the decision schema to the
// coordinator's turn, validates the reply's fenced JSON block in code, and
// only a validated object moves the run. Same harness path on every engine:
//  - fake Claude replies with the block split across two assistant items
//    (buffering + extraction), and the room never shows the block;
//  - the ACP echo engine proves the path is not engine-specific: it echoes
//    the prompt, so the block the person put in the goal text comes back
//    and is validated like any model's answer;
//  - fake Codex and fake pi answer prose only, so the run fails CLOSED with
//    the reason on the card, on those engines too.
// Same POSIX gating as branching.test.ts (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const claudeReplies = [
  // the decision block split across two assistant items
  ["Ship it.\n```json\n{\"status\":", "\"completed\",\"detail\":\"Typed decision honoured.\"}\n```"],
];

posixOnly("typed turns e2e (goal decision, every fake engine)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const room = async (roomId: string) => (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === roomId);
  const goalCard = async (roomId: string) => (await room(roomId))?.messages.find((m: any) => m.kind === "goal.run")?.goalRun;
  const runGoal = async (instanceId: string, text: string) => {
    const lead = (await api("POST", "/api/bots", { name: `Lead ${instanceId}` })).body.bot;
    expect((await api("PATCH", `/api/bots/${lead.id}`, { modelSelection: { instanceId, model: "fake-model" } })).status).toBe(200);
    const group = (await api("POST", "/api/groups", {
      name: `Typed ${instanceId}`,
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    const sent = await api("POST", `/api/groups/${group.id}/messages`, { text, mode: "goal", sendId: `goal_${instanceId}_1234567890` });
    expect(sent.status).toBe(202);
    await expect.poll(async () => (await goalCard(group.id))?.status, { timeout: 20_000, message: stderr.slice(-2000) })
      .toMatch(/^(completed|blocked|failed|needs-input)$/);
    return { lead, group, card: await goalCard(group.id), messages: (await room(group.id)).messages as any[] };
  };

  beforeAll(async () => {
    for (const cli of ["fake-claude-cli.ts", "fake-acp-cli.ts", "fake-codex-app-server.ts", "fake-pi-cli.ts"]) chmodSync(fake(cli), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-typed-turns-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const instances = {
      claude: {
        driver: "claudeAgent",
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_REPLIES: JSON.stringify(claudeReplies), FAKE_CLAUDE_REPLY_STATE: join(home, "claude-replies.txt") },
        config: { cli: fake("fake-claude-cli.ts"), fullAuto: true },
      },
      echo: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "echo-gated" }, config: { cli: fake("fake-acp-cli.ts"), fullAuto: true } },
      codex: { driver: "codex", environment: {}, config: { cli: fake("fake-codex-app-server.ts"), fullAuto: true } },
      pi: { driver: "piAgent", environment: {}, config: { cli: fake("fake-pi-cli.ts"), fullAuto: true } },
    };
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances }));

    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
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

  it("claude: a fenced decision block split across assistant items completes the run and stays out of the room", async () => {
    const { card, messages } = await runGoal("claude", "Decide whether we ship.");
    expect(card).toMatchObject({ status: "completed", detail: "Typed decision honoured.", turnCount: 1 });
    const visible = messages.filter((m) => m.kind === "text" && m.role === "bot").map((m) => m.text);
    expect(visible).toEqual(["Ship it."]);
    expect(JSON.stringify(messages)).not.toContain("```");
  });

  it("acp echo: the same harness path validates a block that came back through a different engine", async () => {
    const { card, messages } = await runGoal("echo", 'Echo this decision.\n```json\n{"status":"completed","detail":"Echoed typed decision."}\n```');
    expect(card).toMatchObject({ status: "completed", detail: "Echoed typed decision." });
    // the coordinator's turn text carried the schema instruction, on this engine too
    const echoed = messages.find((m) => m.kind === "text" && m.role === "bot")?.text ?? "";
    expect(echoed).toContain("tagged json");
    expect(echoed).toContain('"required":["status"]');
  });

  it.each(["codex", "pi"])("%s: a prose-only reply fails closed with the reason on the card", async (instanceId) => {
    const { card } = await runGoal(instanceId, "Decide whether we ship.");
    expect(card.status).toBe("blocked");
    expect(card.detail).toContain("no fenced JSON block in the reply");
  });
});
