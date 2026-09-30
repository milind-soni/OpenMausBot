import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MODEL_ROUTING } from "./decider/jobs.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// Model routing end to end: a real server and the fake Claude CLI, with the
// decision model pointed at a fake Jev-compatible endpoint on this machine
// (decider.baseUrl). Nothing here reaches the real Jev API.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const KEY = "tsk_e2e_model_routing_4b1d0c9e";

type Script = { status?: number; light?: number };

let child: ChildProcess;
let jev: Server;
let home = "";
let base = "";
let output = "";
let engineDump = "";
const scoreRequests: Array<{ auth?: string; body: any }> = [];
let script: Script = {};

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
};

beforeAll(async () => {
  jev = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const question = body.questions?.answer;
      if (req.url !== "/v1/systemone" || body.model !== "jev-latest" || !question) return send(422, { detail: "bad request shape" });
      if (question.type === "noul") return send(200, { answers: { answer: { type: "noul", noul: 0.96 } } });
      if (question.type !== "score") return send(422, { detail: "unexpected question" });
      scoreRequests.push({ auth: req.headers.authorization, body });
      if (script.status && script.status !== 200) return send(script.status, { detail: "overloaded" });
      const light = script.light ?? 0.1;
      const rest = Math.round((1 - light) * 100) / 100;
      send(200, { answers: { answer: { type: "score", score: rest * 1.5, probabilities: { 0: light, 1: rest / 2, 2: rest / 2 } } }, usage: { input_tokens: 90 } });
    });
  });
  await new Promise<void>((resolve) => jev.listen(0, "127.0.0.1", resolve));
  const jevUrl = `http://127.0.0.1:${(jev.address() as AddressInfo).port}`;

  home = mkdtempSync(join(tmpdir(), "omb-decider-model-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Decider model routing test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  engineDump = join(home, "engine-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      quick: {
        driver: "claudeAgent", displayName: "Quick fixture", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: engineDump },
      },
    },
    decider: { enabled: true, baseUrl: jevUrl, jobs: { modelRouting: true } },
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
      OMB_JEV_API_KEY: KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 30_000;
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
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await new Promise<void>((resolve) => (jev ? jev.close(() => resolve()) : resolve()));
  if (home) await removeTempDir(home);
});

type ThreadMessage = { id: string; kind: string; role: string; text?: string; routedBy?: { provider: string; probability: number; model?: string } };

describe("an easy message runs on the engine's lighter model", { timeout: 120_000 }, () => {
  let bot: { id: string; threadId: string };

  /** Send one message and wait for its reply; returns the reply and the argv
   * of the engine process the turn spawned, or null when it reused the idle
   * one (the fake records only a process's first prompt). A model change
   * always spawns: the model is part of the process's launch contract. */
  async function turn(text: string): Promise<{ reply: ThreadMessage; argv: string[] | null }> {
    rmSync(engineDump, { force: true });
    const before = new Set(((await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as ThreadMessage[]).map((m) => m.id));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
    let reply: ThreadMessage | undefined;
    await expect.poll(async () => {
      const messages = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as ThreadMessage[];
      reply = messages.find((m) => !before.has(m.id) && m.role === "bot" && m.kind === "text");
      return Boolean(reply);
    }, { timeout: 30_000, interval: 150 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id)?.busy, { timeout: 15_000 }).toBe(false);
    return { reply: reply!, argv: existsSync(engineDump) ? JSON.parse(readFileSync(engineDump, "utf8")).argv as string[] : null };
  }
  const modelOf = (argv: string[] | null) => argv?.[argv.indexOf("--model") + 1];

  it("creates a bot on a full model with an effort level", async () => {
    const created = await api("POST", "/api/bots", {
      name: "Maya", modelSelection: { instanceId: "quick", model: "claude-sonnet-5", effort: "high" }, requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    bot = created.body.bot;
  });

  it("an unsure answer keeps the bot's own model and effort, unmarked", async () => {
    script = { light: 0.6 };
    const { reply, argv } = await turn("Summarise the attached launch plan and list the risks.");
    expect(modelOf(argv)).toBe("claude-sonnet-5");
    expect(argv![argv!.indexOf("--effort") + 1]).toBe("high");
    expect(reply.routedBy).toBeUndefined();
    const request = scoreRequests.at(-1)!;
    expect(request.auth).toBe(`Bearer ${KEY}`);
    expect(request.body.questions.answer).toEqual({ type: "score", instructions: MODEL_ROUTING.instructions, criteria: [...MODEL_ROUTING.levels!] });
    // the bot's greeting is the conversation so far
    expect(request.body.state).toEqual({
      message: "Summarise the attached launch plan and list the risks.",
      recent_messages: [{ from: "Maya", text: expect.stringContaining("Maya") }],
    });
  });

  it("Light at 0.8 or above runs this turn on the lighter model, marks the reply and leaves the bot's selection alone", async () => {
    script = { light: 0.92 };
    const { reply, argv } = await turn("thanks! what's 2+2?");
    expect(modelOf(argv)).toBe("claude-haiku-4-5");
    expect(argv).not.toContain("--effort");
    // the same conversation continues on the lighter model
    expect(argv).toContain("--resume");
    expect(reply.routedBy).toEqual({ provider: "jev", probability: 0.92, model: "claude-haiku-4-5" });
    const state = scoreRequests.at(-1)!.body.state;
    expect(state.message).toBe("thanks! what's 2+2?");
    expect(state.recent_messages.map((line: { from: string }) => line.from)).toEqual(["Maya", "User", "Maya"]);
    expect(state.recent_messages[1].text).toBe("Summarise the attached launch plan and list the risks.");
    const saved = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(saved.modelSelection).toMatchObject({ model: "claude-sonnet-5", effort: "high" });
  });

  it("a failing decision model keeps the bot's own model", async () => {
    script = { status: 529 };
    const { reply, argv } = await turn("and 3+3?");
    expect(modelOf(argv)).toBe("claude-sonnet-5");
    expect(argv).toContain("--resume");
    expect(reply.routedBy).toBeUndefined();
  });

  it("with the job switched off, nothing is asked", async () => {
    expect((await api("PUT", "/api/config", { decider: { jobs: { modelRouting: false } } })).status).toBe(200);
    script = { light: 0.99 };
    const asked = scoreRequests.length;
    const { reply, argv } = await turn("hi again");
    // null: the idle process from the turn before, launched on the bot's model
    if (argv) expect(modelOf(argv)).toBe("claude-sonnet-5");
    expect(reply.routedBy).toBeUndefined();
    expect(scoreRequests.length).toBe(asked);
    expect(output).not.toContain(KEY);
  });
});
