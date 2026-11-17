import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { contextMenuTemplate, createMediaDownloads, fileLink, mediaCopyName, mediaLink, savedName } from "./context-menu.mjs";

const CLOUD = "https://bright-otter.mausbot.cloud";
const VIDEO = `${CLOUD}/api/threads/t1/messages/m1/file?media=${"a".repeat(43)}`;
const editFlags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: true };
const base = { mediaType: "none", srcURL: "", hasImageContents: false, linkURL: "", isEditable: false, misspelledWord: "", dictionarySuggestions: [], selectionText: "", x: 12, y: 34, editFlags, pageURL: `${CLOUD}/` };

function harness() {
  const calls = [];
  const webContents = {
    copyImageAt: (x, y) => calls.push(["copyImageAt", x, y]),
    downloadURL: (url) => calls.push(["downloadURL", url]),
    reload: () => calls.push(["reload"]),
    replaceMisspelling: (word) => calls.push(["replaceMisspelling", word]),
    paste: () => calls.push(["paste"]),
  };
  const clipboard = { writeText: (text) => calls.push(["writeText", text]), availableFormats: () => [], readImage: () => ({ isEmpty: () => true }) };
  const downloads = { start: (contents, url, mode) => { assert.equal(contents, webContents); calls.push(["download", url, mode]); return true; } };
  const menu = (params) => contextMenuTemplate({ ...base, ...params }, { webContents, clipboard, downloads });
  return { calls, menu };
}

const labels = (items) => items.map((item) => item.type === "separator" ? "---" : item.label);
const click = (items, label) => items.find((item) => item.label === label).click();

test("a picture offers copy, Save Image As and Open in Default App through the window's session", () => {
  const { calls, menu } = harness();
  const items = menu({ mediaType: "image", hasImageContents: true, srcURL: `${CLOUD}/api/attachments/shot.png` });
  assert.deepEqual(labels(items), ["Copy Image", "Save Image As…", "Open in Default App"]);
  click(items, "Copy Image");
  click(items, "Save Image As…");
  click(items, "Open in Default App");
  assert.deepEqual(calls, [
    ["copyImageAt", 12, 34],
    ["download", `${CLOUD}/api/attachments/shot.png`, "save"],
    ["download", `${CLOUD}/api/attachments/shot.png`, "open"],
  ]);
});

test("a video or audio player offers Save As and Open in Default App for its streamed link or blob", () => {
  const { calls, menu } = harness();
  const video = menu({ mediaType: "video", srcURL: VIDEO });
  assert.deepEqual(labels(video), ["Save Video As…", "Open in Default App"]);
  click(video, "Open in Default App");
  assert.deepEqual(calls, [["download", VIDEO, "open"]]);
  assert.deepEqual(labels(menu({ mediaType: "audio", srcURL: `blob:${CLOUD}/0f8e` })), ["Save Audio As…", "Open in Default App"]);
});

test("media the session cannot download falls back to the plain menu instead of a dead right-click", () => {
  const { menu } = harness();
  assert.deepEqual(labels(menu({ mediaType: "video", srcURL: "file:///etc/passwd" })), ["Copy", "Select All", "---", "Reload"]);
  assert.deepEqual(labels(menu({ mediaType: "image", hasImageContents: true, srcURL: "" })), ["Copy Image"]);
});

test("a link keeps Copy Link and the text menu, and gains Save Link As only when it names a file", () => {
  const { calls, menu } = harness();
  const file = menu({ linkURL: "https://example.com/files/report.pdf" });
  assert.deepEqual(labels(file), ["Copy Link", "Save Link As…", "---", "Undo", "Redo", "---", "Cut", "Copy", "Paste", "Paste and Match Style", "---", "Select All"]);
  click(file, "Copy Link");
  click(file, "Save Link As…");
  assert.deepEqual(calls, [["writeText", "https://example.com/files/report.pdf"], ["download", "https://example.com/files/report.pdf", "save"]]);
  assert.deepEqual(labels(menu({ linkURL: "https://example.com/about" })).slice(0, 2), ["Copy Link", "---"]);
  assert.equal(fileLink("https://example.com/index.html"), false);
  assert.equal(fileLink(`${CLOUD}/api/threads/t1/messages/m1/file`), true);
  assert.equal(fileLink("openmausbot://bot/abc.def"), false);
  assert.equal(fileLink("mailto:someone@example.com"), false);
});

test("a link to a picture, video or audio file, or a chat player's link, also opens in the default app", () => {
  const { calls, menu } = harness();
  const items = menu({ linkURL: VIDEO });
  assert.deepEqual(labels(items).slice(0, 4), ["Copy Link", "Save Link As…", "Open in Default App", "---"]);
  click(items, "Open in Default App");
  assert.deepEqual(calls, [["download", VIDEO, "open"]]);
  assert.equal(mediaLink("https://example.com/clips/demo.MOV"), true);
  assert.equal(mediaLink("https://example.com/photo.jpeg"), true);
  assert.equal(mediaLink("https://example.com/files/report.pdf"), false);
  assert.equal(mediaLink(`${CLOUD}/api/threads/t1/messages/m1/file`), false);
  assert.equal(mediaLink("https://example.com/watch?v=1"), false);
});

