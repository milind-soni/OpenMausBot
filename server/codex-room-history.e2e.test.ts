// The Codex and ChatGPT apps list every saved Codex thread as the person's history. A room turn sends the whole room
// conversation and never resumes its thread, so each message would leave one more saved thread there: room turns start
// ephemeral threads. A one-to-one chat keeps one saved thread and resumes it.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fake = join(root, "server", "testing", "fake-codex-app-server.ts");
const port = workerPort(19800, 10_000);
const base = `http://127.0.0.1:${port}`;
let home: string;
let callLog: string;
let child: ChildProcess;
let stderr = "";

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() as any };
};

const calls = (): Array<{ method: string; params: Record<string, unknown> | null }> => existsSync(callLog)
  ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function until(done: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() <= deadline) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${what} did not happen: ${stderr.slice(-2000)}`);
}

beforeAll(async () => {
  chmodSync(fake, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-codex-room-history-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir);
  callLog = join(home, "codex-calls.jsonl");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    codex: { driver: "codex", environment: { FAKE_CODEX_MODE: "resume", FAKE_CODEX_CALL_LOG: callLog }, config: { cli: fake, fullAuto: false } },
  } }));
  child = spawn(process.execPath, [join(root, "server", "index.ts")], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, CODEX_HOME: join(home, ".codex"), OMB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (data) => { stderr += data; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr.slice(-2000)}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, "server start");
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("keeps room turns out of Codex's saved history and a one-to-one chat in one saved thread", async () => {
  const created = (await api("POST", "/api/bots")).body.bot;
  expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model: "fake-model" } })).status).toBe(200);
  const bot = async () => (await api("GET", "/api/bots")).body.bots.find((item: any) => item.id === created.id);
  const replies = (messages: any[]) => messages.filter((message) => message.kind === "text" && message.text === "done from fake codex").length;

  for (const [n, text] of ["first chat message", "second chat message"].entries()) {
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text })).status).toBe(202);
    await until(async () => { const state = await bot(); return !state.busy && replies(state.messages) === n + 1; }, `chat reply ${n + 1}`);
  }
  // One saved thread, which the second message goes on in (from a kept app-server or by thread/resume).
  const chat = calls();
  expect(chat.filter((call) => call.method === "thread/start").map((call) => call.params?.ephemeral)).toEqual([false]);
  const chatThreads = chat.filter((call) => call.method === "turn/start").map((call) => call.params?.threadId);
  expect(chatThreads).toHaveLength(2);
  expect(new Set(chatThreads).size).toBe(1);

  const before = chat.length;
  const { group } = (await api("POST", "/api/groups", {
    name: "Planning room", memberIds: [created.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
  })).body;
  const roomReplies = async () => replies((await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages);
  for (const [n, text] of ["first room message", "second room message"].entries()) {
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text, threadId: group.threadId })).status).toBe(202);
    await until(async () => await roomReplies() === n + 1 && !(await bot()).busy, `room reply ${n + 1}`);
  }
  // Every room turn starts a thread Codex never writes down.
  const room = calls().slice(before);
  expect(room.filter((call) => call.method === "thread/resume")).toEqual([]);
  expect(room.filter((call) => call.method === "thread/start").map((call) => call.params?.ephemeral)).toEqual([true, true]);
}, 60_000);
