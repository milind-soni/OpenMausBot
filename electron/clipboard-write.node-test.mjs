import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIPBOARD_TEXT_MAX_CHARS, writeClipboardText } from "./clipboard-write.mjs";

const fake = (fail = false) => {
  const written = [];
  return { written, writeText: (text) => { if (fail) throw new Error("no clipboard"); written.push(text); } };
};

test("writes plain text and reports success", () => {
  const clipboard = fake();
  assert.equal(writeClipboardText(clipboard, "hello"), true);
  assert.deepEqual(clipboard.written, ["hello"]);
});

test("rejects non-strings, blank text and oversized text without writing", () => {
  const clipboard = fake();
  for (const bad of [undefined, null, 42, {}, ["a"], "", "  \n", "x".repeat(CLIPBOARD_TEXT_MAX_CHARS + 1)]) {
    assert.equal(writeClipboardText(clipboard, bad), false);
  }
  assert.deepEqual(clipboard.written, []);
});

test("reports failure when the native clipboard throws", () => {
  assert.equal(writeClipboardText(fake(true), "hello"), false);
});
