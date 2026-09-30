// The risk check's wiring, end to end: the real server, the fake ACP CLI
// asking permission to run `echo hi` under Full access, and a local
// Jev-compatible double (decider.baseUrl may be http on loopback) that
// answers the risk score. A confident High turns the approval into a card
// with its own note and decision row; a low one approves as before.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DecisionRow } from "../decision-log.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { openSse } from "../testing/sse.ts";
import { RISK_CHECK } from "./jobs.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess | undefined;
let jev: Server;
let home: string;
let stderr = "";
/** What the double answers for High, the riskCheck level that holds. */
let high = 0.85;
/** What the double answers for notifyUrgency. */
let urgency: "urgent" | "later" = "urgent";
/** What the double answers for stuckCheck. */
let stuck = 0.1;
const asked: Array<{ state: any; questions: any }> = [];

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function waitFor<T>(probe: () => Promise<T | null | undefined>, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const decision = (pred: (row: DecisionRow) => boolean) => waitFor(async () =>
  ((await api("GET", "/api/decisions")).body.decisions as DecisionRow[] ?? []).filter(pred).at(-1));

async function boot() {
  stderr = "";
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));
  const up = await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, 20_000);
  if (!up) throw new Error(`server never came up. stderr:\n${stderr}`);
}

posixOnly("risk check holds a risky Full access approval for the person", () => {
  let botId = "";

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    jev = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        asked.push({ state: body.state, questions: body.questions });
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries(body.questions as Record<string, { type: string; criteria: unknown }>)) {
          if (question.type === "score") {
            const rest = (1 - high) / 2;
            answers[id] = { type: "score", score: rest + 2 * high, probabilities: { 0: rest, 1: rest, 2: high } };
          } else if (question.type === "choice") {
            const other = urgency === "later" ? "urgent" : "later";
            answers[id] = { type: "choice", choice: urgency, probabilities: { [urgency]: 0.9, [other]: 0.1 } };
          } else {
            answers[id] = { type: "noul", noul: stuck };
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers, model: "jev-test" }));
      });
    });
    await new Promise<void>((resolve) => jev.listen(0, "127.0.0.1", resolve));
    const jevPort = (jev.address() as AddressInfo).port;

    home = mkdtempSync(join(tmpdir(), "omb-risk-check-e2e-"));
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances: {
        grok: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_CLI, fullAuto: false } },
        grokloop: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "repeat-tool", FAKE_ACP_TOOL_MS: "3000" }, config: { cli: FAKE_CLI, fullAuto: false } },
      },
      decider: { enabled: true, provider: "jev", key: "tsk_fixture_only", baseUrl: `http://127.0.0.1:${jevPort}` },
    }));
    await boot();
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    botId = created.body.bot.id;
    expect((await api("PATCH", `/api/bots/${botId}`, { name: "Risky", modelSelection: { instanceId: "grok", model: "fake-model" } })).status).toBe(200);
    // Fixture setup, not a grant path: stop this disposable server and give
    // its bot Full access in the saved file, the way full-access-workflows
    // does.
    await waitForExit(child!, { signal: "SIGTERM" });
    const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const saved = bots.find((bot: { id: string }) => bot.id === botId);
    saved.approvalMode = "full";
    saved.autoApprove = false;
    for (const task of saved.tasks ?? []) { task.approvalMode = "full"; task.autoApprove = false; }
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots, null, 2));
    await boot();
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await new Promise((resolve) => jev?.close(resolve));
    await removeTempDir(home);
  });

  it("a confident High leaves the card open with its own note and row", async () => {
    high = 0.85;
    urgency = "later";
    const stream = await openSse(`${BASE}/api/events`);
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "run it" })).status).toBe(202);
    const card = await waitFor(async () => {
      const bot = ((await api("GET", "/api/bots")).body.bots ?? []).find((b: { id: string }) => b.id === botId);
      return bot?.messages?.find((m: any) => m.kind === "options" && m.card?.requestId && !m.card.answered);
    });
    expect(card, `no card appeared. stderr:\n${stderr}`).not.toBeNull();
    expect(card.card.heldCode).toBe("approval.held.risky");
    expect(card.card.held).toMatch(/^Held for you: this looks risky/);
    const row = await decision((r) => r.decision === "card-shown" && r.requestId === card.card.requestId);
    expect(row?.source).toBe("decider-risk");
    expect(row?.rule).toBe("riskCheck High p=0.85");
    // nothing approved it
    const rows = (await api("GET", "/api/decisions")).body.decisions as DecisionRow[];
    expect(rows.filter((r) => r.decision === "auto-approved" && r.botId === botId)).toEqual([]);
    // the request Jev saw is the contract's, carrying the action
    const risk = asked.find((a) => a.questions.answer?.type === "score");
    expect(risk?.questions.answer.instructions).toBe(RISK_CHECK.instructions);
    expect(risk?.state.action).toMatchObject({ tool: "shell", summary: "echo hi" });
    expect(Object.keys(risk!.state).every((key) => RISK_CHECK.stateKeys.includes(key))).toBe(true);
    // the person still decides
    const answered = await api("POST", `/api/bots/${botId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    expect(answered.status).toBe(200);
    expect(await decision((r) => r.decision === "user-approved" && r.requestId === card.card.requestId)).not.toBeNull();
    try {
      // the held card buzzes like any approval, never quietened
      const approval = await stream.until((f) => f.kind === "notify" && f.notification?.kind === "approval" && f.notification.botId === botId, 20_000);
      expect(approval.notification).not.toHaveProperty("quiet");
      // the turn's "finished", judged "later", arrives quietly
      const done = await stream.until((f) => f.kind === "notify" && f.notification?.kind === "done" && f.notification.botId === botId, 20_000);
      expect(done.notification).toMatchObject({ title: "Risky finished", quiet: true });
    } finally {
      stream.close();
    }
  }, 60_000);

  it("a low High approves exactly as Full access did before", async () => {
    high = 0.2;
    urgency = "urgent";
    // the previous turn has to settle before the next message starts one
    await waitFor(async () => {
      const bot = ((await api("GET", "/api/bots")).body.bots ?? []).find((b: { id: string }) => b.id === botId);
      return bot && !bot.busy;
    });
    const before = ((await api("GET", "/api/decisions")).body.decisions as DecisionRow[]).length;
    const stream = await openSse(`${BASE}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${botId}/messages`, { text: "run it again" })).status).toBe(202);
      const row = await waitFor(async () =>
        ((await api("GET", "/api/decisions")).body.decisions as DecisionRow[]).slice(before).find((r) => r.botId === botId));
      expect(row, `no decision. stderr:\n${stderr}`).not.toBeNull();
      expect(row).toMatchObject({ decision: "auto-approved", source: "full-access" });
      // "urgent": sent as today, with no quiet field at all
      const done = await stream.until((f) => f.kind === "notify" && f.notification?.kind === "done" && f.notification.botId === botId, 20_000);
      expect(done.notification).not.toHaveProperty("quiet");
    } finally {
      stream.close();
    }
  }, 60_000);

  it("a confident stuck check adds one plain chip and a notification, and the turn runs on", async () => {
    stuck = 0.92;
    const created = await api("POST", "/api/bots");
    const loopy = created.body.bot.id as string;
    expect((await api("PATCH", `/api/bots/${loopy}`, { name: "Loopy", modelSelection: { instanceId: "grokloop", model: "fake-model" } })).status).toBe(200);
    const stream = await openSse(`${BASE}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${loopy}/messages`, { text: "make the auth tests pass" })).status).toBe(202);
      const frame = await stream.until((f) => f.kind === "notify" && f.notification?.kind === "stuck" && f.notification.botId === loopy, 20_000);
      expect(frame.notification).toMatchObject({ title: "Loopy looks stuck", body: "Repeating the same steps. Stop it or give it a hint." });
      // the turn was not stopped: it finishes with its own reply
      await stream.until((f) => f.kind === "notify" && f.notification?.kind === "done" && f.notification.botId === loopy, 20_000);
      const bot = ((await api("GET", "/api/bots")).body.bots ?? []).find((b: { id: string }) => b.id === loopy);
      const chips = (bot.messages as any[]).filter((m) => m.kind === "activity").map((m) => m.tool?.name as string);
      expect(chips.filter((name) => name.startsWith("Same call repeated 5×"))).toHaveLength(1);
      expect(chips.filter((name) => name === "Loopy looks stuck: repeating the same steps. Stop it or give it a hint.")).toHaveLength(1);
      expect((bot.messages as any[]).some((m) => m.kind === "text" && m.text === "still failing")).toBe(true);
      // the request carried the contract's keys: the task and the steps
      const asked1 = asked.find((a) => a.questions.answer?.type === "noul" && Array.isArray(a.state.recent_steps));
      expect(asked1?.state.task).toBe("make the auth tests pass");
      expect(asked1?.state.recent_steps.length).toBeGreaterThanOrEqual(5);
    } finally {
      stream.close();
    }
  }, 60_000);
});