test("an editable field and a spelling mistake keep the existing menu", () => {
  const { calls, menu } = harness();
  const editable = menu({ isEditable: true, editFlags: { ...editFlags, canCopy: true, canPaste: true } });
  assert.deepEqual(labels(editable), ["Undo", "Redo", "---", "Cut", "Copy", "Paste", "Paste and Match Style", "---", "Select All"]);
  assert.equal(editable.find((item) => item.label === "Paste").role, "paste");
  const spelling = menu({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "tea", "ten", "tech", "tee", "toe"] });
  assert.deepEqual(labels(spelling).slice(0, 6), ["the", "tea", "ten", "tech", "tee", "---"]);
  click(spelling, "the");
  assert.deepEqual(calls, [["replaceMisspelling", "the"]]);
  assert.deepEqual(labels(menu({ selectionText: "words" })).at(-1), "Select All");
});

test("a plain spot answers with Copy, Select All and Reload", () => {
  const { calls, menu } = harness();
  const items = menu({});
  assert.deepEqual(labels(items), ["Copy", "Select All", "---", "Reload"]);
  assert.equal(items[0].enabled, false);
  click(items, "Reload");
  assert.deepEqual(calls, [["reload"]]);
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-context-menu-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function downloadItem({ url = VIDEO, filename = "file", mime = "video/mp4" } = {}) {
  const item = new EventEmitter();
  Object.assign(item, {
    savePath: null, dialogOptions: null, cancelled: false,
    getURL: () => url, getURLChain: () => [url], getFilename: () => filename, getMimeType: () => mime,
    setSavePath(file) { this.savePath = file; },
    setSaveDialogOptions(options) { this.dialogOptions = options; },
    cancel() { this.cancelled = true; },
  });
  return item;
}

function mediaDownloads(dir, clock = { now: 1_000 }) {
  const opened = [], told = [], fetched = [];
  const downloads = createMediaDownloads({
    dialog: { showMessageBox: async (options) => told.push(options) },
    shell: { openPath: async (file) => { opened.push(file); return ""; } },
    openDir: () => path.join(dir, "open"),
    downloadsDir: () => path.join(dir, "Downloads"),
    now: () => clock.now,
  });
  const webContents = { downloadURL: (url) => fetched.push(url) };
  return { downloads, webContents, opened, told, fetched, clock };
}

test("Save As asks where to save, named for the video's type, and leaves other downloads to the app", () => {
  const { dir, done } = scratch();
  try {
    const { downloads, webContents, fetched } = mediaDownloads(dir);
    assert.equal(downloads.claim(downloadItem()), false);
    assert.equal(downloads.start(webContents, VIDEO, "save"), true);
    assert.deepEqual(fetched, [VIDEO]);
    const item = downloadItem();
    assert.equal(downloads.claim(item), true);
    assert.equal(item.savePath, null);
    assert.deepEqual(item.dialogOptions, { defaultPath: path.join(dir, "Downloads", "file.mp4") });
    assert.equal(downloads.claim(downloadItem()), false);
  } finally {
    done();
  }
});

test("Open in Default App saves a private copy with its type's extension, then opens it", async () => {
  const { dir, done } = scratch();
  try {
    const { downloads, webContents, opened } = mediaDownloads(dir);
    downloads.start(webContents, VIDEO, "open");
    const item = downloadItem({ filename: "clip.final.exe", mime: "video/quicktime" });
    assert.equal(downloads.claim(item), true);
    assert.equal(path.basename(item.savePath), "clip.final.mov");
    assert.ok(item.savePath.startsWith(path.join(dir, "open") + path.sep));
    item.emit("done", {}, "completed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, [item.savePath]);
    downloads.start(webContents, VIDEO, "open");
    const stopped = downloadItem();
    downloads.claim(stopped);
    stopped.emit("done", {}, "cancelled");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, [item.savePath]);
  } finally {
    done();
  }
});

test("Open in Default App refuses a file that is not a picture, video or audio", async () => {
  const { dir, done } = scratch();
  try {
    const { downloads, webContents, opened, told } = mediaDownloads(dir);
    const url = `${CLOUD}/api/attachments/shot.png`;
    downloads.start(webContents, url, "open");
    const item = downloadItem({ url, filename: "shot.png", mime: "text/html" });
    assert.equal(downloads.claim(item), true);
    assert.equal(item.cancelled, true);
    assert.equal(item.savePath, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, []);
    assert.equal(told[0].message, "This file can't be opened from here. Use Save As… instead.");
  } finally {
    done();
  }
});

test("a download started long ago, or from a URL the session cannot fetch, is not claimed", () => {
  const { dir, done } = scratch();
  try {
    const { downloads, webContents, fetched, clock } = mediaDownloads(dir);
    assert.equal(downloads.start(webContents, "file:///etc/passwd", "open"), false);
    assert.deepEqual(fetched, []);
    downloads.start(webContents, VIDEO, "open");
    clock.now += 61_000;
    assert.equal(downloads.claim(downloadItem()), false);
  } finally {
    done();
  }
});

test("names stay inside the folder and away from Windows device names", () => {
  assert.equal(mediaCopyName("../../evil/clip.mp4", ".mp4"), "clip.mp4");
  assert.equal(mediaCopyName("CON", ".png"), "_CON.png");
  assert.equal(mediaCopyName("", ".webm"), "media.webm");
  assert.equal(mediaCopyName('a<b>:"c|?*.jpg', ".jpg"), "abc.jpg");
  assert.equal(savedName(downloadItem({ filename: "report.pdf", mime: "application/pdf" })), "report.pdf");
  assert.equal(savedName(downloadItem({ filename: "", mime: "image/png" })), "download.png");
});
