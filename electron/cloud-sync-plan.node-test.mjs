import assert from "node:assert/strict";
import test from "node:test";
import { ASK_DELETES_AT, planOutputs, planShare } from "./cloud-sync-plan.mjs";

const f = (sha256, size = 1, mtimeMs = 1) => ({ sha256, size, mtimeMs, file: `/pc/${sha256}` });
const map = (entries) => new Map(Object.entries(entries));

test("a shared folder: this computer's version always wins, and a bot's own files on My Cloud stay", () => {
  const plan = planShare({
    base: map({ "same.txt": f("a"), "edited.txt": f("b") }),
    pc: map({ "same.txt": f("a"), "edited.txt": f("b2", 2, 2), "new.txt": f("n"), "bot-edited.txt": f("p") }),
    cloud: map({ "same.txt": f("a"), "edited.txt": f("b"), "bot-edited.txt": f("bot"), "bot-only.txt": f("x") }),
  });
  assert.deepEqual(plan.uploads.map((upload) => [upload.path, upload.baseSha256]).sort(), [["bot-edited.txt", "bot"], ["edited.txt", "b"], ["new.txt", null]]);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.ask, false);
});

test("a shared folder: only what the base proves was here is removed from My Cloud, never what can't be read or is kept", () => {
  const plan = planShare({
    base: map({ "gone.txt": f("g"), "busy.txt": f("u"), "link.txt": f("l"), "linked/inside.txt": f("i"), "also-gone-there.txt": f("z") }),
    pc: map({ "busy.txt": { unsettled: true }, "link.txt": { kept: true } }),
    cloud: map({ "gone.txt": f("g"), "busy.txt": f("u"), "link.txt": f("l"), "linked/inside.txt": f("i") }),
    keptDirs: ["linked"],
  });
  assert.deepEqual(plan.deletes.map((entry) => entry.path), ["gone.txt"]);
  assert.deepEqual(plan.forgets.map((entry) => entry.path), ["also-gone-there.txt"]);
  assert.deepEqual(plan.uploads, []);
});

test("a shared folder: many files gone at once, or all of it, waits for the person", () => {
  const base = new Map(Array.from({ length: 40 }, (_, n) => [`f${n}.txt`, f(`s${n}`)]));
  const cloud = new Map(base);
  const keep = (count) => new Map([...base].slice(count));
  assert.equal(planShare({ base, pc: keep(ASK_DELETES_AT - 1), cloud }).ask, false);
  assert.equal(planShare({ base, pc: keep(ASK_DELETES_AT), cloud }).ask, true);
  // Ten of a thousand is not a fifth: removed without asking.
  const big = new Map(Array.from({ length: 1000 }, (_, n) => [`f${n}.txt`, f(`s${n}`)]));
  assert.equal(planShare({ base: big, pc: new Map([...big].slice(10)), cloud: new Map(big) }).ask, false);
  // A single file, when it was the last one: asked.
  assert.equal(planShare({ base: map({ "only.txt": f("o") }), pc: new Map(), cloud: map({ "only.txt": f("o") }) }).ask, true);
});

test("a bot's work: new and changed files come down; nothing is ever deleted here", () => {
  const plan = planOutputs({
    base: map({ "kept.md": f("k"), "old.md": f("o"), "removed-here.md": f("r") }),
    pc: map({ "kept.md": f("k"), "old.md": f("o") }),
    cloud: map({ "kept.md": f("k"), "old.md": f("o2"), "new.md": f("n"), "removed-here.md": f("r") }),
  });
  assert.deepEqual(plan.downloads.map((entry) => [entry.path, Boolean(entry.replace), Boolean(entry.beside)]).sort(), [["new.md", false, false], ["old.md", true, false]]);
  assert.deepEqual(plan.records, []);
});

test("a bot's work: the person's edit here is kept, and My Cloud's newer version lands beside it once", () => {
  const edited = { sha256: "mine", size: 9, mtimeMs: 9 };
  const first = planOutputs({ base: map({ "draft.md": f("v1") }), pc: map({ "draft.md": edited }), cloud: map({ "draft.md": f("v2") }) });
  assert.deepEqual(first.downloads.map((entry) => [entry.path, entry.beside, entry.replace]), [["draft.md", true, null]]);
  // Once that version came (the base holds it), the edit is left alone until My Cloud changes again.
  const after = planOutputs({ base: map({ "draft.md": { sha256: "v2", size: 9, mtimeMs: 9 } }), pc: map({ "draft.md": edited }), cloud: map({ "draft.md": f("v2") }) });
  assert.deepEqual(after.downloads, []);
  // A file the person removed here comes back only with a newer version.
  assert.deepEqual(planOutputs({ base: map({ "x.md": f("x") }), pc: new Map(), cloud: map({ "x.md": f("x") }) }).downloads, []);
  assert.equal(planOutputs({ base: map({ "x.md": f("x") }), pc: new Map(), cloud: map({ "x.md": f("x2") }) }).downloads.length, 1);
});
