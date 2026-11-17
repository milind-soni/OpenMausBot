import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyncClient } from "./cloud-sync-client.mjs";

function setup(t, contents, maxRead) {
  const folder = fs.mkdtempSync(join(tmpdir(), "omb-sync-short-read-"));
  const file = join(folder, "upload");
  fs.writeFileSync(file, contents);
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, maxRead), position));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(folder, { recursive: true, force: true }); });
  return file;
}

test("fills upload parts across short reads, including a resumed offset", async (t) => {
  const contents = Buffer.from("first 世界 last");
  const file = setup(t, contents, 2);
  let received = 3;
  const sent = [];
  const client = createSyncClient({ origin: "https://sync.example.test", chunkBytes: 5, minChunkBytes: 1, fetch: async (url, init) => {
    if (url.endsWith("/uploads")) return Response.json({ uploadId: "id", received });
    if (init.method === "PUT") {
      assert.equal(Number(new URL(url).searchParams.get("offset")), received);
      sent.push(Buffer.from(init.body));
      received += init.body.length;
      return Response.json({ received });
    }
    return Response.json({});
  } });
  assert.deepEqual(await client.upload({ folderId: "f", path: "file", file, size: contents.length, sha256: "s", baseSha256: null }), { ok: true });
  assert.deepEqual(Buffer.concat(sent), contents.subarray(3));
});

test("an actual early EOF fails before sending or committing an incomplete part", async (t) => {
  const file = setup(t, "short", 2);
  let calls = 0;
  const client = createSyncClient({ origin: "https://sync.example.test", fetch: async () => {
    calls++;
    return Response.json({ uploadId: "id", received: 0 });
  } });
  await assert.rejects(client.upload({ folderId: "f", path: "file", file, size: 10, sha256: "s", baseSha256: null }), /file changed/);
  assert.equal(calls, 1);
});
