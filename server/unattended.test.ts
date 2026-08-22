// Auto mode must not follow a turn that nobody started.
//
// The unit tests in auto-approve.test.ts pin the RULE; these pin the
// WIRING, which is the part that silently rots. Both of these pass if the
// unattended mark is never set, or set on the wrong key, or never read —
// so they are written to fail in exactly those cases:
//
//   1. a webhook delivery to a bot with auto mode ON must still produce an
//      approval card, not a silent auto-approval
//   2. and so must the turn that bot hands to a teammate — the gate has to
//      survive the peer-comms hop, or it protects the bot that read the
//      payload and releases the one that acts on it
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";


const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

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

/** Poll a THREAD for a live permission card. A webhook runs in its own
 * detached task, so the card never appears on the bot's open conversation —
 * looking there is how you convince yourself this works when it doesn't. */
async function waitForCard(threadId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", `/api/threads/${threadId}/messages`);
    const card = (body.messages ?? []).find(
      (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The detached task a webhook delivery created. */
async function waitForRunThread(runId: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/routines");
    const run = (body.runs ?? []).find((r: { id: string }) => r.id === runId);
    if (run?.threadId) return run.threadId as string;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

posixOnly("unattended turns keep asking", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-unattended-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          // asks the client for permission mid-turn, which is exactly the
          // moment auto mode would normally answer on the human's behalf
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // hands its work to a teammate, so the gate has to cross the hop
          delegator: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "delegate-peer" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // asks a teammate synchronously — the other comms path, and the
          // likelier one: a webhook bot pulling someone in for an answer
          asker: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "still asks a human when a webhook starts the turn, even with auto mode on",
    async () => {
      const bots = await api("GET", "/api/bots");
      const bot = bots.body.bots[0];
      // auto mode ON: an attended turn would sail straight through
      expect(
        (
          await api("PATCH", `/api/bots/${bot.id}`, {
            autoApprove: true,
            modelSelection: { instanceId: "grok", model: "fake-model" },
          })
        ).status,
      ).toBe(200);

      const hook = await api("POST", "/api/webhooks", {
        name: "Nightly build",
        prompt: "Handle the incoming build event",
        botId: bot.id,
        runOn: "maus",
      });
      expect(hook.status).toBe(201);

      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed" }),
      });
      expect(delivered.status).toBe(202);
      const { runId } = (await delivered.json()) as { runId: string };

      const threadId = await waitForRunThread(runId);
      expect(threadId, "the webhook never started a task").toBeTruthy();

      // the request must reach a person: a card with a live requestId
      const card = await waitForCard(threadId!);
      expect(card, "a webhook turn auto-approved instead of asking").not.toBeNull();
      expect(card.card.requestId).toBeTruthy();
      // and it must not already be answered
      expect(card.card.answered).toBeUndefined();
    },
    60_000,
  );

  it(
    "keeps asking after the work is handed to a teammate",
    async () => {
      // A runs the webhook and delegates; B does the acting. Without the
      // mark crossing the hop, the gate protects the bot that READ the
      // payload and releases the bot that ACTS on it.
      const created = await api("POST", "/api/bots");
      const teammate = created.body.bot;
      await api("PATCH", `/api/bots/${teammate.id}`, { name: "Teammate", autoApprove: true });

      const delegator = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${delegator.id}`, {
        name: "Delegator",
        autoApprove: true,
        modelSelection: { instanceId: "delegator", model: "fake-model" },
      });

      const hook = await api("POST", "/api/webhooks", {
        name: "Handoff",
        prompt: "Ask the Teammate to handle this",
        botId: delegator.id,
        runOn: "maus",
      });
      expect(hook.status).toBe(201);

      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "handoff" }),
      });
      expect(delivered.status).toBe(202);

      // the teammate's turn runs on ITS own thread, unattended by inheritance
      const deadline = Date.now() + 40_000;
      let card: { card?: { requestId?: string; answered?: string } } | null = null;
      while (Date.now() < deadline && !card) {
        const { body } = await api("GET", "/api/bots");
        const peer = body.bots.find((b: { id: string }) => b.id === teammate.id);
        card =
          peer?.messages?.find(
            (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
          ) ?? null;
        if (!card) await new Promise((r) => setTimeout(r, 300));
      }
      expect(card, "the delegated turn auto-approved — the gate did not cross the hop").not.toBeNull();
      expect(card!.card!.answered).toBeUndefined();
    },
    90_000,
  );

  it(
    "keeps asking when the teammate is pulled in synchronously",
    async () => {
      // ask_bot rather than delegate_bot. Same hole, different door, and
      // this is the ordinary shape: a webhook bot asking someone a question
      // mid-turn. The fake asks whichever peer list_bots returns first, so
      // everything else is hidden to make the target deterministic.
      const existing = await api("GET", "/api/bots");
      for (const b of existing.body.bots) await api("PATCH", `/api/bots/${b.id}`, { hidden: true });

      const target = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${target.id}`, {
        name: "Answerer",
        autoApprove: true,
        modelSelection: { instanceId: "grok", model: "fake-model" },
      });

      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        autoApprove: true,
        hidden: true, // keep it out of its own peer list's way
        modelSelection: { instanceId: "asker", model: "fake-model" },
      });

      const hook = await api("POST", "/api/webhooks", {
        name: "Ask a teammate",
        prompt: "Ask the Answerer what to do about this",
        botId: asker.id,
        runOn: "maus",
      });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "ask" }),
      });
      expect(delivered.status).toBe(202);

      const deadline = Date.now() + 40_000;
      let card: { card?: { requestId?: string; answered?: string } } | null = null;
      while (Date.now() < deadline && !card) {
        const { body } = await api("GET", "/api/bots");
        const peer = body.bots.find((b: { id: string }) => b.id === target.id);
        card =
          peer?.messages?.find(
            (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
          ) ?? null;
        if (!card) await new Promise((r) => setTimeout(r, 300));
      }
      expect(card, "the asked teammate auto-approved — ask_bot did not carry the gate").not.toBeNull();
      expect(card!.card!.answered).toBeUndefined();
    },
    90_000,
  );
});
