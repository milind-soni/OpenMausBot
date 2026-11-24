import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { loginAt, nativeFixture, type NativeFixture } from "../testing/antigravity-native-fixture.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { AntigravityDriver } from "./antigravity.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const WINDOWS = process.platform === "win32";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-auto-compact-"));
  scratch.push(directory);
  return directory;
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  rmSync(join(antigravityRuntimesRoot(DATA_DIR), `${process.platform}-${process.arch}`), { recursive: true, force: true });
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

/** An error step in the session's own log, as the native CLI writes for a turn whose model call failed upstream. */
function writeErrorStep(profileDirectory: string, sessionId: string, payload: string): void {
  const conversations = join(profileDirectory, "antigravity-acp", "conversations");
  mkdirSync(conversations, { recursive: true });
  const database = new DatabaseSync(join(conversations, `${sessionId}.db`));
  try {
    database.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)");
    database.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (1, 17, ?)").run(Buffer.from(payload));
  } finally {
    database.close();
  }
}

interface Running {
  recorder: EventRecorder;
  turnId: string;
}

async function thread(name: string, env: Record<string, string> | ((fixtureFolder: string) => Record<string, string>) = {}) {
  ensureDirs();
  const directory = folder();
  const fixture: NativeFixture = nativeFixture(directory);
  const envFor = typeof env === "function" ? env(directory) : env;
  const instanceId = `antigravity-auto-compact-${name}`;
  const instance = await AntigravityDriver.create({
    instanceId, displayName: "Antigravity", enabled: true, config: { cli: fixture.executable, fullAuto: false },
    environment: { FAKE_AGY_LOG: fixture.log, FAKE_AGY_USAGE: "1", ...envFor, FAKE_AGY_KEYRING: "" },
  });
  instances.push(instance);
  expect(await loginAt(fixture, antigravityProfileDirectory(instanceId), "fixture-code", { FAKE_AGY_KEYRING: "" })).toBe(0);
  let cursor: string | undefined;
  const begin = async (text = "hello", model?: string) => {
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: name, text, approvalMode: "ask", cwd: fixture.directory, resumeCursor: cursor, ...(model ? { model } : {}) });
    return { recorder, turnId } satisfies Running;
  };
  const finish = async (running: Running) => {
    const done = await running.recorder.until((event) => event.type === "turn.completed" && event.turnId === running.turnId, 30_000);
    const started = running.recorder.events.find((event) => event.type === "session.started" && event.turnId === running.turnId) as { sessionId?: string } | undefined;
    cursor = started?.sessionId ?? cursor;
    running.recorder.stop();
    return done;
  };
  const send = async (text = "hello", model?: string) => {
    const running = await begin(text, model);
    const done = await finish(running);
    return { done, events: [...running.recorder.events] };
  };
  const sessionOf = (running: Running) =>
    (running.recorder.events.find((event) => event.type === "session.started" && event.turnId === running.turnId) as { sessionId?: string })?.sessionId;
  return { instance, send, begin, finish, sessionOf, fixture, profile: antigravityProfileDirectory(instanceId), cursor: () => cursor! };
}

const compacted = (events: Array<{ type: string }>) => events.filter((event) => event.type === "context.compacted");

