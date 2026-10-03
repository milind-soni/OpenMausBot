// A settled approval card must stay settled. POST /api/threads/:id/respond
// delivers the answer to the engine and the card records it; a replayed or
// raced second call for the same requestId finds no live request and takes
// the "unavailable" path. That path exists to tell the truth about a card
// nobody could reach (the engine went away) — fired over an already-answered
// card it used to append a false "Couldn't deliver that answer" activity
// message under the correctly-answered card, for a double-tap, a second tab,
// or a client retry.
//
// The real server runs against the fake ACP CLI in "permission" mode (every
// turn asks to run `echo hi`):
//
//   1. allow a live card once — it settles, exactly one decision is logged,
//      and no "Couldn't deliver" message appears;
//   2. respond again with the same requestId — still ok, and the transcript
//      gains no "Couldn't deliver" message;
//   3. respond with a requestId that was never issued — the message DOES
//      appear, so the same guard still tells the truth about a genuinely
//      unknown request.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DecisionRow } from "./decision-log.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");
const UNDELIVERED = "Couldn't deliver that answer";

let child: ChildProcess;
let home: string;
let log = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function start() {
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_WEBHOOK_PORT: String(PORT + 1),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (log += c));
  child.stderr!.on("data", (c) => (log += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitFor<T>(read: () => Promise<T | null | undefined>, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const messages = async (threadId: string): Promise<any[]> =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];
const undelivered = async (threadId: string) =>
  (await messages(threadId)).filter((m) => typeof m.tool?.name === "string" && m.tool.name.includes(UNDELIVERED));
const openCard = (threadId: string) => waitFor(async () =>
  (await messages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered) ?? null);
const userDecisionsFor = async (requestId: string) => {
  const { body } = await api("GET", "/api/decisions");
  return ((body.decisions ?? []) as DecisionRow[]).filter(
    (row) => row.requestId === requestId && (row.decision === "user-approved" || row.decision === "user-denied"),
  );
};

posixOnly("a replayed respond for a settled card", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-respond-replay-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { grok: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_CLI, fullAuto: false } } },
    }));
    await start();
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("appends no couldn't-deliver message on replay, but still reports an unknown request", async () => {
    const created = await api("POST", "/api/bots", { name: "Replayed" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    const patched = await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "grok", model: "fake-model" } });
    expect(patched.status).toBe(200);

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it", threadId: bot.threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const card = await openCard(bot.threadId);
    expect(card, `no approval card appeared:\n${log.slice(-2_000)}`).not.toBeNull();
    const requestId = card.card.requestId as string;

    const first = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.outcome).not.toBe("unavailable");
    const settled = await waitFor(async () =>
      (await messages(bot.threadId)).find((m) => m.card?.requestId === requestId && m.card.answered) ?? null);
    expect(settled?.card.answered).toBe("allow");
    expect(await undelivered(bot.threadId)).toHaveLength(0);

    // The replay: a double-tap, a second tab, or a retried request. The route
    // stays honest — ok, nothing delivered — but the transcript must not cry
    // failure under a card that already shows its answer.
    const replay = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.outcome).toBe("unavailable");
    expect(await undelivered(bot.threadId)).toHaveLength(0);
    expect(await userDecisionsFor(requestId)).toHaveLength(1);

    // Control: a requestId that was never issued is a genuine miss, and the
    // message still says so — the replay guard did not silence it.
    const unknown = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: "req-never-issued", behavior: "allow" });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(200);
    expect(unknown.body.outcome).toBe("unavailable");
    expect(await undelivered(bot.threadId)).toHaveLength(1);
  }, 90_000);
});
