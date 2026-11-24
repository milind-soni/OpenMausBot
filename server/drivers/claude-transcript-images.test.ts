import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "vitest";

import { CLAUDE_IMAGE_KEEP, CLAUDE_IMAGE_LIMIT, FOLD_BACKUP_SUFFIX, foldTranscriptImages, imageFoldTarget, imagesToKeep, transcriptImagesOver, transcriptPath } from "./claude-transcript-images.ts";

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
  const result = foldTranscriptImages({ configDir, cwd, sessionId });
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
  assert.deepEqual(foldTranscriptImages({ configDir: few.configDir, cwd: few.cwd, sessionId: few.sessionId }), { total: 2, folded: 0 });
  const before = readFileSync(few.file, "utf8");

  const many = setup(Array.from({ length: 20 }, (_, i) => toolResult(i + 1)));
  assert.equal(foldTranscriptImages({ configDir: many.configDir, cwd: many.cwd, sessionId: many.sessionId }).folded, 20 - CLAUDE_IMAGE_KEEP);
  assert.equal(count(readFileSync(many.file, "utf8"), '"type":"image"'), CLAUDE_IMAGE_KEEP);
  assert.equal(readFileSync(few.file, "utf8"), before);
});

test("a missing transcript is a no-op, and a folded one is not folded again", () => {
  const { configDir, cwd } = setup([]);
  assert.equal(foldTranscriptImages({ configDir, cwd, sessionId: "nope" }).skipped, "missing");

  const rows = Array.from({ length: 21 }, (_, i) => userRow([image(i)], i));
  const one = setup(rows);
  assert.equal(foldTranscriptImages({ configDir: one.configDir, cwd: one.cwd, sessionId: one.sessionId }).folded, 21 - CLAUDE_IMAGE_KEEP);
  const again = foldTranscriptImages({ configDir: one.configDir, cwd: one.cwd, sessionId: one.sessionId });
  assert.deepEqual(again, { total: CLAUDE_IMAGE_KEEP, folded: 0 });
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
  foldTranscriptImages({ ...at });
  assert.equal(transcriptImagesOver(at, CLAUDE_IMAGE_LIMIT - CLAUDE_IMAGE_KEEP), false);
  // the word "image" in text is not an image
  const words = setup([userRow([{ type: "text", text: '"image" '.repeat(30) }], 1)]);
  assert.equal(transcriptImagesOver(words, 0), false);
});

test("a small transcript is folded too: size says nothing about how many images it holds", () => {
  const { file, ...options } = setup(Array.from({ length: 25 }, (_, i) => userRow([image(i)], i)));
  assert.ok(statSync(file).size < 16 * 1024);
  assert.equal(foldTranscriptImages(options).folded, 25 - CLAUDE_IMAGE_KEEP);
});

test("the turn's own images get room: 16 held and 5 new keep 15, even after a fold that kept 16", () => {
  const { file, ...options } = setup(Array.from({ length: CLAUDE_IMAGE_KEEP + 2 }, (_, i) => userRow([image(i)], i)));
  assert.equal(foldTranscriptImages(options).folded, 2);
  assert.equal(transcriptImagesOver(options, 5), true);
  assert.deepEqual(foldTranscriptImages({ ...options, incoming: 5 }), { total: CLAUDE_IMAGE_KEEP, folded: 1 });
  assert.equal(count(readFileSync(file, "utf8"), '"type":"image"'), CLAUDE_IMAGE_LIMIT - 5);
  assert.equal(transcriptImagesOver(options, 5), false);
  assert.equal(imagesToKeep(0), CLAUDE_IMAGE_KEEP);
  assert.equal(imagesToKeep(30), 0);
});

test("the transcript is found where Claude Code writes it: a linked working directory, and a path over 200 characters", () => {
  const base = mkdtempSync(join(tmpdir(), "claude-images-"));
  const configDir = join(base, ".claude-api");
  const rows = Array.from({ length: 21 }, (_, i) => userRow([image(i)], i)).join("\n");
  // the folder named after the resolved directory (the CLI resolves links, on macOS even /tmp to /private/tmp), built
  // here by the CLI's own rule rather than through transcriptPath
  const real = join(base, "real");
  mkdirSync(real);
  const link = join(base, "link");
  symlinkSync(real, link);
  const linked = join(configDir, "projects", realpathSync.native(real).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, "s1.jsonl"), rows);
  assert.equal(transcriptImagesOver({ configDir, cwd: link, sessionId: "s1" }), true);
  assert.equal(foldTranscriptImages({ configDir, cwd: link, sessionId: "s1" }).folded, 21 - CLAUDE_IMAGE_KEEP);
  // a long working directory: the CLI cuts the folder name at 200 characters and appends a hash of the resolved path
  const suffix = (path: string) => {
    let hash = 0;
    for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(36);
  };
  const long = mkdtempSync(join(tmpdir(), "claude-images-")) + "/" + "deep/".repeat(50) + "thread";
  mkdirSync(long, { recursive: true });
  const resolvedLong = realpathSync.native(long).normalize("NFC"); // as the CLI resolves it: on Windows the long name, not an 8.3 short one
  assert.ok(resolvedLong.length > 200);
  const longName = transcriptPath(configDir, long, "s1");
  assert.equal(longName, join(configDir, "projects", `${resolvedLong.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200)}-${suffix(resolvedLong)}`, "s1.jsonl"));
  // the CLI's own shape: the cut name, then '-' and a short base-36 hash
  assert.equal(basename(dirname(longName)).length, 200 + 1 + suffix(resolvedLong).length);
  assert.match(basename(dirname(longName)), /-[0-9a-z]+$/);
  // reached through a link, the same folder: the resolution happens inside transcriptPath
  const longLink = join(dirname(long), "link-" + basename(long).slice(0, 40));
  symlinkSync(long, longLink);
  assert.equal(transcriptPath(configDir, longLink, "s1"), longName);
  // a working directory that is gone: named after the path as given, hashed the same way
  const gone = "/" + "deep/".repeat(50) + "thread";
  assert.equal(transcriptPath(configDir, gone, "s1"), join(configDir, "projects", `${gone.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200)}-${suffix(gone)}`, "s1.jsonl"));
});

