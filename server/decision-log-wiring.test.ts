// The decision log is only as good as its wiring: every row is written at
// the request.opened fold or in answerRequest, and both of those keep
// working (cards keep appearing, approvals keep flowing) even when the
// logging silently rots away. So, in the style of unattended.test.ts,
// these run the real server against the fake ACP CLI and assert the ROWS,
// not the behavior the rows describe:
//
//   1. a rule-matched auto-approval writes a row naming the rule
//   2. an undeliverable automatic allow records failure, never success
//   3. a raw protected-value request writes an automatic denial row
//   4. an undeliverable raw-value denial records failure, never success
//   5. a destructive card and the human's answer write two rows
//   6. safe webhook work preserves unattended provenance without carding
//   7. GET /api/decisions pages newest-last with ?limit=
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

/** Newest matching decision row, or null when none shows up in time. */
async function waitForDecision(pred: (r: DecisionRow) => boolean, ms = 30_000): Promise<DecisionRow | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { body } = await api("GET", "/api/decisions");
    const rows: DecisionRow[] = body.decisions ?? [];
    const row = rows.filter(pred).at(-1);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A live permission card on a bot's transcript (via /api/bots — the same
 * poll unattended.test.ts uses, since a bot's card lives on its thread). */
async function waitForBotCard(botId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/bots");
    const bot = (body.bots ?? []).find((b: { id: string }) => b.id === botId);
    const card = bot?.messages?.find(
      (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
        m.kind === "options" && m.card?.requestId && !m.card.answered,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** A live permission card on a THREAD — webhook turns run in detached
 * tasks, so their cards never appear on the bot's open conversation. */
async function waitForThreadCard(threadId: string, ms = 30_000) {
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

/** A bot whose fake engine asks permission to run `echo hi` (the ACP core
 * folds that to tool "shell", summary "echo hi" — so the always-allow key
 * is "shell:echo"). */
async function makePermissionBot(patch: Record<string, unknown>, instanceId = "grok") {
  const created = await api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const patched = await api("PATCH", `/api/bots/${bot.id}`, {
    ...patch,
    modelSelection: { instanceId, model: instanceId === "codex" ? "gpt-fake-default" : "fake-model" },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot ?? bot;
}

posixOnly("authorization decisions are logged", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-decisions-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
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
          codexRace: {
            driver: "codex",
            environment: {
              FAKE_CODEX_MODE: "approval-closed",
              FAKE_CODEX_APPROVAL_COMMAND: "echo hi",
            },
            config: { cli: FAKE_CODEX, fullAuto: true },
          },
          destructive: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "permission",
              FAKE_ACP_PERMISSION_COMMAND: ["rm", "-rf", "/"].join(" "),
            },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          sensitive: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "permission",
              FAKE_ACP_PERMISSION_COMMAND: ["cat", [".", "env"].join("")].join(" "),
            },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          sensitiveRace: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "permission-closed",
              FAKE_ACP_PERMISSION_COMMAND: ["cat", [".", "env"].join("")].join(" "),
            },
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
    "a rule-matched auto-approval writes a row naming the rule",
    async () => {
      const bot = await makePermissionBot({ name: "Granted", alwaysAllow: ["shell:echo"] }, "codex");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const row = await waitForDecision((r) => r.decision === "auto-approved" && r.botId === bot.id);
      expect(row, "the auto-approval never reached the decision log").not.toBeNull();
      expect(row!.source).toBe("always-allow");
      expect(row!.rule).toBe("shell:echo");
      expect(row!.tool).toBe("shell");
      expect(row!.summary).toBe("echo hi");
      expect(row!.botName).toBe("Granted");
      expect(row!.threadId).toBeTruthy();
      expect(row!.requestId).toBeTruthy();
    },
    60_000,
  );

  it(
    "an ask closed in the same batch is never logged as auto-approved",
    async () => {
      const bot = await makePermissionBot({ name: "AllowRace", alwaysAllow: ["shell:echo"] }, "codexRace");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const failed = await waitForDecision(
        (row) => row.decision === "allow-delivery-failed" && row.botId === bot.id,
      );
      const decisions = (await api("GET", "/api/decisions")).body.decisions as DecisionRow[];
      expect(failed, "the failed allow delivery never reached the decision log").not.toBeNull();
      expect(failed!.source).toBe("always-allow");
      expect(failed!.rule).toContain("delivery_failed");
      expect(
        decisions.some(
          (candidate: DecisionRow) => candidate.botId === bot.id && candidate.decision === "auto-approved",
        ),
      ).toBe(false);
      expect(await waitForBotCard(bot.id, 1_000)).toBeNull();
    },
    60_000,
  );

  it(
    "raw protected-value access is denied instead of carded",
    async () => {
      const bot = await makePermissionBot({ name: "Guarded" }, "sensitive");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const row = await waitForDecision((r) => r.decision === "auto-denied" && r.botId === bot.id);
      expect(row, "the automatic denial never reached the decision log").not.toBeNull();
      expect(row!.source).toBe("sensitive-guard");
      expect(row!.tool).toBe("shell");
      expect(await waitForBotCard(bot.id, 1_000)).toBeNull();
    },
    60_000,
  );

  it(
    "an undeliverable protected-value denial is logged as failure, never auto-denied",
    async () => {
      const bot = await makePermissionBot({ name: "GuardRace" }, "sensitiveRace");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const row = await waitForDecision((r) => r.decision === "deny-delivery-failed" && r.botId === bot.id);
      const decisions = (await api("GET", "/api/decisions")).body.decisions as DecisionRow[];
      expect(
        row,
        `the denial delivery failure never reached the decision log: ${JSON.stringify(decisions.filter((r) => r.botId === bot.id))}`,
      ).not.toBeNull();
      expect(row!.source).toBe("sensitive-guard");
      expect(row!.rule).toContain("delivery_failed");
      expect(
        decisions.some(
          (candidate: DecisionRow) => candidate.botId === bot.id && candidate.decision === "auto-denied",
        ),
      ).toBe(false);
      expect(await waitForBotCard(bot.id, 1_000)).toBeNull();
    },
    60_000,
  );

  it(
    "a card and the human's allow write two rows",
    async () => {
      const bot = await makePermissionBot({ name: "Askme" }, "destructive");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card, "no approval card ever appeared").not.toBeNull();
      const requestId = card.card.requestId as string;

      const shown = await waitForDecision((r) => r.decision === "card-shown" && r.requestId === requestId);
      expect(shown, "the card was shown but never logged").not.toBeNull();
      expect(shown!.source).toBe("destructive-guard");
      expect(shown!.botId).toBe(bot.id);
      expect(shown!.tool).toBe("shell");

      const answered = await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "allow" });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).not.toBe("unavailable");

      const user = await waitForDecision((r) => r.decision === "user-approved" && r.requestId === requestId);
      expect(user, "the human's answer never reached the decision log").not.toBeNull();
      expect(user!.source).toBe("user");
      expect(user!.tool).toBe("shell");
      expect(user!.summary).toBe(["rm", "-rf", "/"].join(" "));
      expect(user!.botName).toBe("Askme");
    },
    90_000,
  );

  it(
    "a human deny writes its row too",
    async () => {
      const bot = await makePermissionBot({ name: "Refused" }, "destructive");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card).not.toBeNull();
      const requestId = card.card.requestId as string;
      expect((await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "deny" })).status).toBe(200);

      const user = await waitForDecision((r) => r.decision === "user-denied" && r.requestId === requestId);
      expect(user, "the denial never reached the decision log").not.toBeNull();
      expect(user!.source).toBe("user");
    },
    90_000,
  );

  it(
    "a safe webhook turn keeps its approval provenance",
    async () => {
      const bot = await makePermissionBot(
        { name: "Nightshift", autoApprove: true, alwaysAllow: ["shell:echo"] },
        "codex",
      );

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
      const card = await waitForThreadCard(threadId!, 1_000);
      expect(card, "safe webhook work was converted into an approval card").toBeNull();

      const row = await waitForDecision((r) => r.threadId === threadId && r.decision === "auto-approved");
      expect(row, "the webhook auto-approval never reached the decision log").not.toBeNull();
      expect(row!.source).toBe("always-allow");
      expect(row!.rule).toBe("shell:echo");
      expect(row!.unattended).toBe(true);
      expect(row!.botId).toBe(bot.id);
    },
    90_000,
  );

  it("GET /api/decisions pages newest-last and validates limit", async () => {
    const all = (await api("GET", "/api/decisions")).body.decisions as DecisionRow[];
    expect(all.length).toBeGreaterThanOrEqual(2);
    const one = (await api("GET", "/api/decisions?limit=1")).body.decisions as DecisionRow[];
    expect(one).toHaveLength(1);
    expect(one[0]).toEqual(all.at(-1));
    expect((await api("GET", "/api/decisions?limit=0")).status).toBe(400);
    expect((await api("GET", "/api/decisions?limit=nope")).status).toBe(400);
  });
});
