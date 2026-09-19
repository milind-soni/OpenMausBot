// A bot whose engine also runs outside this server (a Telegram gateway, a Slack
// bot) holds no turn-scoped capability. `<data dir>/external-runtimes.json`
// gives it a standing one for its main thread: real server, fake engine.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const TOKEN = "external-runtime-fixture-token-0123456789abcdef";

let child: ChildProcess;
let home = "";
let data = "";
let base = "";
let stderr = "";

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() as any };
};
const asRuntime = (method: string, path: string, body?: unknown, token = TOKEN) =>
  api(method, path, body, { authorization: `Bearer ${token}` });
const createBot = async (name: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId: "plain", model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;
const botState = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === botId);
const runtimesFile = () => join(data, "external-runtimes.json");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-external-runtime-"));
  data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>External runtime test</title>");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      plain: {
        driver: "claudeAgent",
        displayName: "Plain fixture",
        environment: { FAKE_CLAUDE_MODE: "happy" },
        config: { cli: FAKE_CLAUDE },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("a bot's external runtime", () => {
  it("gets a standing agents capability for its main thread from external-runtimes.json", async () => {
    const runtime = await createBot("Gateway");
    const peer = await createBot("Peer");
    try {
      // nothing configured: the bearer is just an unknown token
      expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);

      // the file is read on demand — no restart between writing it and using it
      writeFileSync(runtimesFile(), JSON.stringify({ [runtime.id]: TOKEN }), { mode: 0o600 });
      const roster = await asRuntime("GET", "/api/internal/agents");
      expect(roster.status).toBe(200);
      const names = roster.body.bots.map((bot: { name: string }) => bot.name);
      expect(names).toContain("Peer");
      expect(names).not.toContain("Gateway"); // the caller itself is never a peer
      expect((await asRuntime("GET", "/api/internal/agents", undefined, `${TOKEN}x`)).status).toBe(401);

      // a token another user could read is not a secret
      if (process.platform !== "win32") {
        chmodSync(runtimesFile(), 0o644);
        expect((await asRuntime("GET", "/api/internal/agents")).status).toBe(401);
        chmodSync(runtimesFile(), 0o600);
      }

      // The runtime has no live turn on this server, so its delegation cannot
      // wait for one to finish: it is picked up immediately, from the bot's
      // own main thread, which never needed a warm-up task.
      const tasksBefore = (await botState(peer.id)).tasks.length;
      const delegated = await asRuntime("POST", "/api/internal/delegate-bot", {
        fromBotId: runtime.id,
        toBotId: peer.id,
        message: "Peer, take this one",
      });
      expect(delegated.status).toBe(200);
      expect(delegated.body).toMatchObject({ queued: true });
      expect(String(delegated.body.message)).toContain("picking it up now");
      await expect.poll(async () => {
        const state = await botState(peer.id);
        return state.tasks.length > tasksBefore || !!state.busy;
      }, { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await botState(peer.id)).busy, { timeout: 15_000 }).toBeFalsy();

      // the capability is peer comms only: nothing that creates or changes state
      for (const [method, path, body] of [
        ["POST", "/api/internal/threads", { fromBotId: runtime.id, fromThreadId: runtime.threadId, title: "Side quest", message: "go" }],
        ["POST", "/api/internal/create-bot", { fromBotId: runtime.id, name: "Minion" }],
        ["POST", "/api/internal/create-room", { fromBotId: runtime.id, name: "War room" }],
        ["POST", "/api/internal/coordinate-bots", { message: "all hands" }],
        ["POST", "/api/internal/skills/stage", { name: "x" }],
        ["GET", "/api/internal/memory", undefined],
      ] as const) {
        expect((await asRuntime(method, path, body)).status, `${method} ${path}`).toBe(403);
      }
      const gateway = await botState(runtime.id);
      expect(gateway.tasks.length).toBe(1); // no task was opened on the runtime's bot either
    } finally {
      for (const bot of [runtime, peer]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 40_000);
});
