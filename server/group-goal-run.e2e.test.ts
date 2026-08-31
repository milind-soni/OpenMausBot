import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const completeReplies = [
  [
    "Scout should verify the draft.\n<openmaus-goal>{\"status\":\"continue\",",
    "\"next\":\"Scout\",\"instruction\":\"Verify the draft and report evidence\",\"detail\":\"Draft prepared\"}</openmaus-goal>",
  ],
  "The draft is accurate and the cited evidence checks out.",
  "The verified draft is ready to ship.\n<openmaus-goal>{\"status\":\"completed\",\"detail\":\"Draft produced and independently verified.\"}</openmaus-goal>",
];

const loopReplies = Array.from({ length: 13 }, (_, index) =>
  index % 2 === 0
    ? `More work is needed.\n<openmaus-goal>{"status":"continue","next":"Looper","instruction":"Try approach ${index / 2 + 1}","detail":"Still working"}</openmaus-goal>`
    : `Approach ${Math.ceil(index / 2)} did not finish the task.`,
);

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-goal-run-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Goal run test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      complete: {
        driver: "claudeAgent",
        displayName: "Completing fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify(completeReplies),
          FAKE_CLAUDE_REPLY_STATE: join(home, "complete-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      loop: {
        driver: "claudeAgent",
        displayName: "Looping fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify(loopReplies),
          FAKE_CLAUDE_REPLY_STATE: join(home, "loop-replies.txt"),
        },
        config: { cli: FAKE_CLAUDE },
      },
      crash: {
        driver: "claudeAgent",
        displayName: "Failing fixture",
        environment: { FAKE_CLAUDE_MODE: "exit-early" },
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

describe("goal-driven channel runs", () => {
  it("returns to the lead until the goal is completed and appends a clean receipt", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Lead",
      modelSelection: { instanceId: "complete", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const scout = (await api("POST", "/api/bots", {
      name: "Scout",
      modelSelection: { instanceId: "complete", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Launch team",
      memberIds: [lead.id, scout.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    const sent = await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Produce and verify the launch draft",
      mode: "goal",
      sendId: "goal_send_1234567890",
    });
    expect(sent.status).toBe(202);
    expect(sent.body.message).toMatchObject({ channelMode: "goal" });

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    }, { timeout: 10_000 }).toMatchObject({
      status: "completed",
      coordinatorBotId: lead.id,
      turnCount: 3,
      detail: "Draft produced and independently verified.",
    });

    const state = (await api("GET", "/api/bots?messages=30")).body;
    const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
    expect(current.messages.find((message: { kind: string }) => message.kind === "goal.run")?.text)
      .toBe("Goal completed: Draft produced and independently verified.");
    expect(current.working).toBe(false);
    expect(current.messages.filter((message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot")
      .map((message: { from?: { name?: string } }) => message.from?.name)).toEqual(["Lead", "Scout", "Lead"]);
    expect(JSON.stringify(current.messages)).not.toContain("<openmaus-goal>");
  });

  it("pauses a non-converging team at the hard turn limit", async () => {
    const looper = (await api("POST", "/api/bots", {
      name: "Looper",
      modelSelection: { instanceId: "loop", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Bounded team",
      memberIds: [looper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: looper.id } },
    })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Keep trying forever",
      mode: "goal",
    })).status).toBe(202);

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=40")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    }, { timeout: 15_000 }).toMatchObject({ status: "limit-reached", turnCount: 13, maxTurns: 13 });
  });

  it("never treats a failed provider turn as a completed goal", async () => {
    const lead = (await api("POST", "/api/bots", {
      name: "Failing lead",
      modelSelection: { instanceId: "crash", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Failure checks",
      memberIds: [lead.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;

    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Do not claim this succeeded",
      mode: "goal",
    })).status).toBe(202);

    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=20")).body;
      const current = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      return current?.messages.find((message: { kind: string }) => message.kind === "goal.run")?.goalRun;
    }, { timeout: 10_000 }).toMatchObject({ status: "failed", turnCount: 1 });
  });

  it("validates mode and binds it to the send id", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Mode checks",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello", mode: "forever" })).status).toBe(400);
    const body = { text: "quiet note", mode: "chat", sendId: "mode_send_1234567890" };
    expect((await api("POST", `/api/groups/${room.id}/messages`, body)).status).toBe(202);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { ...body, mode: "goal" })).status).toBe(409);

    const dm = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: { dm?: boolean }) => group.dm);
    if (dm) expect((await api("POST", `/api/groups/${dm.id}/messages`, { text: "goal", mode: "goal" })).status).toBe(400);
  });
});
