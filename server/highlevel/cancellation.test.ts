import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, type FakeHighLevel } from "../testing/fake-highlevel.ts";
import { BUDGET_CALLS, HighLevelClient } from "./client.ts";
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

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-cancel-"));
  dirs.push(dir);
  const store = new HighLevelStore({ dataDir: dir });
  store.put({ kind: "token", accessToken: "hl_access_seed", locationId: FAKE_LOCATION_ID, scopes: "" });
  const waiting = deferred<number>();
  const resume = deferred<void>();
  let now = Date.now();
  const client = new HighLevelClient({ store, refresh: null, apiUrl: hl.url, now: () => now, sleep: async (ms) => {
    waiting.resolve(ms);
    await resume.promise;
    now += ms;
  } });
  const stopped = Object.assign(new Error("turn ended"), { status: 409 });
  let active = true;
  const writes: HighLevelWriteRecord[] = [];
  const deps: HighLevelRpcDeps = {
    client, assertActive: () => { if (!active) throw stopped; }, authorize: () => ({ ok: true }),
    onWrite: (record) => { writes.push(record); },
  };
  return { client, deps, writes, waiting: waiting.promise, resume: resume.resolve, stop: () => { active = false; }, stopped };
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
