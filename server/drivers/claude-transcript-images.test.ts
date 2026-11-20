import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { CLAUDE_IMAGE_KEEP, CLAUDE_IMAGE_LIMIT, foldTranscriptImages, transcriptImagesOver, transcriptPath } from "./claude-transcript-images.ts";

const image = (n: number) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `img${n}` } });
const userRow = (blocks: unknown[], n: number) => JSON.stringify({ type: "user", message: { role: "user", content: blocks }, uuid: `u${n}` });

function setup(rows: string[]): { configDir: string; cwd: string; sessionId: string; file: string } {
  const base = mkdtempSync(join(tmpdir(), "claude-images-"));
  const configDir = join(base, ".claude-api");
  const cwd = "/home/user/projects/thread-abc";
  const sessionId = "s1";
  const file = transcriptPath(configDir, cwd, sessionId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, rows.join("\n") + "\n");
  return { configDir, cwd, sessionId, file };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test("a resumed thread keeps its newest images: older ones become a note, the engine's JSONL stays one row per message", () => {
  const rows = Array.from({ length: 25 }, (_, i) => userRow([{ type: "text", text: `page ${i + 1}` }, image(i + 1)], i + 1));
  const { configDir, cwd, sessionId, file } = setup(rows);
  const result = foldTranscriptImages({ configDir, cwd, sessionId, minBytes: 0 });
  assert.deepEqual(result, { total: 25, folded: 25 - CLAUDE_IMAGE_KEEP });
  const text = readFileSync(file, "utf8");
  assert.equal(count(text, '"type":"image"'), CLAUDE_IMAGE_KEEP);
  assert.equal(count(text, "Earlier image"), 25 - CLAUDE_IMAGE_KEEP);
  assert.equal(text.trim().split("\n").length, 25);
  // the newest pages are the ones still attached
  const last = JSON.parse(text.trim().split("\n").at(-1)!);
  assert.equal(last.message.content[1].source.data, "img25");
  // the folded rows keep their own text
  const first = JSON.parse(text.trim().split("\n")[0]);
  assert.equal(first.message.content[0].text, "page 1");
  assert.match(first.message.content[1].text, /Earlier image/);
});

test("tool-result images count too, and a transcript already under the limit is left untouched", () => {
  const toolResult = (n: number) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [image(n)] }] } });
  const few = setup([toolResult(1), toolResult(2)]);
  assert.deepEqual(foldTranscriptImages({ configDir: few.configDir, cwd: few.cwd, sessionId: few.sessionId, minBytes: 0 }), { total: 2, folded: 0 });
  const before = readFileSync(few.file, "utf8");

  const many = setup(Array.from({ length: 20 }, (_, i) => toolResult(i + 1)));
  assert.equal(foldTranscriptImages({ configDir: many.configDir, cwd: many.cwd, sessionId: many.sessionId, minBytes: 0 }).folded, 20 - CLAUDE_IMAGE_KEEP);
  assert.equal(count(readFileSync(many.file, "utf8"), '"type":"image"'), CLAUDE_IMAGE_KEEP);
  assert.equal(readFileSync(few.file, "utf8"), before);
});

test("a missing transcript is a no-op, and the same file is not parsed twice", () => {
  const { configDir, cwd } = setup([]);
  assert.equal(foldTranscriptImages({ configDir, cwd, sessionId: "nope", minBytes: 0 }).skipped, "missing");

  const rows = Array.from({ length: 21 }, (_, i) => userRow([image(i)], i));
  const one = setup(rows);
  assert.equal(foldTranscriptImages({ configDir: one.configDir, cwd: one.cwd, sessionId: one.sessionId, minBytes: 0 }).folded, 21 - CLAUDE_IMAGE_KEEP);
  assert.equal(foldTranscriptImages({ configDir: one.configDir, cwd: one.cwd, sessionId: one.sessionId, minBytes: 0 }).skipped, "unchanged");
});

test("a warm process is over the limit once what it holds plus this turn's images passes 20", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => userRow([{ type: "text", text: `page ${i}` }, image(i)], i));
  const at = setup(rows(CLAUDE_IMAGE_LIMIT));
  assert.equal(transcriptImagesOver(at), false);
  assert.equal(transcriptImagesOver(at, 1), true);
  const under = setup(rows(CLAUDE_IMAGE_LIMIT - 2));
  assert.equal(transcriptImagesOver(under, 2), false);
  assert.equal(transcriptImagesOver({ ...under, sessionId: "nope" }, 50), false);
  // after the fold the same session has room again
  foldTranscriptImages({ ...at, minBytes: 0 });
  assert.equal(transcriptImagesOver(at, CLAUDE_IMAGE_LIMIT - CLAUDE_IMAGE_KEEP), false);
  // the word "image" in text is not an image
  const words = setup([userRow([{ type: "text", text: '"image" '.repeat(30) }], 1)]);
  assert.equal(transcriptImagesOver(words, 0), false);
});
