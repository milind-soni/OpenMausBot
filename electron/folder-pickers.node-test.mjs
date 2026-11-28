import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installFolderPickers } from "./folder-pickers.mjs";
import localOrigin from "./local-origin.cjs";

const ORIGIN = "http://127.0.0.1:48993";

function picker(t, choose, remote = false) {
  const handlers = new Map();
  const calls = [];
  const frame = { url: `${ORIGIN}/` };
  const sender = { mainFrame: frame, getURL: () => frame.url };
  const win = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  localOrigin.setLocalOrigin(ORIGIN);
  t.after(() => localOrigin.setLocalOrigin(null));
  installFolderPickers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async (...args) => { calls.push(args); return choose(); } },
    windowFor: () => win,
    mainWindow: () => win,
    remote: () => remote,
    t: (key) => key,
  });
  return { choose: handlers.get("desktop:pick-skill-folder"), workingFolder: handlers.get("desktop:pick-folder"), calls, event, win };
}

test("cancelling the skill folder picker returns null", async (t) => {
  const p = picker(t, () => ({ canceled: true, filePaths: [] }));
  assert.equal(await p.choose(p.event), null);
  assert.deepEqual(p.calls, [[p.win, { properties: ["openDirectory"] }]]);
});

test("a selected skill folder returns its relative files and skipped entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omb-skill-picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "references"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
  await writeFile(join(root, "references", "data.bin"), Buffer.from([0, 255]));
  await writeFile(join(root, ".git", "config"), "ignored");
  const p = picker(t, () => ({ canceled: false, filePaths: [root] }));
  const result = await p.choose(p.event);
  assert.deepEqual(result.files.map(({ path }) => path), ["SKILL.md", "references/data.bin"]);
  assert.deepEqual(Buffer.from(result.files[1].base64, "base64"), Buffer.from([0, 255]));
  assert.deepEqual(result.skipped, [{ path: ".git/", reason: "hidden" }]);
  assert.equal(result.skippedCount, 1);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("only the local main app frame can open the skill picker", async (t) => {
  const p = picker(t, () => ({ canceled: true, filePaths: [] }));
  const remoteFrame = { url: "https://remote.example/" };
  assert.throws(() => p.choose({ sender: p.event.sender, senderFrame: remoteFrame }), /only available while using the local server/);
  await assert.rejects(p.choose({ sender: p.event.sender, senderFrame: { url: `${ORIGIN}/` } }), /main app window/);
  const other = { mainFrame: { url: `${ORIGIN}/` } };
  await assert.rejects(p.choose({ sender: other, senderFrame: other.mainFrame }), /main app window/);
  assert.deepEqual(p.calls, []);
  const remote = picker(t, () => { throw new Error("picker must not open"); }, true);
  assert.equal(await remote.choose(remote.event), null);
});

test("does not return selected files after the local page navigates away", async (t) => {
  let finish;
  const selection = new Promise((resolve) => { finish = resolve; });
  const p = picker(t, () => selection);
  const pending = p.choose(p.event);
  p.event.senderFrame.url = "https://remote.example/";
  finish({ canceled: false, filePaths: ["/unreadable"] });
  assert.equal(await pending, null);
});

test("working-folder picker still passes its current folder to the native dialog", async (t) => {
  const p = picker(t, () => ({ canceled: false, filePaths: ["/chosen"] }));
  assert.equal(await p.workingFolder(p.event, "/current"), "/chosen");
  assert.deepEqual(p.calls, [[p.win, {
    title: "native.picker.workingFolder", properties: ["openDirectory", "createDirectory"], defaultPath: "/current",
  }]]);
});
