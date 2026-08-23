// Webhook origin is provenance, not a blanket approval veto. These tests
// pin the wiring across a direct webhook turn and both peer-comms hops:
// safe scoped work keeps moving, while the classifier remains the single
// place that can ask or deny.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";


const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
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

async function waitForRunTerminal(runId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/routines");
    const run = (body.runs ?? []).find((r: { id: string }) => r.id === runId);
    if (run && ["completed", "failed", "cancelled", "missed"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function waitForBotAutoApproval(botId: string, ms = 40_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots.find((b: { id: string }) => b.id === botId);
    const approval = bot?.messages?.find(
      (m: { kind: string; tool?: { name?: string } }) =>
        m.kind === "activity" && m.tool?.name?.startsWith("auto-approved"),
    );
    if (approval) return { approval, bot };
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

posixOnly("unattended safe work keeps moving", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
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
          codex: {
            driver: "codex",
            environment: {
              FAKE_CODEX_MODE: "approval",
              FAKE_CODEX_APPROVAL_COMMAND: "echo hi",
            },
            config: { cli: FAKE_CODEX, fullAuto: true },
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
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "auto-approves safe work when a webhook starts the turn",
    async () => {
      const bots = await api("GET", "/api/bots");
      const bot = bots.body.bots[0];
      // auto mode ON: an attended turn would sail straight through
      expect(
        (
          await api("PATCH", `/api/bots/${bot.id}`, {
            autoApprove: true,
            modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
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

      const terminal = await waitForRunTerminal(runId);
      expect(terminal?.status).toBe("completed");
      const card = await waitForCard(threadId!, 1_000);
      expect(card, "safe webhook work stopped for approval").toBeNull();
    },
    60_000,
  );

  it(
    "keeps safe work moving after it is handed to a teammate",
    async () => {
      // A runs the webhook and delegates; B does the acting. Provenance
      // crosses the hop for audit without turning safe work into a card.
      const created = await api("POST", "/api/bots");
      const teammate = created.body.bot;
      await api("PATCH", `/api/bots/${teammate.id}`, {
        name: "Teammate",
        autoApprove: true,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
      });

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

      const result = await waitForBotAutoApproval(teammate.id);
      expect(result?.approval, "the delegated safe request was not auto-approved").toBeTruthy();
      expect(
        result?.bot.messages?.find(
          (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
        ),
      ).toBeUndefined();
    },
    90_000,
  );

  it(
    "keeps safe work moving when a teammate is pulled in synchronously",
    async () => {
      // ask_bot rather than delegate_bot: same provenance, synchronous hop.
      // The fake asks whichever peer list_bots returns first, so
      // everything else is hidden to make the target deterministic.
      const existing = await api("GET", "/api/bots");
      for (const b of existing.body.bots) await api("PATCH", `/api/bots/${b.id}`, { hidden: true });

      const target = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${target.id}`, {
        name: "Answerer",
        autoApprove: true,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
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

      const result = await waitForBotAutoApproval(target.id);
      expect(result?.approval, "the synchronously asked safe request was not auto-approved").toBeTruthy();
      expect(
        result?.bot.messages?.find(
          (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
        ),
      ).toBeUndefined();
    },
    90_000,
  );
});
