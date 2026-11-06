import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, type FakeHighLevel } from "../testing/fake-highlevel.ts";
import { highlevelAccess, type HighLevelBot } from "./access.ts";
import { BUDGET_CALLS, HighLevelClient, type HighLevelClientOptions } from "./client.ts";
import { highlevelRpc, type HighLevelRpcDeps } from "./rpc.ts";
import { HighLevelStore } from "./store.ts";
import type { HighLevelWriteRecord } from "./tools.ts";

let hl: FakeHighLevel;
const dirs: string[] = [];
beforeAll(async () => { hl = await startFakeHighLevel(); hl.tokens.add("hl_access_seed"); });
beforeEach(() => { hl.calls.length = 0; hl.overrides.length = 0; });
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
afterAll(async () => { await hl.close(); });

const call = (name: string, args: unknown) => ({ method: "tools/call", params: { name, arguments: args } });
const note = call("HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "Fixture note" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(options: Pick<HighLevelClientOptions, "fetch" | "refresh"> = { refresh: null }) {
  const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-cancel-"));
  dirs.push(dir);
  const store = new HighLevelStore({ dataDir: dir });
  store.put({ kind: "token", accessToken: "hl_access_seed", locationId: FAKE_LOCATION_ID, scopes: "" });
  const waiting = deferred<number>();
  const resume = deferred<void>();
  let now = Date.now();
  const client = new HighLevelClient({ store, ...options, apiUrl: hl.url, now: () => now, sleep: async (ms) => {
    waiting.resolve(ms);
    await resume.promise;
    now += ms;
  } });
  const stopped = Object.assign(new Error("turn ended"), { status: 409 });
  let active = true;
  const bot: HighLevelBot = { id: "fixture", name: "Fixture", composio: true };
  const writes: HighLevelWriteRecord[] = [];
  const deps: HighLevelRpcDeps = {
    client, assertActive: () => { if (!active) throw stopped; }, authorize: (name) => highlevelAccess(bot, name),
    onWrite: (record) => { writes.push(record); },
  };
  return { client, store, bot, deps, writes, waiting: waiting.promise, resume: resume.resolve, stop: () => { active = false; }, stopped };
}

it.each(["429", "5xx", "budget"])("sends no request after Stop during a %s wait", async (wait) => {
  const h = harness();
  const request = wait === "5xx" ? call("HIGHLEVEL_ADD_TAGS", { contactId: "contact_1", tags: ["fixture"] }) : note;
  if (wait === "budget") {
    for (let i = 0; i < BUDGET_CALLS; i++) await h.client.listPipelines();
    hl.calls.length = 0;
  } else {
    hl.overrides.push({ status: wait === "429" ? 429 : 503, headers: { "retry-after": "3" } });
  }
  const pending = highlevelRpc(request, h.deps).catch((error: unknown) => error);
  await expect(h.waiting).resolves.toBe(wait === "429" ? 3_000 : wait === "5xx" ? 1_000 : 10_000);
  expect(hl.calls).toHaveLength(wait === "budget" ? 0 : 1);
  h.stop();
  h.resume();
  expect(await pending).toBe(h.stopped);
  expect(hl.calls).toHaveLength(wait === "budget" ? 0 : 1);
  expect(h.writes).toEqual([]);
});

it("checks Stop before the first request after asynchronous call setup", async () => {
  const h = harness();
  h.deps.authorize = () => { queueMicrotask(h.stop); return { ok: true }; };
  await expect(highlevelRpc(note, h.deps)).rejects.toBe(h.stopped);
  expect(hl.calls).toEqual([]);
  expect(h.writes).toEqual([]);
});

it("keeps concurrent calls on the shared client scoped to their own turn", async () => {
  const h = harness();
  hl.overrides.push({ status: 429, headers: { "retry-after": "3" } });
  const pending = highlevelRpc(note, h.deps).catch((error: unknown) => error);
  await h.waiting;
  h.stop();
  const otherWrites: HighLevelWriteRecord[] = [];
  const live = { ...h.deps, assertActive: () => {}, onWrite: (record: HighLevelWriteRecord) => { otherWrites.push(record); } };
  expect(await highlevelRpc(note, live)).not.toHaveProperty("isError", true);
  h.resume();
  expect(await pending).toBe(h.stopped);
  expect(hl.calls.filter((row) => row.method === "POST")).toHaveLength(2);
  expect(h.writes).toEqual([]);
  expect(otherWrites).toEqual([{ tool: "HIGHLEVEL_ADD_NOTE", kind: "note", recordId: "note_new", fields: ["body"] }]);
  expect(await highlevelRpc(note, live)).not.toHaveProperty("isError", true);
  expect(otherWrites).toHaveLength(2);
});

it.each(["429", "5xx", "budget"].flatMap((wait) => ["apps", "scope", "grant"].map((revoked) => ({ wait, revoked }))))(
  "rechecks $revoked access after a $wait wait", async ({ wait, revoked }) => {
    const h = harness();
    const request = wait === "5xx" ? call("HIGHLEVEL_ADD_TAGS", { contactId: "contact_1", tags: ["fixture"] }) : note;
    if (wait === "budget") {
      for (let i = 0; i < BUDGET_CALLS; i++) await h.client.listPipelines();
    } else {
      hl.overrides.push({ status: wait === "429" ? 429 : 503, headers: { "retry-after": "3" } });
    }
    hl.calls.length = 0;
    const pending = highlevelRpc(request, h.deps);
    await h.waiting;
    const sent = hl.calls.length;
    if (revoked === "apps") h.bot.composio = false;
    if (revoked === "scope") h.bot.connectorScopes = { apps: { highlevel: "read" } };
    if (revoked === "grant") h.bot.connectorTools = { highlevel: { tools: ["HIGHLEVEL_LIST_NOTES"] } };
    const refused = await highlevelRpc(request, h.deps);
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "refused" } });
    h.resume();
    expect(await pending).toEqual(refused);
    expect(hl.calls).toHaveLength(sent);
    expect(h.writes).toEqual([]);
  },
);

