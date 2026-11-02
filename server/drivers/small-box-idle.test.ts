// Two conversations on a small box with little memory free: the one idle longest gives back its engine as soon as the
// other goes idle, and its next turn resumes by session id.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { ClaudeDriver } from "./claude.ts";

const GB = 1024 ** 3;
vi.mock("../box-memory.ts", async (original) => ({
  ...await original<typeof import("../box-memory.ts")>(),
  boxMemory: () => ({ bytes: GB, cgroupLimit: null }),
  availableMemory: () => 0.2 * GB,
}));

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(here, "..", "testing", "fake-acp-cli.ts");

let scratch: string, instance: ProviderInstance, recorder: EventRecorder;

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "omb-small-box-"));
});
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_DUMP;
  recorder.stop();
  await instance.dispose();
  await removeTempDir(scratch);
});

const threads = () => [randomUUID(), randomUUID()];
const closedIdle = (threadId: string) => {
  try { return readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").includes('"close":"idle"'); } catch { return false; }
};
const turn = async (threadId: string, resumeCursor?: string) => {
  const { turnId } = await instance.adapter.sendTurn({ threadId, text: "go", ...(resumeCursor ? { resumeCursor } : {}) });
  await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
};

it("closes Claude's longest-idle engine when a second goes idle, and resumes it on the next turn", async () => {
  instance = await ClaudeDriver.create({ instanceId: "small-claude", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } });
  recorder = recordEvents(instance.adapter);
  const [first, second] = threads();
  await turn(first!);
  expect(closedIdle(first!)).toBe(false);
  await turn(second!);
  await expect.poll(() => closedIdle(first!), { timeout: 10_000 }).toBe(true);
  expect(closedIdle(second!)).toBe(false);

  const started = recorder.events.find((event) => event.type === "session.started" && event.threadId === first) as { sessionId: string };
  process.env.FAKE_CLAUDE_DUMP = join(scratch, "resumed.json");
  await turn(first!, started.sessionId);
  expect(JSON.parse(readFileSync(join(scratch, "resumed.json"), "utf8")).argv).toContain("--resume");
  await expect.poll(() => closedIdle(second!), { timeout: 10_000 }).toBe(true);
}, 30_000);

it("closes an ACP engine's longest-idle session when a second goes idle", async () => {
  instance = await GrokAgentDriver.create({ instanceId: "small-acp", displayName: "Grok", environment: {}, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const [first, second] = threads();
  await turn(first!);
  expect(closedIdle(first!)).toBe(false);
  await turn(second!);
  await expect.poll(() => closedIdle(first!), { timeout: 10_000 }).toBe(true);
  expect(closedIdle(second!)).toBe(false);
}, 30_000);
