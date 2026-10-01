import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fake = join(root, "server", "testing", "fake-codex-app-server.ts");
const port = 18800 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;
let home: string;
let child: ChildProcess;
let stderr = "";

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() as any };
};
const start = async () => {
  child = spawn(process.execPath, [join(root, "server", "index.ts")], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, OMB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  stderr = "";
  child.stderr!.on("data", (data) => { stderr += data; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server failed: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

beforeAll(async () => {
  chmodSync(fake, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-codex-review-"));
  mkdirSync(join(home, ".openmausbot"));
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances: {
    codex: { driver: "codex", environment: {
      FAKE_CODEX_MODE: "review-events",
      FAKE_CODEX_DUMP: join(home, "codex-dump.json"),
      FAKE_CODEX_REVIEW_ONCE_FILE: join(home, "review-once"),
      FAKE_CODEX_REVIEW_EVENTS: JSON.stringify([
      { method: "guardianWarning", params: { threadId: "codex-thread-1", message: "Automatic approval review timed out." } },
      { method: "item/autoApprovalReview/completed", params: {
        threadId: "codex-thread-1", turnId: "turn-1", reviewId: "review-1", review: { status: "timedOut" },
        action: { type: "command", command: "git status --short" },
      } },
    ]) }, config: { cli: fake, fullAuto: false } },
  } }));
  await start();
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("persists one visible review timeout while reply completes", async () => {
  const created = (await api("POST", "/api/bots")).body.bot;
  expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model: "fake-model" } })).status).toBe(200);
  expect((await api("PATCH", `/api/bots/${created.id}/tasks/${created.threadId}`, { approvalMode: "auto" })).status).toBe(200);
  expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "check status" })).status).toBe(202);
  const read = async () => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === created.id);
  const deadline = Date.now() + 20_000;
  let bot: any;
  while (Date.now() <= deadline) {
    bot = await read();
    if (!bot.busy && bot.messages.some((message: any) => message.kind === "text" && message.role === "bot")) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (bot.busy) throw new Error(`turn did not settle: ${stderr.slice(-2000)}`);
  const notices = bot.messages.filter((message: any) => message.tool?.name?.startsWith("error: Codex automatic review"));
  expect(notices).toHaveLength(1);
  expect(notices[0].tool.name).toContain("git status --short");
  expect(notices[0].tool.name).toContain("Retry stays Auto");
  expect(bot.messages.some((message: any) => message.kind === "text" && message.text === "done from fake codex")).toBe(true);
  const nativeTurn = () => JSON.parse(readFileSync(join(home, "codex-dump.json"), "utf8")).calls.find((call: any) => call.method === "turn/start");
  expect(nativeTurn().params.approvalsReviewer).toBe("auto_review");
  await waitForExit(child, { signal: "SIGTERM" });
  await start();
  expect((await read()).messages.filter((message: any) => message.tool?.name?.startsWith("error: Codex automatic review"))).toHaveLength(1);
  expect((await api("PATCH", `/api/bots/${created.id}/tasks/${created.threadId}`, { approvalMode: "ask" })).status).toBe(200);
  expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "try with Ask" })).status).toBe(202);
  const retryDeadline = Date.now() + 20_000;
  while (Date.now() <= retryDeadline) {
    bot = await read();
    if (!bot.busy && bot.messages.filter((message: any) => message.kind === "text" && message.text === "done from fake codex").length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  expect(bot.messages.filter((message: any) => message.kind === "text" && message.text === "done from fake codex")).toHaveLength(2);
  expect(bot.messages.filter((message: any) => message.tool?.name?.startsWith("error: Codex automatic review"))).toHaveLength(1);
  expect(nativeTurn().params.approvalsReviewer).toBe("user");
}, 40_000);
