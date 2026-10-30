import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createMoveKinds, fileArrived, keptBoth, planFiles } from "./cloud-send-kinds.mjs";
import { growToFit, moveFit } from "./cloud-space.mjs";

const GB = 1024 ** 3;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const file = (path, text) => ({ path, size: Buffer.byteLength(text), sha256: sha(text) });

test("a file arriving beside My Cloud's own different one keeps its name with this computer's after it", () => {
  assert.equal(keptBoth("workspaces/b1/notes.md", "Amit's MacBook Air"), "workspaces/b1/notes (Amit's MacBook Air).md");
  assert.equal(keptBoth("task-workspaces/b1/t1/Makefile", "Mac/../x"), "task-workspaces/b1/t1/Makefile (Mac .. x)");
  assert.equal(keptBoth("workspaces/b1/.env.local", ""), "workspaces/b1/.env (this computer).local");
});

test("a file has arrived when My Cloud holds its bytes at its path, or beside a file of its own under its name", () => {
  const notes = file("workspaces/b1/notes.md", "mine");
  const there = (entries) => new Map(entries.map((entry) => [entry.path, entry]));
  assert.equal(fileArrived(notes, there([file("workspaces/b1/notes.md", "mine")])), true);
  assert.equal(fileArrived(notes, there([file("workspaces/b1/notes.md", "theirs"), file("workspaces/b1/notes (Mac).md", "mine")])), true);
  assert.equal(fileArrived(notes, there([file("workspaces/b1/notes.md", "theirs"), file("workspaces/b1/other (Mac).md", "mine")])), false);
  assert.equal(fileArrived(notes, there([file("workspaces/b1/notes (Mac).md", "theirs")])), false);
});

test("each file goes new, replaces the one the move put there and only it, or goes beside My Cloud's own: never over it", () => {
  const here = [file("workspaces/b1/new.md", "n"), file("workspaces/b1/same.md", "s"), file("workspaces/b1/edited.md", "e2"), file("workspaces/b1/theirs.md", "mine")];
  const there = new Map([file("workspaces/b1/same.md", "s"), file("workspaces/b1/edited.md", "e1"), file("workspaces/b1/theirs.md", "their own")].map((entry) => [entry.path, entry]));
  const plan = planFiles(here, there, { "workspaces/b1/edited.md": sha("e1"), "workspaces/b1/theirs.md": sha("older") }, "Mac");
  assert.deepEqual(plan.map(({ path, to, mode, expect, kept }) => ({ path, to, mode, expect, kept })), [
    { path: "workspaces/b1/new.md", to: "workspaces/b1/new.md", mode: "new", expect: undefined, kept: undefined },
    { path: "workspaces/b1/edited.md", to: "workspaces/b1/edited.md", mode: "replace", expect: sha("e1"), kept: undefined },
    { path: "workspaces/b1/theirs.md", to: "workspaces/b1/theirs (Mac).md", mode: "new", expect: undefined, kept: true },
  ]);
});

test("room on My Cloud: a move's files need their size once, a whole-workspace copy three times; a volume grows in the Admin's steps", async () => {
  assert.equal(moveFit({ localBytes: GB, freeBytes: 2 * GB, copies: 1 }).fit, "now");
  assert.equal(moveFit({ localBytes: GB, freeBytes: 2 * GB }).fit, "never");
  assert.deepEqual(moveFit({ localBytes: 15 * GB, freeBytes: 2 * GB, volumeBytes: 10 * GB, disk: { maxBytes: 50 * GB }, copies: 1 }), { fit: "grow", neededBytes: 15 * GB + 256 * 1024 ** 2,
    freeBytes: 2 * GB, maxBytes: 50 * GB, sizeGb: 30 });
  assert.equal(moveFit({ localBytes: 60 * GB, freeBytes: 2 * GB, volumeBytes: 10 * GB, disk: { maxBytes: 50 * GB }, copies: 1 }).fit, "never");
  const fit = { neededBytes: 100, sizeGb: 20 };
  let free = 10;
  assert.equal(await growToFit(fit, { grow: async () => { free = 200; return { supported: true }; }, free: async () => free, sleep: async () => {} }), "grown");
  assert.equal(await growToFit(fit, { grow: async () => ({ supported: false }), free: async () => 0 }), "unsupported");
  assert.equal(await growToFit(fit, { grow: async () => ({ supported: true, refused: true }), free: async () => 0 }), "full");
  assert.equal(await growToFit(fit, { grow: async () => { throw new Error("down"); }, free: async () => 0 }), "unavailable");
  let clock = 0;
  assert.equal(await growToFit(fit, { grow: async () => ({ supported: true }), free: async () => 10, sleep: async (ms) => { clock += ms; }, now: () => clock, timeoutMs: 10_000 }), "unavailable");
});

