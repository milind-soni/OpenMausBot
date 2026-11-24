import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { EngineCompactResult, ProviderInstance } from "../contracts.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { loginAt, nativeFixture, type NativeFixture } from "../testing/antigravity-native-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { AntigravityDriver } from "./antigravity.ts";

const WINDOWS = process.platform === "win32";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-compact-"));
  scratch.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of instances.splice(0)) await instance.dispose();
  rmSync(join(antigravityRuntimesRoot(DATA_DIR), `${process.platform}-${process.arch}`), { recursive: true, force: true });
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

async function thread(name: string, env: Record<string, string> = {}) {
  ensureDirs();
  const fixture: NativeFixture = nativeFixture(folder());
  const instanceId = `antigravity-compact-${name}`;
  const instance = await AntigravityDriver.create({
    instanceId, displayName: "Antigravity", enabled: true, config: { cli: fixture.executable, fullAuto: false },
    environment: { FAKE_AGY_LOG: fixture.log, FAKE_AGY_USAGE: "1", ...env, FAKE_AGY_KEYRING: "" },
  });
  instances.push(instance);
  expect(await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code", { FAKE_AGY_KEYRING: "" })).toBe(0);
  let cursor: string | undefined;
  const send = async (text = "hello", model?: string) => {
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: name, text, approvalMode: "ask", cwd: fixture.directory, resumeCursor: cursor, ...(model ? { model } : {}) });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000);
    const started = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId) as { sessionId?: string } | undefined;
    recorder.stop();
    cursor = started?.sessionId ?? cursor;
    return done;
  };
  const compact = (options: { session?: string; signal?: AbortSignal } = {}): Promise<EngineCompactResult> =>
    instance.adapter.compactSession!(name, { session: options.session ?? cursor!, ...(options.signal ? { signal: options.signal } : {}) });
  const prompts = () => fixture.entries().filter((entry) => entry.method === "session/prompt").map((entry) => entry.prompt as string);
  const launches = () => new Set(fixture.entries().filter((entry) => entry.method === "session/prompt").map((entry) => entry.pid)).size;
  const methods = () => fixture.methods();
  const turnPids = () => new Set(fixture.entries().filter((entry) => entry.method === "session/prompt").map((entry) => entry.pid));
  const sessionSetups = () => fixture.entries().filter((entry) => turnPids().has(entry.pid) && (entry.method === "session/new" || entry.method === "session/resume")).map((entry) => entry.method as string);
  return { instance, send, compact, prompts, launches, methods, sessionSetups, cursor: () => cursor! };
}

describe.skipIf(WINDOWS)("Compact now on the native Antigravity CLI", () => {
  it("sends /compact alone to the live session, and the next turn goes on in the same session and process", async () => {
    const t = await thread("in-place");
    expect(await t.send("first", "fixture-base-model")).toMatchObject({ ok: true });
    const session = t.cursor();
    expect(await t.compact()).toEqual({ ok: true, usage: { input: expect.any(Number), output: 500, cachedInput: 0 }, model: "fixture-base-model" });
    expect(t.prompts()).toEqual(["first", "/compact"]);
    expect(await t.send("after")).toMatchObject({ ok: true });
    expect(t.cursor()).toBe(session);
    expect(t.launches()).toBe(1);
    expect(t.sessionSetups()).toEqual(["session/new"]);
  }, 120_000);

  it("starts nothing when no live session holds the conversation, or it holds another one", async () => {
    const t = await thread("no-live");
    expect(await t.compact({ session: "fixture-session-gone" })).toMatchObject({ ok: false, reason: "no live session holds this conversation" });
    expect(t.launches()).toBe(0);
    await t.send();
    expect(await t.compact({ session: "fixture-session-other" })).toMatchObject({ ok: false });
    expect(t.prompts()).not.toContain("/compact");
  }, 120_000);

  it("leaves a session alone whose CLI did not advertise /compact", async () => {
    const t = await thread("no-command", { FAKE_AGY_COMMANDS: "goal,plan" });
    await t.send();
    expect(await t.compact()).toMatchObject({ ok: false, reason: "the session does not offer /compact" });
    expect(t.prompts()).not.toContain("/compact");
  }, 120_000);

  it("counts a /compact the CLI answered as a message as no compaction, books what it reported and closes the session", async () => {
    const t = await thread("as-message", { FAKE_AGY_COMPACT: "reply" });
    await t.send();
    expect(await t.compact()).toMatchObject({ ok: false, reason: "the agent answered /compact as a message", usage: { output: 777 }, sessionChanged: true });
    expect(await t.compact()).toMatchObject({ ok: false, reason: "no live session holds this conversation" });
  }, 120_000);

  for (const [how, why] of [
    ["bare", "the agent reported no compaction"],
    ["usage-only", "the agent reported no compaction"],
    ["usage-after", "the agent reported no compaction"],
    ["error", "compaction failed"],
  ] as const) {
    it(`counts a /compact answered ${how} as no compaction and closes the session`, async () => {
      const t = await thread(`answer-${how}`, { FAKE_AGY_COMPACT: how });
      await t.send();
      const result = await t.compact();
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(why) });
      expect(await t.compact()).toMatchObject({ ok: false, reason: "no live session holds this conversation" });
    }, 120_000);
  }

  it("ends at once when the CLI exits during the compaction", async () => {
    const t = await thread("exits", { FAKE_AGY_COMPACT: "exit" });
    await t.send();
    const started = Date.now();
    expect(await t.compact()).toMatchObject({ ok: false, reason: "the agent exited during compaction" });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 120_000);

  it("cancels on Stop and keeps the session the CLI confirms it stopped", async () => {
    const t = await thread("stop-confirmed", { FAKE_AGY_COMPACT: "hang" });
    await t.send();
    const stop = new AbortController();
    const compacting = t.compact({ signal: stop.signal });
    await vi.waitFor(() => expect(t.prompts()).toContain("/compact"), { timeout: 10_000 });
    stop.abort();
    expect(await compacting).toMatchObject({ ok: false, reason: "stopped" });
    expect(t.methods()).toContain("session/cancel");
    expect(await t.send("after")).toMatchObject({ ok: true });
    expect(t.launches()).toBe(1);
  }, 120_000);

  it("stops a CLI that ignores the cancel before the next turn starts another", async () => {
    const t = await thread("stop-ignored", { FAKE_AGY_COMPACT: "hang-ignore-cancel" });
    await t.send();
    const stop = new AbortController();
    const compacting = t.compact({ signal: stop.signal });
    await vi.waitFor(() => expect(t.prompts()).toContain("/compact"), { timeout: 10_000 });
    stop.abort();
    expect(await compacting).toMatchObject({ ok: false, reason: "stopped" });
    expect(await t.send("after")).toMatchObject({ ok: true });
    expect(t.launches()).toBe(2);
    expect(t.sessionSetups()).toEqual(["session/new", "session/resume"]);
  }, 120_000);

  it("gives up after its timeout, taking the cancelled answer the CLI sends then", async () => {
    vi.stubEnv("FAKE_ACP_COMPACT_TIMEOUT_MS", "500");
    const t = await thread("timeout", { FAKE_AGY_COMPACT: "hang" });
    await t.send();
    expect(await t.compact()).toMatchObject({ ok: false, reason: "timed out" });
    expect(t.methods()).toContain("session/cancel");
    expect(await t.compact()).toMatchObject({ ok: false, reason: "no live session holds this conversation" });
  }, 120_000);
});
