import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncAuthError, createSyncClient } from "./cloud-sync-client.mjs";
import { CloudAsleepError, createCloudPowerGate } from "./cloud-power.mjs";

const ORIGIN = "https://omb-u-1a2b3c4d5e6f.fly.dev";
const reply = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function dir(t) { const path = mkdtempSync(join(tmpdir(), "omb-sync-client-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }

test("sends the Cloud origin and the window's sign-in, and turns 401 into a sign-in error", async () => {
  const seen = [];
  const client = createSyncClient({ origin: ORIGIN, fetch: async (url, init) => { seen.push([url, init]); return reply(401, { error: "no" }); } });
  await assert.rejects(client.summary(), SyncAuthError);
  assert.equal(seen[0][0], `${ORIGIN}/api/sync`);
  assert.equal(seen[0][1].headers.origin, ORIGIN);
  assert.equal(seen[0][1].credentials, "include");
});

test("marks every call as background work, so My Cloud never counts Files as the person using it", async () => {
  const seen = [];
  const client = createSyncClient({ origin: ORIGIN, fetch: async (url, init) => { seen.push(init.headers); return reply(200, { folders: [] }); } });
  await client.summary();
  await client.changes(0, 10, new AbortController().signal);
  assert.deepEqual(seen.map((headers) => headers["x-omb-background"]), ["1", "1"]);
});

test("My Cloud going to sleep: its 503 asleep answer holds Files back, and nothing is called while it sleeps", async () => {
  const at = 1_792_355_000_000;
  let power = { state: "awake", since: at, sleeps: true }, calls = 0;
  const gate = createCloudPowerGate({ power: () => power });
  const client = createSyncClient({ origin: ORIGIN, power: gate, fetch: async () => { calls++; return reply(503, { error: "asleep" }, { "x-omb-cloud-power": "asleep" }); } });
  await assert.rejects(client.changes(0, 10, new AbortController().signal), CloudAsleepError);
  assert.equal(gate.asleep(), true);
  await assert.rejects(client.summary(), CloudAsleepError);
  assert.equal(calls, 1);
  power = { state: "awake", since: at + 60_000, sleeps: true };
  const plain = createSyncClient({ origin: ORIGIN, power: gate, fetch: async () => { calls++; return reply(503, { error: "busy" }); } });
  await assert.rejects(plain.summary(), (error) => !(error instanceof CloudAsleepError) && error.status === 503, "any other 503 is offline, as before");
  assert.equal(calls, 2);
});

test("an upload resumes where My Cloud says it got to, halves parts a proxy refuses, and commits", async (t) => {
  const file = join(dir(t), "a.bin");
  writeFileSync(file, Buffer.alloc(40, 7));
  const puts = [];
  let received = 0;
  const client = createSyncClient({ origin: ORIGIN, chunkBytes: 32, minChunkBytes: 8, fetch: async (url, init) => {
    if (url.endsWith("/uploads")) return reply(200, { uploadId: "11111111-1111-4111-8111-111111111111", received: 8 });
    if (init.method === "PUT") {
      const offset = Number(new URL(url).searchParams.get("offset"));
      puts.push([offset, init.body.length]);
      if (init.body.length > 16) return reply(413, "too big");
      if (offset !== received + 8) return reply(409, { received: received + 8 });
      received += init.body.length;
      return reply(200, { received: received + 8 });
    }
    if (url.endsWith("/commit")) return reply(200, { sha256: "s" });
    throw new Error(url);
  } });
  assert.deepEqual(await client.upload({ folderId: "f", path: "a.bin", file, size: 40, sha256: "s", baseSha256: null }), { ok: true });
  assert.deepEqual(puts, [[8, 32], [8, 16], [24, 16]]);
});

test("an upload answers a full Cloud and a lost race plainly", async (t) => {
  const file = join(dir(t), "a.bin");
  writeFileSync(file, "x");
  const full = createSyncClient({ origin: ORIGIN, fetch: async () => reply(507, { neededBytes: 9, freeBytes: 1 }) });
  assert.deepEqual(await full.upload({ folderId: "f", path: "a", file, size: 1, sha256: "s", baseSha256: null }), { full: true, neededBytes: 9, freeBytes: 1 });
  const raced = createSyncClient({ origin: ORIGIN, fetch: async (url, init) => url.endsWith("/uploads") ? reply(200, { uploadId: "u", received: 1 }) : init.method === "POST" ? reply(409, { current: { sha256: "other" } }) : reply(200, {}) });
  assert.deepEqual(await raced.upload({ folderId: "f", path: "a", file, size: 1, sha256: "s", baseSha256: null }), { conflict: true, current: { sha256: "other" } });
});

test("a download resumes a partial file with a range", async (t) => {
  const temporary = join(dir(t), ".a.txt.omb-sync-1a2b3c4d");
  writeFileSync(temporary, "hello ");
  let range;
  const client = createSyncClient({ origin: ORIGIN, fetch: async (_url, init) => { range = init.headers.range; return new Response("world", { status: 206, headers: { "x-omb-sha256": "s" } }); } });
  assert.deepEqual(await client.download("f", "a.txt", temporary), { sha256: "s" });
  assert.equal(range, "bytes=6-");
  assert.equal(readFileSync(temporary, "utf8"), "hello world");
});

test("a part that times out is sent again smaller, and a timed-out download fails that file, not the whole pass", async (t) => {
  const file = join(dir(t), "a.bin");
  writeFileSync(file, Buffer.alloc(32, 1));
  const puts = [];
  let received = 0;
  const client = createSyncClient({ origin: ORIGIN, chunkBytes: 32, minChunkBytes: 8, fetch: async (url, init) => {
    if (url.endsWith("/uploads")) return reply(200, { uploadId: "11111111-1111-4111-8111-111111111111", received: 0 });
    if (init.method === "PUT") {
      puts.push(init.body.length);
      if (init.body.length > 8) throw new DOMException("The operation timed out.", "TimeoutError");
      received += init.body.length;
      return reply(200, { received });
    }
    return reply(200, { sha256: "s" });
  } });
  assert.deepEqual(await client.upload({ folderId: "f", path: "a.bin", file, size: 32, sha256: "s", baseSha256: null }), { ok: true });
  assert.deepEqual(puts, [32, 16, 8, 8, 8, 8]);
  const slow = createSyncClient({ origin: ORIGIN, fetch: async () => { throw new DOMException("The operation timed out.", "TimeoutError"); } });
  const error = await slow.download("f", "a.txt", join(dir(t), ".a.txt.omb-sync-1a2b3c4d")).catch((caught) => caught);
  assert.notEqual(error.name, "TimeoutError");
  assert.match(error.message, /too slow/);
});
