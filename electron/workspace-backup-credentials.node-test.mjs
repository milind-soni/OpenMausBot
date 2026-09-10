import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import {
  createWorkspaceBackupCredentialBridge,
  workspaceBackupCredentials,
  workspaceBackupEnvironment,
  WORKSPACE_BACKUP_REQUEST,
  WORKSPACE_BACKUP_RESULT,
} from "./workspace-backup-credentials.mjs";
import { readDesktopBackupCredentials, restoreDesktopBackupCredentials, prepareWorkspaceBackupCredentials, loadWorkspaceBackupCredentials } from "../server/workspace-backup-desktop.ts";

function fixture(initial = {}, options = {}) {
  const replies = [];
  const writes = [];
  const proc = { postMessage: (message) => replies.push(message) };
  let current = proc;
  const state = createSecureCredentialState(initial, async (next) => {
    writes.push(next);
    await options.persist?.(next, writes.length);
  });
  const receive = createWorkspaceBackupCredentialBridge({
    isCurrent: (candidate) => candidate === current,
    available: () => options.available !== false,
    read: () => state.read(),
    update: (...args) => state.update(...args),
    brokerUrl: () => "https://broker.example",
    ...options.bridge,
  });
  return { proc, state, writes, replies, receive, disconnect: () => { current = null; } };
}
const request = (operation, credentials) => ({ type: WORKSPACE_BACKUP_REQUEST, requestId: "test-id", operation, credentials });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("workspace snapshots include only bounded string secrets and connection identity", () => {
  const input = {
    xaiApiKey: "fixture-key", composioBrokerToken: "f".repeat(64), composioInstallationId: "fixture-installation",
    companionToken: "excluded", phoneSecretIdentity: { privateKey: "excluded" }, origins: ["excluded"], cookies: "excluded",
  };
  assert.deepEqual(workspaceBackupCredentials(input), {
    xaiApiKey: "fixture-key", composioBrokerToken: "f".repeat(64), composioInstallationId: "fixture-installation",
  });
  for (const invalid of [null, [], { cookies: "no" }, { xaiApiKey: {} }, { xaiApiKey: "a".repeat(16_385) }]) {
    assert.throws(() => workspaceBackupCredentials(invalid, true));
  }
  assert.deepEqual(workspaceBackupEnvironment({ xaiApiKey: "", boxToken: "new" }, ""), { XAI_API_KEY: "", BOX_TOKEN: "new" });
  assert.throws(() => workspaceBackupEnvironment({ composioBrokerUrl: "https://different.example" }, "https://original.example"));
});

test("only the current utility child can read, and unavailable stores fail closed", async () => {
  const f = fixture({ boxToken: "fixture-secret", desktopAccount: "excluded" });
  assert.equal(f.receive(f.proc, { type: "unrelated" }), false);
  f.receive({ postMessage: () => assert.fail("foreign child received secrets") }, request("read"));
  f.receive(f.proc, request("read"));
  await settle();
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].credentials.boxToken, "fixture-secret");
  assert.equal(f.replies[0].credentials.xaiApiKey, "");
  assert.equal(f.replies[0].credentials.desktopAccount, undefined);
  const unavailable = fixture({}, { available: false });
  unavailable.receive(unavailable.proc, request("read"));
  await settle();
  assert.equal(unavailable.replies[0].ok, false);
  assert.equal(unavailable.writes.length, 0);
});

test("restore patches supplied keys through the shared queue, preserving concurrent unrelated saves", async () => {
  const f = fixture({ boxToken: "old", desktopAccount: "keep", ttsKey: "untouched" });
  f.receive(f.proc, request("restore", { boxToken: "new" }));
  await f.state.update((current) => ({ ...current, desktopAccount: "concurrent" }));
  await settle();
  assert.deepEqual(f.state.read(), { boxToken: "new", desktopAccount: "concurrent", ttsKey: "untouched" });
  assert.equal(f.replies[0].ok, true);
  assert.deepEqual(f.replies[0].environment, { BOX_TOKEN: "new" });
});