test("a transcript that cannot be read keeps the warm process and costs the turn nothing", () => {
  const options = setup([]);
  const unreadable = { configDir: options.configDir, cwd: options.cwd, sessionId: "dir" };
  mkdirSync(transcriptPath(options.configDir, options.cwd, "dir"));     // something there, but not a file
  assert.equal(transcriptImagesOver(unreadable, 25), false);
  assert.equal(foldTranscriptImages(unreadable).skipped, "missing");
});

test("only a custom Anthropic-compatible endpoint is folded: never first-party Anthropic, Bedrock, company access or a Claude account", () => {
  const endpoint = { endpointModels: ["deepseek-chat"], configDir: "/data/providers/claude-1" };
  const env = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", CLAUDE_CONFIG_DIR: "/data/providers/claude-1" };
  assert.deepEqual(imageFoldTarget(endpoint, env, "/work"), { configDir: "/data/providers/claude-1", cwd: "/work" });
  // an endpoint entry pointed at Anthropic itself, in any spelling
  for (const url of ["https://api.anthropic.com", "https://API.Anthropic.com/", "https://api.anthropic.com./v1", "https://anthropic.com"]) {
    assert.equal(imageFoldTarget(endpoint, { ...env, ANTHROPIC_BASE_URL: url }, "/work"), undefined, url);
  }
  assert.equal(imageFoldTarget(endpoint, { ...env, ANTHROPIC_BASE_URL: undefined }, "/work"), undefined);
  assert.equal(imageFoldTarget(endpoint, { ...env, ANTHROPIC_BASE_URL: "not a url" }, "/work"), undefined);
  assert.equal(imageFoldTarget({ ...endpoint, bedrock: true }, env, "/work"), undefined);
  assert.equal(imageFoldTarget({ ...endpoint, managed: true }, env, "/work"), undefined);
  // a Claude account with its own folder, or the default Claude, even with a base URL in its environment
  assert.equal(imageFoldTarget({ configDir: "/data/providers/claude-1" }, env, "/work"), undefined);
  assert.equal(imageFoldTarget({}, env, "/work"), undefined);
  assert.equal(imageFoldTarget(endpoint, { ...env, CLAUDE_CONFIG_DIR: undefined }, "/work"), undefined);
});

test("a fold keeps the transcript as it was beside it, rewrites only the rows that lost an image, and leaves no temp file", () => {
  // the CLI's own spacing and key order, which a rewrite of every row would lose
  const plain = (n: number) => `{"type":"assistant", "message":{"content":[{"type":"text","text":"answer ${n}"}]}}`;
  const rows = Array.from({ length: 21 }, (_, i) => [userRow([image(i)], i), plain(i)]).flat();
  const { file, ...options } = setup(rows);
  const before = readFileSync(file, "utf8");
  assert.equal(foldTranscriptImages(options).folded, 21 - CLAUDE_IMAGE_KEEP);
  assert.equal(readFileSync(`${file}${FOLD_BACKUP_SUFFIX}`, "utf8"), before);
  assert.ok(!`${file}${FOLD_BACKUP_SUFFIX}`.endsWith(".jsonl"));
  const after = readFileSync(file, "utf8").split("\n"), was = before.split("\n");
  assert.equal(after.length, was.length);
  const differ = after.flatMap((line, index) => (line === was[index] ? [] : [index]));
  // only the first five user rows (even lines) changed; every assistant row is byte for byte the same
  assert.deepEqual(differ, [0, 2, 4, 6, 8]);
  assert.deepEqual(readdirSync(dirname(file)).sort(), [`${options.sessionId}.jsonl`, `${options.sessionId}.jsonl${FOLD_BACKUP_SUFFIX}`].sort());
  assert.equal(statSync(file).mode, statSync(`${file}${FOLD_BACKUP_SUFFIX}`).mode);
});

test("counts only the images a request sends: the copy the CLI keeps beside a tool result is neither counted nor changed", () => {
  const mirrored = (n: number) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: [image(n)] }] }, toolUseResult: [image(n)] });
  const at = setup(Array.from({ length: CLAUDE_IMAGE_LIMIT }, (_, i) => mirrored(i)));
  assert.equal(transcriptImagesOver(at), false);
  const over = setup(Array.from({ length: CLAUDE_IMAGE_LIMIT + 1 }, (_, i) => mirrored(i)));
  assert.equal(foldTranscriptImages(over).folded, CLAUDE_IMAGE_LIMIT + 1 - CLAUDE_IMAGE_KEEP);
  const first = JSON.parse(readFileSync(over.file, "utf8").split("\n")[0]!);
  assert.match(first.message.content[0].content[0].text, /Earlier image/);
  assert.equal(first.toolUseResult[0].type, "image");
});

test("a session id that is not one is never looked up", () => {
  const { configDir, cwd } = setup(Array.from({ length: 25 }, (_, i) => userRow([image(i)], i)));
  assert.equal(foldTranscriptImages({ configDir, cwd, sessionId: "../s1" }).skipped, "missing");
  assert.equal(transcriptImagesOver({ configDir, cwd, sessionId: "../s1" }, 25), false);
  assert.ok(!existsSync(join(configDir, "projects", `s1.jsonl${FOLD_BACKUP_SUFFIX}`)));
});
