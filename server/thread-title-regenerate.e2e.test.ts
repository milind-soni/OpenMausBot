import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// Regenerate title (#1858) end to end: a real server and the fake claude
// CLI, whose one-shot text mode answers from a file each test rewrites.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let output = "";
let titleFile = "";
let titleDump = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const taskTitle = async (botId: string, threadId: string): Promise<string | undefined> => {
  const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === botId);
  return bot?.tasks?.find((task: { threadId: string }) => task.threadId === threadId)?.title;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-regenerate-title-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Regenerate title test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  titleFile = join(home, "title.txt");
  titleDump = join(home, "title-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    features: { llmThreadTitles: true },
    instances: {
      titled: {
        driver: "claudeAgent", displayName: "Titled fixture", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_TEXT_DUMP: titleDump, FAKE_CLAUDE_TEXT_FILE: titleFile },
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
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // still starting
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("Regenerate title", { timeout: 60_000 }, () => {
  let botId = "";
  let threadId = "";

  it("offers itself through the config only while generated titles are on", async () => {
    expect((await api("GET", "/api/config")).body.features.llmThreadTitles).toBe(true);
  });

  it("names a renamed thread from its recent conversation, without tool output", async () => {
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "titled", model: "claude-sonnet-5" }, requireAvailableModel: true,
    })).body.bot;
    botId = bot.id;
    // background memory capture is a one-shot too; keep it off this dump
    expect((await api("PATCH", `/api/bots/${botId}`, { memoryUpkeep: false })).status).toBe(200);
    // the first-message title one-shot fails (no reply file): the snippet stays
    rmSync(titleFile, { force: true });
    const sent = await api("POST", `/api/bots/${botId}/messages`, { text: "every login hangs after the session expires" });
    expect(sent.status).toBe(202);
    threadId = sent.body.threadId;
    await expect.poll(async () => {
      const page = (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body;
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === botId);
      return !current?.busy && (page?.messages ?? []).some((message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text");
    }, { timeout: 20_000, interval: 150 }).toBe(true);
    await expect.poll(() => existsSync(titleDump), { timeout: 10_000 }).toBe(true);
    rmSync(titleDump, { force: true });

    // a person's name for it is no obstacle: they asked for a new one
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { title: "My name for it" })).status).toBe(200);
    writeFileSync(titleFile, "\"Session expiry login hang.\"\n");
    const regenerated = await api("POST", `/api/bots/${botId}/tasks/${threadId}/title`);
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.task.title).toBe("Session expiry login hang");
    expect(await taskTitle(botId, threadId)).toBe("Session expiry login hang");

    const seen = JSON.parse(readFileSync(titleDump, "utf8"));
    expect(seen.prompt).toContain("Conversation:\n");
    expect(seen.prompt).toContain("User: every login hangs after the session expires\nBot: hello from fake claude");
    // the fake's turn ran `echo hi`; tool input and output stay out
    expect(seen.prompt).not.toContain("echo hi");
  });

  it("keeps the current title and says so when the one-shot fails or answers something unusable", async () => {
    writeFileSync(titleFile, "__FAIL__");
    const failed = await api("POST", `/api/bots/${botId}/tasks/${threadId}/title`);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatch(/couldn't generate a title/);
    writeFileSync(titleFile, "This answer rambles on far too long to ever be a thread title");
    const unusable = await api("POST", `/api/bots/${botId}/tasks/${threadId}/title`);
    expect(unusable.status).toBe(502);
    expect(await taskTitle(botId, threadId)).toBe("Session expiry login hang");
  });

  it("refuses a thread with nothing to name it from, and an unknown one", async () => {
    const fresh = (await api("POST", `/api/bots/${botId}/tasks`, {})).body.task;
    const empty = await api("POST", `/api/bots/${botId}/tasks/${fresh.threadId}/title`);
    expect(empty.status).toBe(409);
    expect(empty.body.error).toMatch(/no messages/);
    expect((await api("POST", `/api/bots/${botId}/tasks/no-such-thread/title`)).status).toBe(404);
  });

  it("is refused once generated titles are switched off", async () => {
    expect((await api("PATCH", "/api/config", { features: { llmThreadTitles: false } })).status).toBe(200);
    expect((await api("GET", "/api/config")).body.features.llmThreadTitles).toBe(false);
    writeFileSync(titleFile, "Anything at all");
    const off = await api("POST", `/api/bots/${botId}/tasks/${threadId}/title`);
    expect(off.status).toBe(409);
    expect(await taskTitle(botId, threadId)).toBe("Session expiry login hang");
  });
});
