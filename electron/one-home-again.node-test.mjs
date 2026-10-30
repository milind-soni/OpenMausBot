import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHomeAgain } from "./one-home-again.mjs";

const CLOUD = "https://omb-t-1.fly.dev";
const reply = (status, body = {}) => ({ ok: status < 400, status, body });
const BUSY = "Wait for bot turns, approvals, sign-ins, and computer actions to finish before backing up or restoring.";

/** My Cloud's export and this computer's upload, preview and restore, each counted; `restores` is what each restore
 * answers in turn. */
function world(restores) {
  const tempRoot = mkdtempSync(join(tmpdir(), "omb-home-again-"));
  const w = { asked: 0, exports: 0, downloads: 0, uploads: 0, previews: 0, restored: [], tempRoot };
  w.again = createHomeAgain({
    async exportGrant() { w.asked++; return { grant: { origin: CLOUD, code: `code-${w.asked}`, expiresAt: Date.now() + 300_000 } }; },
    async open() {
      return {
        async call(method, route) {
          if (route === "/api/cloud-send/manifest") return reply(200, { automations: [{ key: "routine:r1", on: true }, { key: "webhook:w1", on: false }] });
          if (method === "POST" && route === "/api/workspace-backup/export") { w.exports++; return reply(200, { id: `export-${w.exports}` }); }
          return reply(404);
        },
        async fetch() { w.downloads++; return new Response("the backup"); },
        async close() {},
      };
    },
    local: {
      async upload() { w.uploads++; return reply(200, { id: `upload-${w.uploads}` }); },
      async json(method, route, body) {
        if (route === "/api/workspace-backup/preview") { w.previews++; return reply(200, { id: `staged-${w.previews}` }); }
        if (route === "/api/workspace-backup/restore") { w.restored.push(body.id); return restores.shift() ?? reply(200, { restoreId: body.id }); }
        return reply(404);
      },
    },
    tempRoot,
  });
  return w;
}

test("a restore this computer refuses while its bots are busy waits seconds, not minutes, and then restores the backup it already took", async (t) => {
  const w = world([reply(409, { error: BUSY }), reply(409, { error: BUSY })]);
  t.after(() => rmSync(w.tempRoot, { recursive: true, force: true }));
  const first = await w.again.bring();
  assert.ok("later" in first && first.later <= 15_000, `it tries again in seconds: ${JSON.stringify(first)}`);
  const second = await w.again.bring();
  assert.ok("later" in second && second.later <= 15_000, `still busy, still seconds: ${JSON.stringify(second)}`);
  assert.deepEqual(await w.again.bring(), { restored: "staged-1", switches: { "routine:r1": true, "webhook:w1": false } });
  assert.deepEqual(w.restored, ["staged-1", "staged-1", "staged-1"], "the same staged backup each time");
  assert.deepEqual([w.asked, w.exports, w.downloads, w.uploads, w.previews], [1, 1, 1, 1, 1], "My Cloud's backup is taken once");

  // A later come-home takes a new one.
  assert.deepEqual(await w.again.bring(), { restored: "staged-2", switches: { "routine:r1": true, "webhook:w1": false } });
  assert.deepEqual([w.asked, w.downloads], [2, 2]);
});

test("a restore that fails otherwise still fails, and the next try takes My Cloud's backup again", async (t) => {
  const w = world([reply(404, { error: "This backup has expired or belongs to another session. Select the file again." })]);
  t.after(() => rmSync(w.tempRoot, { recursive: true, force: true }));
  await assert.rejects(w.again.bring(), /This backup has expired/u);
  assert.deepEqual(await w.again.bring(), { restored: "staged-2", switches: { "routine:r1": true, "webhook:w1": false } });
  assert.deepEqual([w.asked, w.downloads, w.restored], [2, 2, ["staged-1", "staged-2"]]);
});