/** This computer's files and My Cloud, which keeps what it takes; `free`: its free bytes. */
function filesSides({ here, there = [], free = 1e12, volume = 1e12, disk = null, grow = null, conflictAt = [] }) {
  const stored = new Map(there.map((entry) => [entry.path, { ...entry }]));
  const uploads = [], failed = [];
  const parts = new Map();
  const session = {
    call: async (method, route, body) => {
      if (method === "GET" && route === "/api/cloud-send/files") return { ok: true, status: 200, body: { files: [...stored.values()], space: { freeBytes: typeof free === "function" ? free() : free, volumeBytes: volume } } };
      if (method === "POST" && route === "/api/cloud-send/chats/attachments") return { ok: true, status: 200, body: { missing: body.names } };
      throw new Error(`unexpected ${method} ${route}`);
    },
    upload: async (route, bytes) => {
      const query = new URL(`http://x${route}`).searchParams;
      const path = query.get("path"), offset = Number(query.get("offset")), size = Number(query.get("size"));
      uploads.push([path, offset, bytes.length]);
      const key = `${query.get("sha256")}`;
      const held = parts.get(key) ?? 0;
      if (offset !== held) return { ok: false, status: 409, body: { received: held } };
      parts.set(key, held + bytes.length);
      if (held + bytes.length < size) return { ok: true, status: 200, body: { received: held + bytes.length } };
      if (conflictAt.includes(path) || (stored.has(path) && query.get("mode") !== "replace")) return { ok: false, status: 409, body: { conflict: true } };
      stored.set(path, { path, size, sha256: query.get("sha256") });
      parts.delete(key);
      return { ok: true, status: 201, body: { stored: true } };
    },
  };
  const texts = new Map(here.map((entry) => [entry.path, entry.text]));
  const state = { files: {} };
  const kinds = createMoveKinds({
    localJson: async (route) => {
      if (route === "/api/cloud-send/files") return { files: here.map(({ text: _text, ...entry }) => entry) };
      if (route === "/api/cloud-send/chats?attachments=1") return { attachments: [{ name: "a.png", size: 1000 }] };
      throw new Error(`unexpected ${route}`);
    },
    localBytes: async (route) => {
      const query = new URL(`http://x${route}`).searchParams;
      return new Uint8Array(Buffer.from(texts.get(query.get("path"))).subarray(Number(query.get("offset")), Number(query.get("offset")) + Number(query.get("length"))));
    },
    localSend: async () => ({ ok: true, status: 200 }), entry: () => state, persist() {}, progress() {},
    refusal: (answer, fallback) => answer.body?.error ?? fallback,
    ...(disk || grow ? { space: { disk: () => disk, grow } } : {}),
  });
  const ctx = { origin: "https://omb-u-1.fly.dev", session, result: { failed } };
  return { kinds, ctx, stored, uploads, failed, state };
}

