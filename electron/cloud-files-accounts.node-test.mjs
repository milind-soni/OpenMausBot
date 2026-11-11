import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { filesFolderOf, installCloudFiles } from "./cloud-sync-main.mjs";

const scratch = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-files-accounts-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test("the first account keeps Files' folder as it was; another gets one of its own", (t) => {
  const root = scratch(t);
  assert.equal(filesFolderOf(root, "acct-a"), root, "an upgrade changes nothing for the account that set Files up");
  assert.equal(filesFolderOf(root, "acct-a"), root);
  const b = filesFolderOf(root, "acct-b");
  assert.notEqual(b, root);
  assert.ok(b.startsWith(path.join(root, "accounts")));
  assert.ok(!b.includes("acct-b"), "no account id in a path");
  assert.notEqual(filesFolderOf(root, "acct-c"), b);
});

test("a folder one account shares is never registered on another's Cloud: each account's Files have their own settings, and the one before is closed", (t) => {
  const root = scratch(t), opened = [];
  const makeService = (options) => {
    const service = { settingsFile: options.settingsFile, closed: false, started: 0, start() { this.started++; }, close() { this.closed = true; }, running: () => false, state: () => ({}), wake() {} };
    opened.push(service);
    return service;
  };
  const files = installCloudFiles({ app: { getPath: () => root }, ipcMain: { handle() {} }, dialog: {}, shell: {}, powerMonitor: { on() {} }, fetch: async () => new Response("{}"), localWorkspaceOnly: (_channel, handler) => handler,
    send() {}, cloudOrigin: () => null, cloudAccount: () => ({ state: () => null }), localDataDir: root, makeService, stateDir: "cloud-sync" });
  files.start();
  files.accountChanged("acct-a");
  assert.equal(opened.length, 1, "the first account stays in the folder that was open");
  files.accountChanged("acct-a");
  assert.equal(opened.length, 1, "nothing changed");
  files.accountChanged(null);
  assert.equal(opened.length, 1, "signed out: its Files wait");
  files.accountChanged("acct-b");
  assert.equal(opened.length, 2);
  assert.equal(opened[0].closed, true);
  assert.notEqual(opened[1].settingsFile, opened[0].settingsFile, "B starts from its own settings, with none of A's shared folders");
  assert.equal(opened[1].started, 1);
  files.accountChanged("acct-a");
  assert.equal(opened[2].settingsFile, opened[0].settingsFile, "A's come back as they were");
  files.close();
});