it("rechecks access before the first request after asynchronous call setup", async () => {
  const h = harness();
  h.deps.authorize = (name) => {
    queueMicrotask(() => { h.bot.composio = false; });
    return highlevelAccess(h.bot, name);
  };
  const result = await highlevelRpc(note, h.deps);
  expect(result).toEqual(await highlevelRpc(note, h.deps));
  expect(result).toMatchObject({ isError: true, structuredContent: { code: "refused" } });
  expect(hl.calls).toEqual([]);
  expect(h.writes).toEqual([]);
});

it("starts no OAuth refresh when access is revoked before a 401 arrives", async () => {
  const received = deferred<void>();
  const respond = deferred<void>();
  let refreshes = 0;
  const h = harness({ refresh: async () => {
    refreshes++;
    return { accessToken: "hl_access_seed", refreshToken: "rotated", expiresIn: 3600, scope: "", locationId: FAKE_LOCATION_ID };
  }, fetch: async (...args) => {
    const response = await fetch(...args);
    received.resolve();
    await respond.promise;
    return response;
  } });
  h.store.put({ kind: "oauth", accessToken: "hl_access_seed", refreshToken: "fixture", locationId: FAKE_LOCATION_ID, scopes: "" });
  hl.overrides.push({ status: 401, body: { message: "Invalid JWT" } });
  const saved = h.store.get();
  const pending = highlevelRpc(note, h.deps);
  await received.promise;
  h.bot.composio = false;
  respond.resolve();
  expect(await pending).toEqual(await highlevelRpc(note, h.deps));
  expect(refreshes).toBe(0);
  expect(hl.calls).toHaveLength(1);
  expect(h.store.get()).toEqual(saved);
  expect(h.writes).toEqual([]);
});

it.each(["apps", "scope", "grant"].flatMap((revoked) => [200, 400, 503].map((status) => ({ revoked, status }))))(
  "preserves a completed $status write outcome after $revoked access is revoked", async ({ revoked, status }) => {
    const received = deferred<void>();
    const respond = deferred<void>();
    const h = harness({ refresh: null, fetch: async (...args) => {
      const response = await fetch(...args);
      received.resolve();
      await respond.promise;
      return response;
    } });
    if (status !== 200) hl.overrides.push({ status, body: { message: "Fixture rejection" } });
    const pending = highlevelRpc(note, h.deps);
    await received.promise;
    if (revoked === "apps") h.bot.composio = false;
    if (revoked === "scope") h.bot.connectorScopes = { apps: { highlevel: "read" } };
    if (revoked === "grant") h.bot.connectorTools = { highlevel: { tools: ["HIGHLEVEL_LIST_NOTES"] } };
    respond.resolve();
    const result = await pending;
    if (status === 200) {
      expect(result).not.toHaveProperty("isError", true);
      expect(result).toHaveProperty("structuredContent.note.id", "note_new");
      expect(h.writes).toEqual([{ tool: "HIGHLEVEL_ADD_NOTE", kind: "note", recordId: "note_new", fields: ["body"] }]);
    } else {
      expect(result).toMatchObject({ isError: true, structuredContent: { status } });
      expect(result).not.toHaveProperty("structuredContent.code", "refused");
      expect(h.writes).toEqual([]);
    }
    expect(await highlevelRpc(note, h.deps)).toMatchObject({ isError: true, structuredContent: { code: "refused" } });
    expect(hl.calls).toHaveLength(1);
  },
);

it("rechecks access after a shared OAuth refresh without blocking an authorized call", async () => {
  const refreshing = deferred<void>();
  const resume = deferred<void>();
  let refreshes = 0;
  const h = harness({ refresh: async () => {
    refreshes++;
    refreshing.resolve();
    await resume.promise;
    return { accessToken: "hl_access_seed", refreshToken: "rotated", expiresIn: 3600, scope: "", locationId: FAKE_LOCATION_ID };
  } });
  h.store.put({ kind: "oauth", accessToken: "expired", refreshToken: "fixture", expiresAt: 0, locationId: FAKE_LOCATION_ID, scopes: "" });
  const pending = highlevelRpc(note, h.deps);
  await refreshing.promise;
  const liveBot = { ...h.bot };
  const liveWrites: HighLevelWriteRecord[] = [];
  const live = highlevelRpc(note, { ...h.deps, authorize: (name) => highlevelAccess(liveBot, name), onWrite: (record) => { liveWrites.push(record); } });
  h.bot.composio = false;
  resume.resolve();
  expect(await pending).toEqual(await highlevelRpc(note, h.deps));
  expect(await live).not.toHaveProperty("isError", true);
  expect(refreshes).toBe(1);
  expect(hl.calls).toHaveLength(1);
  expect(h.store.get()).toMatchObject({ state: "signed-in", accessToken: "hl_access_seed", refreshToken: "rotated" });
  expect(h.writes).toEqual([]);
  expect(liveWrites).toHaveLength(1);
});
