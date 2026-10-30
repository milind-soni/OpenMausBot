// The fake Claude CLI in `slow` mode holds the turn behind a gate; the test drives the broker directly, as the permission proxy does. POSIX-gated.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let finishGate = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const getBot = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === id);
const threadMessages = async (threadId: string): Promise<Array<{ kind: string; card?: { requestId?: string; answered?: string } }>> =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];

/** Duplicated, not imported: DATA_DIR there is fixed at import time from this process's HOME. Keep in lockstep with claude.ts. */
function brokerCandidates(threadId: string, botId: string): string[] {
  const dataDir = join(home, ".openmausbot");
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(`${botId}\0${threadId}`).digest("hex").slice(0, 4);
  const scope = createHash("sha256").update(`${dataDir}\0${child.pid}\0${botId}\0${threadId}`).digest("hex").slice(0, 16);
  return [join(dataDir, `perm-${prefix}${digest}.sock`), join(tmpdir(), `omb-perm-${scope}.sock`)];
}

async function connectBroker(threadId: string, botId: string): Promise<Socket> {
  await expect.poll(() => brokerCandidates(threadId, botId).some((path) => existsSync(path)), { timeout: 20_000 }).toBe(true);
  for (const path of brokerCandidates(threadId, botId)) {
    if (!existsSync(path)) continue;
    const socket = await new Promise<Socket | null>((resolve) => {
      const conn = connect(path);
      conn.once("connect", () => resolve(conn));
      conn.once("error", () => resolve(null));
    });
    if (socket) return socket;
  }
  throw new Error(`no broker socket among ${brokerCandidates(threadId, botId).join(", ")}`);
}

function ask(conn: Socket, id: string, command: string): { answered: () => boolean } {
  let answered = false;
  conn.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.t === "answer" && msg.id === id) answered = true;
      } catch {
      }
    }
  });
  conn.write(JSON.stringify({ t: "ask", id, kind: "permission", tool: "Bash", input: { command } }) + "\n");
  return { answered: () => answered };
}

posixOnly("a steered message does not lift the unattended mark on its own", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-unattended-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    finishGate = join(home, "finish.gate");
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
          // acceptEdits: permission asks reach the broker, where a real tool call's ask would arrive.
          config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" },
        },
      },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        // Under a deep HOME the broker falls back to os.tmpdir(); the child has to agree with this process about where that is.
        TMPDIR: tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 40_000);

  afterAll(async () => {
    writeFileSync(finishGate, "finish");
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("keeps asking after the turn POSTs into itself with no session", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    // auto mode ON: an attended turn would sail straight through
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      autoApprove: true,
      modelSelection: { instanceId: "claude", model: "claude-fake" },
    })).status).toBe(200);
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

    // A webhook run works in a conversation of its own, out of the way: the turn names it when it POSTs into itself.
    let runThreadId = "";
    await expect.poll(async () => {
      const run = ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === runId);
      runThreadId = run?.threadId ?? "";
      return Boolean(runThreadId);
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await getBot(bot.id))?.busy === true && (await getBot(bot.id))?.threadId !== runThreadId, {
      timeout: 20_000,
    }).toBe(true);

    const conn = await connectBroker(runThreadId, bot.id);
    try {
      const steer = await api("POST", `/api/bots/${bot.id}/messages`, { text: "continue", threadId: runThreadId });
      expect(steer.status).toBe(202);
      expect(steer.body.steered).toBe(true);

      // An ordinary command on purpose: the destructive guard would card `rm -rf` whatever the mark said.
      const second = ask(conn, "ask-after-steer", "ls -la ./dist");
      await expect.poll(
        async () => (await threadMessages(runThreadId)).some((m) => m.kind === "options" && m.card?.requestId === "ask-after-steer"),
        { timeout: 20_000 },
      ).toBe(true);
      const card = (await threadMessages(runThreadId)).find((m) => m.card?.requestId === "ask-after-steer");
      expect(card?.card?.answered, "the steered turn auto-approved — the self-POST lifted the unattended mark").toBeUndefined();
      expect(second.answered()).toBe(false);
    } finally {
      conn.destroy();
      writeFileSync(finishGate, "finish");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
    }
  }, 60_000);
});
