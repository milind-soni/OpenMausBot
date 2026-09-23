import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { downloadVerified } from "./stt-local.mjs";

test("model download verifies size and hash before replacing an existing model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omb-stt-download-"));
  const target = path.join(dir, "model.bin"), body = Buffer.from("synthetic model");
  const server = createServer((_req, res) => res.end(body));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/model`;
  const sha = createHash("sha256").update(body).digest("hex");
  try {
    await fs.writeFile(target, "previous valid model");
    for (const options of [{ size: body.length, sha: "0".repeat(64) }, { size: body.length - 1, sha }, { size: body.length + 1, sha }]) {
      await assert.rejects(downloadVerified(url, target, options), /integrity|expected size/);
      assert.equal(await fs.readFile(target, "utf8"), "previous valid model");
      assert.deepEqual(await fs.readdir(dir), ["model.bin"]);
    }
    await downloadVerified(url, target, { size: body.length, sha });
    assert.deepEqual(await fs.readFile(target), body);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
