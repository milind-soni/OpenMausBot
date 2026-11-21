// A box with room to spare and a cap of two idle engines: Claude's per-thread processes and Codex's kept app-servers count
// together, the least recently used close first, and a thread with a turn running is never closed.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexConnection, codexWarmSessions } from "./codex-warm.ts";
import { warmEngineKeys } from "./session-idle.ts";

const GB = 1024 ** 3;
vi.mock("../box-memory.ts", async (original) => ({
  ...await original<typeof import("../box-memory.ts")>(),
  boxMemory: () => ({ bytes: 16 * GB, cgroupLimit: null }),
  availableMemory: () => 12 * GB,
}));

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "testing", "fake-claude-cli.ts");

let scratch: string, instance: ProviderInstance, recorder: EventRecorder;
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLAUDE, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "omb-idle-cap-"));
  vi.stubEnv("OMB_IDLE_ENGINES_MAX", "2");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  recorder.stop();
  await instance.dispose();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await removeTempDir(scratch);
});

const closedIdle = (threadId: string) => {
  try { return readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").includes('"close":"idle"'); } catch { return false; }
};
const completed = (turnId: string) => recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
const turn = async (threadId: string) => completed((await instance.adapter.sendTurn({ threadId, text: "go" })).turnId);
const startClaude = async () => {
  instance = await ClaudeDriver.create({ instanceId: `cap-claude-${randomUUID()}`, displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } });
  recorder = recordEvents(instance.adapter);
};
const codexProcess = () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout); setInterval(() => {}, 1000);"], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return new CodexConnection(child);
};

it("keeps the two most recently used of five idle engines across Claude and Codex, the three oldest closing", async () => {
  await startClaude();
  const claudeThreads = [randomUUID(), randomUUID(), randomUUID()];
  for (const threadId of claudeThreads) await turn(threadId);
  await expect.poll(() => claudeThreads.map(closedIdle), { timeout: 10_000 }).toEqual([true, false, false]);

  const codex = codexWarmSessions<null>(`cap-codex-${randomUUID()}`);
  const codexThreads = [randomUUID(), randomUUID()];
  const kept = codexThreads.map((threadId) => {
    const session = { connection: codexProcess(), contract: "{}", nativeThreadId: `native-${threadId}`, configDigest: "config", cwd: "/work", carried: null };
    expect(codex.keep(threadId, session)).toBe(true);
    return session;
  });
  await expect.poll(() => claudeThreads.map(closedIdle), { timeout: 10_000 }).toEqual([true, true, true]);
  expect(codexThreads.map((threadId) => codex.has(threadId))).toEqual([true, true]);
  expect(kept.map((session) => session.connection.alive)).toEqual([true, true]);
  expect(warmEngineKeys()).toHaveLength(2);
  await codex.closeAll("test over");
}, 30_000);

it("never closes a thread whose turn is running, and counts it once its turn ends", async () => {
  const release = join(scratch, "release");
  vi.stubEnv("FAKE_CLAUDE_MODE", "hang");
  vi.stubEnv("FAKE_CLAUDE_RELEASE", release);
  await startClaude();
  const busy = randomUUID();
  const { turnId: busyTurn } = await instance.adapter.sendTurn({ threadId: busy, text: "go" });
  await recorder.until((event) => event.type === "session.started" && event.threadId === busy);
  vi.stubEnv("FAKE_CLAUDE_MODE", "happy");

  const others = [randomUUID(), randomUUID(), randomUUID()];
  for (const threadId of others) await turn(threadId);
  await expect.poll(() => others.map(closedIdle), { timeout: 10_000 }).toEqual([true, false, false]);
  expect(closedIdle(busy)).toBe(false);

  writeFileSync(release, "");
  await completed(busyTurn);
  await expect.poll(() => closedIdle(others[1]!), { timeout: 10_000 }).toBe(true);
  expect([closedIdle(busy), closedIdle(others[2]!)]).toEqual([false, false]);
}, 30_000);
