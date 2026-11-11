import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyncClient } from "./cloud-sync-client.mjs";

const origin = "https://sync.example.test";
function partial(t, content) {
  const folder = mkdtempSync(join(tmpdir(), "omb-sync-range-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "partial");
  writeFileSync(file, content);
  return file;
}

for (const [name, previous, next] of [
  ["a completed partial file", "complete", "complete"],
  ["a file shortened on My Cloud", "old longer file", "new"],
  ["a file emptied on My Cloud", "old content", ""],
]) test(`restarts ${name} when its resume range is no longer satisfiable`, async (t) => {
  const temporary = partial(t, previous);
  const ranges = [];
  let cancelled = false;
  const client = createSyncClient({ origin, fetch: async (_url, init) => {
    ranges.push(init.headers.range);
    if (init.headers.range) return new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify({ error: "range refused" }))); stream.close(); },
      cancel() { cancelled = true; },
    }), {
      status: 416, headers: { "content-range": `bytes */${next.length}` },
    });
    assert.equal(cancelled, true);
    return new Response(next, { headers: { "x-omb-sha256": "current-hash" } });
  } });
  assert.deepEqual(await client.download("folder", "file.txt", temporary, next.length), { sha256: "current-hash" });
  assert.deepEqual(ranges, [`bytes=${previous.length}-`, undefined]);
  assert.equal(readFileSync(temporary, "utf8"), next);
});

test("a refused full retry keeps the partial bytes and does not loop", async (t) => {
  const temporary = partial(t, "partial bytes");
  let calls = 0;
  const client = createSyncClient({ origin, fetch: async () => {
    calls++;
    return Response.json({ error: "range refused" }, { status: 416 });
  } });
  await assert.rejects(client.download("folder", "file.txt", temporary), { status: 416 });
  assert.equal(calls, 2);
  assert.equal(readFileSync(temporary, "utf8"), "partial bytes");
});

test("an initial full request is not repeated for a range error", async (t) => {
  const temporary = partial(t, "");
  let calls = 0;
  const client = createSyncClient({ origin, fetch: async () => {
    calls++;
    return Response.json({ error: "range refused" }, { status: 416 });
  } });
  await assert.rejects(client.download("folder", "file.txt", temporary), { status: 416 });
  assert.equal(calls, 1);
});