test("a failed private reply rolls the durable store back without exposing its error", async () => {
  const f = fixture({ boxToken: "old", desktopAccount: "keep" });
  f.proc.postMessage = (reply) => {
    if (reply.ok) throw new Error("fixture-secret must never escape");
    f.replies.push(reply);
  };
  f.receive(f.proc, request("restore", { boxToken: "new" }));
  await settle();
  assert.deepEqual(f.writes, [{ boxToken: "new", desktopAccount: "keep" }, { boxToken: "old", desktopAccount: "keep" }]);
  assert.equal(f.state.read().boxToken, "old");
  assert.equal(f.replies[0].ok, false);
  assert.doesNotMatch(JSON.stringify(f.replies), /fixture-secret/);
});

test("child replacement during persistence rolls back and never sends credentials to its successor", async () => {
  const f = fixture({ boxToken: "old" }, { persist: (_next, count) => { if (count === 1) f.disconnect(); } });
  f.receive(f.proc, request("restore", { boxToken: "new" }));
  await settle();
  assert.deepEqual(f.writes, [{ boxToken: "new" }, { boxToken: "old" }]);
  assert.equal(f.replies.length, 0);
});

test("a queued restore expires before it can change the store", async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const f = fixture({ boxToken: "old" }, { bridge: { timeoutMs: 5 } });
  const concurrent = f.state.update(async (current) => { await gate; return current; });
  f.receive(f.proc, request("restore", { boxToken: "new" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  unblock();
  await concurrent;
  await settle();
  assert.equal(f.state.read().boxToken, "old");
  assert.equal(f.replies[0].ok, false);
});

test("real server helper exchanges secrets solely through the fake private parent port", async () => {
  const previousPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  const previousEnv = { ...process.env };
  const dataDir = mkdtempSync(join(tmpdir(), "omb-backup-credentials-"));
  process.env.OMB_DATA_DIR = dataDir;
  for (const key of Object.keys(workspaceBackupEnvironment({ boxToken: "", composioBrokerToken: "" }, ""))) delete process.env[key];
  const f = fixture({ boxToken: "fixture-old", desktopAccount: "keep" });
  const port = new EventEmitter();
  port.postMessage = (message) => f.receive(f.proc, message);
  f.proc.postMessage = (data) => {
    port.emit("message", { data: { type: WORKSPACE_BACKUP_RESULT, requestId: "wrong-id", ok: true, credentials: {} } });
    port.emit("message", { data });
  };
  Object.defineProperty(process, "parentPort", { value: port, configurable: true });
  try {
    const prior = await readDesktopBackupCredentials();
    assert.equal(prior.boxToken, "fixture-old");
    await f.state.update((current) => ({ ...current, composioBrokerToken: "c".repeat(64) }));
    process.env.OMB_COMPOSIO_BROKER_TOKEN = "d".repeat(64);
    assert.equal((await readDesktopBackupCredentials()).composioBrokerToken, "c".repeat(64));
    await restoreDesktopBackupCredentials({ boxToken: "fixture-new", composioBrokerToken: "a".repeat(64), composioInstallationId: "fixture" });
    assert.equal(process.env.BOX_TOKEN, "fixture-new");
    assert.equal(process.env.OMB_COMPOSIO_BROKER_URL, "https://broker.example");
    await restoreDesktopBackupCredentials(prior);
    assert.equal(f.state.read().composioBrokerToken, "");
    assert.equal(process.env.OMB_COMPOSIO_BROKER_TOKEN, "");
    assert.equal(f.state.read().desktopAccount, "keep");
    assert.equal(port.listenerCount("message"), 0);
  } finally {
    if (previousPort) Object.defineProperty(process, "parentPort", previousPort);
    else delete process.parentPort;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnv, key)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("headless restore survives restart, includes env-only keys, and later desktop migration removes plaintext only after saving", async () => {
  const previousPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  const previousEnv = { ...process.env };
  const dataDir = mkdtempSync(join(tmpdir(), "omb-backup-portability-"));
  Object.defineProperty(process, "parentPort", { value: undefined, configurable: true });
  process.env.OMB_DATA_DIR = dataDir;
  delete process.env.OMB_DESKTOP_PARENT;
  const incoming = { xaiApiKey: "fixture-key", anthropicApiKey: "fixture-anthropic", composioBrokerToken: "b".repeat(64), composioInstallationId: "fixture-id", composioBrokerUrl: "https://custom.example" };
  try {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ profile: { name: "Keep" }, tts: { voiceId: "kept", key: "fixture-voice" } }));
    process.env.OPENAI_COMPAT_API_KEY = "fixture-env-only";
    assert.equal((await readDesktopBackupCredentials()).openaiCompatApiKey, "fixture-env-only");
    await prepareWorkspaceBackupCredentials(dataDir, incoming);
    assert.equal(process.env.XAI_API_KEY, "fixture-key");
    assert.equal(process.env.OMB_COMPOSIO_BROKER_URL, "https://custom.example");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).profile.name, "Keep");
    if (process.platform !== "win32") assert.equal(statSync(join(dataDir, "workspace-credentials.json")).mode & 0o777, 0o600);
    for (const key of Object.keys(workspaceBackupEnvironment(incoming, ""))) delete process.env[key];
    await loadWorkspaceBackupCredentials(dataDir);
    assert.equal(process.env.OMB_ANTHROPIC_API_KEY, "fixture-anthropic");
    assert.equal((await readDesktopBackupCredentials()).composioInstallationId, "fixture-id");

    const f = fixture({ desktopAccount: "keep" }, { available: false });
    const port = new EventEmitter();
    port.postMessage = (message) => f.receive(f.proc, message);
    f.proc.postMessage = (data) => port.emit("message", { data });
    Object.defineProperty(process, "parentPort", { value: port, configurable: true });
    await assert.rejects(loadWorkspaceBackupCredentials(dataDir));
    assert.equal(existsSync(join(dataDir, "workspace-credentials.json")), true);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).xai.key, "fixture-key");
    const writable = fixture({ desktopAccount: "keep" });
    port.postMessage = (message) => writable.receive(writable.proc, message);
    writable.proc.postMessage = (data) => port.emit("message", { data });
    await loadWorkspaceBackupCredentials(dataDir);
    assert.equal(writable.state.read().xaiApiKey, "fixture-key");
    assert.equal(writable.state.read().desktopAccount, "keep");
    assert.equal(writable.state.read().anthropicApiKey, undefined);
    assert.equal(existsSync(join(dataDir, "workspace-credentials.json")), false);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).xai.key, undefined);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).tts.voiceId, "kept");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).anthropic.key, "fixture-anthropic");
  } finally {
    if (previousPort) Object.defineProperty(process, "parentPort", previousPort);
    else delete process.parentPort;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnv, key)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("server requests time out, remove private listeners, and bound concurrent requests", async (t) => {
  const previousPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  const previousDataDir = process.env.OMB_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "omb-backup-timeout-"));
  const port = new EventEmitter();
  port.postMessage = () => {};
  Object.defineProperty(process, "parentPort", { value: port, configurable: true });
  process.env.OMB_DATA_DIR = dataDir;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const requests = Array.from({ length: 4 }, () => readDesktopBackupCredentials());
    await assert.rejects(readDesktopBackupCredentials());
    assert.equal(port.listenerCount("message"), 4);
    const results = Promise.all(requests.map((pending) => assert.rejects(pending)));
    t.mock.timers.tick(20_000);
    await results;
    assert.equal(port.listenerCount("message"), 0);
  } finally {
    t.mock.timers.reset();
    if (previousPort) Object.defineProperty(process, "parentPort", previousPort);
    else delete process.parentPort;
    if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
    else process.env.OMB_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("desktop boot re-sends private initialization only after this child's health handshake", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /if \(identity\.outcome === "ready"\) \{\s*(?:\/\/[^\n]*\n\s*)*syncDesktopMutationToken\(proc\);\s*syncPhoneSecretKey\(proc\);\s*return \{ proc \};/);
});