describe.skipIf(WINDOWS)("the native Antigravity CLI compacting a turn's session at its start", () => {
  it("says so once, ahead of the turn's reply", async () => {
    const t = await thread("plain", { FAKE_AGY_AUTO_COMPACT: "1" });
    const { done, events } = await t.send();
    expect(done).toMatchObject({ ok: true, stopReason: null });
    expect(compacted(events)).toHaveLength(1);
    const noticeAt = events.findIndex((event) => event.type === "context.compacted");
    const replyAt = events.findIndex((event) => event.type === "item.completed" && event.itemType === "assistant_text");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(replyAt).toBeGreaterThan(noticeAt);
  }, 120_000);

  it.each(["window", "model"])("does not say so when the collapse is followed by a reading that cannot be compared (%s)", async (then) => {
    const t = await thread(`blind-${then}`, { FAKE_AGY_AUTO_COMPACT: "1", FAKE_AGY_AUTO_COMPACT_THEN: then });
    const { done, events } = await t.send();
    expect(done).toMatchObject({ ok: true, stopReason: null });
    expect(compacted(events)).toHaveLength(0);
  }, 120_000);

  it.each([
    { second: "fixture-account-model", notices: 1 },
    { second: "fixture-base-model", notices: 1 },
  ])("says so for a turn that collapsed on $second after a first turn on fixture-base-model, a switch before the prompt included", async ({ second, notices }) => {
    const t = await thread(`model-${second}`, { FAKE_AGY_AUTO_COMPACT: "1", FAKE_AGY_AUTO_COMPACT_AT: "10000" });
    const first = await t.send("first", "fixture-base-model");
    expect(first.done).toMatchObject({ ok: true });
    expect(compacted(first.events)).toHaveLength(0);
    const { done, events } = await t.send("second", second);
    expect(done).toMatchObject({ ok: true, stopReason: null });
    expect(compacted(events)).toHaveLength(notices);
  }, 120_000);

  it("does not say so when the CLI failed the prompt after its reply", async () => {
    const t = await thread("prompt-error", { FAKE_AGY_AUTO_COMPACT: "1", FAKE_AGY_PROMPT_ERROR: "1" });
    const { done, events } = await t.send();
    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(compacted(events)).toHaveLength(0);
  }, 120_000);

  it("does not say so for a turn the person stopped after its reply", async () => {
    let gate = "";
    const t = await thread("stopped", (dir) => { gate = join(dir, "answer-gate"); return { FAKE_AGY_AUTO_COMPACT: "1", FAKE_AGY_ANSWER_GATE: gate }; });
    const running = await t.begin();
    await running.recorder.until((event) => event.type === "content.delta" && event.streamKind === "assistant_text", 30_000);
    await t.instance.adapter.interruptTurn("stopped");
    const done = await t.finish(running);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(compacted(running.recorder.events)).toHaveLength(0);
  }, 120_000);

  it("does not say so when the CLI's own log says the turn failed upstream after its answer", async () => {
    let gate = "";
    const t = await thread("outcome-failed", (dir) => { gate = join(dir, "answer-gate"); return { FAKE_AGY_AUTO_COMPACT: "1", FAKE_AGY_ANSWER_GATE: gate }; });
    mkdirSync(join(t.profile, "antigravity-acp", "conversations"), { recursive: true });
    const running = await t.begin();
    await running.recorder.until((event) => event.type === "content.delta" && event.streamKind === "assistant_text", 30_000);
    writeErrorStep(t.profile, t.sessionOf(running)!, "Error 503, Message: upstream unavailable, Status: UNAVAILABLE");
    writeFileSync(gate, "");
    const done = await t.finish(running);
    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(compacted(running.recorder.events)).toHaveLength(0);
  }, 120_000);

  const SETTLEMENTS = [
    { flow: "system-only", ok: false, stopReason: "empty_turn" },
    { flow: "tool-done", ok: true, stopReason: null },
    { flow: "tool-system", ok: false, stopReason: "ended_after_tools" },
  ] as const;

  it.each(SETTLEMENTS)("settles a compacted turn shaped $flow exactly as always, with the notice only on its success", async ({ flow, ok, stopReason }) => {
    const t = await thread(`settled-${flow}`, { FAKE_AGY_AUTO_COMPACT: "1", FAKE_AGY_FLOW: flow });
    const { done, events } = await t.send();
    expect(done).toMatchObject({ ok, stopReason });
    expect(compacted(events)).toHaveLength(ok ? 1 : 0);
    if (ok) {
      const replies = events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text");
      expect(replies.map((event) => event.text)).toEqual(["fixture reply", "Done."]);
      expect(events.findIndex((event) => event.type === "context.compacted")).toBeLessThan(events.indexOf(replies.at(-1)!));
    }
  }, 120_000);

  it.each(SETTLEMENTS)("settles the same $flow turn with no collapse exactly as before, and never says so", async ({ flow, ok, stopReason }) => {
    const t = await thread(`unsettled-${flow}`, { FAKE_AGY_FLOW: flow });
    const { done, events } = await t.send();
    expect(done).toMatchObject({ ok, stopReason });
    expect(compacted(events)).toHaveLength(0);
  }, 120_000);
  it("does not say so on the pinned runtime, which has no /compact of its own, though its usage collapsed", async () => {
    ensureDirs();
    const directory = folder();
    const executable = join(directory, "agy_acp_server");
    const harness = join(directory, "localharness_external");
    writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP}" "$@"\n`, { mode: 0o755 });
    copyFileSync(executable, harness);
    chmodSync(harness, 0o755);
    const usageFile = join(directory, "usage.json");
    writeFileSync(usageFile, JSON.stringify([120_000, 40_000]));
    const instanceId = "antigravity-auto-compact-pinned";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "acp_token.json"), "{}", { mode: 0o600 });
    const instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true, config: { cli: executable, fullAuto: false },
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_USAGE_UPDATES_FILE: usageFile, TEMP: directory, TMP: directory },
    });
    instances.push(instance);
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "pinned", text: "hello", approvalMode: "ask", cwd: directory });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 30_000);
    recorder.stop();
    expect(done).toMatchObject({ ok: true, stopReason: null });
    const contexts = recorder.events.flatMap((event) => event.type === "thread.token-usage.updated" && event.contextTokens !== undefined ? [event.contextTokens] : []);
    expect(contexts).toEqual([120_000, 40_000]);
    expect(compacted(recorder.events)).toHaveLength(0);
  }, 120_000);
});
