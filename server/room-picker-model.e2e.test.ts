// A room has no model belt. The speaker must use the visible 1:1 picker,
// not the bot-default that only seeds brand-new threads. Two fake engines
// with separate dump files prove which instance actually ran.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let defaultDump = "";
let pickerDump = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-picker-model-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  defaultDump = join(home, "default-engine.json");
  pickerDump = join(home, "picker-engine.json");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Room picker model</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      defaultEngine: {
        driver: "claudeAgent",
        displayName: "Bot default",
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: defaultDump },
        config: { cli: FAKE_CLAUDE },
      },
      pickerEngine: {
        driver: "claudeAgent",
        displayName: "Visible picker",
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: pickerDump },
        config: { cli: FAKE_CLAUDE },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "index.ts")], {
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
});

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("room turns follow the visible 1:1 picker", () => {
  it("uses the thread belt, not the bot default", async () => {
    const created = await api("POST", "/api/bots", {
      name: "Kiwi",
      modelSelection: { instanceId: "defaultEngine", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect(bot.modelSelection.instanceId).toBe("defaultEngine");

    const patched = await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, {
      modelSelection: { instanceId: "pickerEngine", model: "claude-sonnet-5" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.modelSelection.instanceId).toBe("defaultEngine");
    expect(patched.body.task.modelSelection.instanceId).toBe("pickerEngine");

    const teammate = await api("POST", "/api/bots", {
      name: "Gemma",
      modelSelection: { instanceId: "defaultEngine", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(teammate.status).toBe(201);

    const room = await api("POST", "/api/groups", {
      name: "Kiwi & co.",
      memberIds: [bot.id, teammate.body.bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    expect(room.status).toBe(201);

    expect((await api("POST", `/api/groups/${room.body.group.id}/messages`, { text: "Hi" })).status).toBe(202);

    await expect.poll(() => existsSync(pickerDump), { timeout: 20_000 }).toBe(true);
    expect(existsSync(defaultDump)).toBe(false);
    const dump = JSON.parse(readFileSync(pickerDump, "utf8")) as { systemPrompt?: string };
    expect(dump.systemPrompt ?? "").toContain("You are Kiwi, a bot in the room");

    expect((await api("POST", `/api/groups/${room.body.group.id}/interrupt`, {})).status).toBe(200);
  });
});