test("the bots' files go once My Cloud has room for them and the attachments still to go; on a conflict, beside My Cloud's own", async () => {
  const notes = { ...file("workspaces/b1/notes.md", "mine"), text: "mine" };
  const sides = filesSides({ here: [notes, { ...file("workspaces/other/x.md", "x"), text: "x" }], there: [file("workspaces/b1/notes.md", "their own")] });
  await sides.kinds.moveFiles(sides.ctx, [{ id: "b1", name: "Nova" }], "Mac");
  assert.deepEqual(sides.failed, []);
  assert.deepEqual([...sides.stored.keys()].sort(), ["workspaces/b1/notes (Mac).md", "workspaces/b1/notes.md"]);
  assert.equal(sides.stored.get("workspaces/b1/notes.md").sha256, sha("their own"), "My Cloud's own file is never written over");
  assert.deepEqual(sides.ctx.result.files, { sent: 1, kept: 1 });
  assert.deepEqual(sides.state.files, { "workspaces/b1/notes (Mac).md": sha("mine") });
});

test("a file the move put there that conflicts only when it lands goes beside, and a part My Cloud holds already is not sent again", async () => {
  const report = { ...file("workspaces/b1/report.md", "x".repeat(10)), text: "x".repeat(10) };
  const sides = filesSides({ here: [report], conflictAt: ["workspaces/b1/report.md"] });
  await sides.kinds.moveFiles(sides.ctx, [{ id: "b1", name: "Nova" }], "Mac");
  assert.deepEqual(sides.uploads, [["workspaces/b1/report.md", 0, 10], ["workspaces/b1/report (Mac).md", 0, 10], ["workspaces/b1/report (Mac).md", 10, 0]]);
  assert.ok(sides.stored.has("workspaces/b1/report (Mac).md"));
});

test("files My Cloud has no room for are said plainly and none of them goes; a volume that can grow grows first", async () => {
  const big = { ...file("workspaces/b1/big.bin", "b"), size: 40 * GB, text: "b" };
  const full = filesSides({ here: [big], free: GB, volume: 10 * GB, disk: { maxBytes: 20 * GB }, grow: async () => ({ supported: true }) });
  await full.kinds.moveFiles(full.ctx, [{ id: "b1", name: "Nova" }], "Mac");
  assert.deepEqual(full.failed.map((entry) => [entry.key, entry.error]), [["files", "My Cloud does not have enough space for this computer's files. Delete some there, or choose a bigger plan."]]);
  assert.deepEqual(full.uploads, []);

  const small = { ...file("workspaces/b1/small.bin", "s"), text: "s" };
  const grown = [];
  let freeNow = 0;
  const growing = filesSides({ here: [small], free: () => freeNow, volume: 10 * GB, disk: { maxBytes: 50 * GB }, grow: async (sizeGb) => { grown.push(sizeGb); freeNow = GB; return { supported: true }; } });
  await growing.kinds.moveFiles(growing.ctx, [{ id: "b1", name: "Nova" }], "Mac");
  assert.deepEqual(grown, [20], "the volume grows one of the Admin's steps, for the file and the attachment still to go");
  assert.deepEqual(growing.failed, []);
  assert.ok(growing.stored.has("workspaces/b1/small.bin"));
});

test("a volume that could not grow is said, and none of the files goes", async () => {
  const small = { ...file("workspaces/b1/small.bin", "s"), text: "s" };
  for (const [answer, error] of [[{ supported: true, refused: true }, "My Cloud does not have enough space for this computer's files."],
    [{ supported: false }, "My Cloud could not make room for this computer's files just now. It tries again next time."]]) {
    const sides = filesSides({ here: [small], free: 0, volume: 10 * GB, disk: { maxBytes: 50 * GB }, grow: async () => answer });
    await sides.kinds.moveFiles(sides.ctx, [{ id: "b1", name: "Nova" }], "Mac");
    assert.deepEqual(sides.failed.map((entry) => [entry.key, entry.error]), [["files", error]]);
    assert.deepEqual(sides.uploads, []);
  }
});
