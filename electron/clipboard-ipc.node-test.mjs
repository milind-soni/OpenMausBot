import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { writeClipboardText } from "./clipboard-write.mjs";

const require = createRequire(import.meta.url);
const localOrigin = require("./local-origin.cjs");

const LOCAL = "http://127.0.0.1:48993";
const REMOTE = "https://remote.example.test";
const preloadSource = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

function loadPreload(origin) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(preloadSource, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`] },
    location: { origin },
    navigator: {},
    TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve(true); } },
    }),
  });
  return { bridge, invoked };
}

test("a remote server's page gets no copyText and can never reach the clipboard channel", async () => {
  const remote = loadPreload(REMOTE);
  assert.equal(remote.bridge.copyText, undefined);
  assert.equal("ipcRenderer" in remote.bridge, false);
  assert.deepEqual(remote.invoked, []);
  // The allow-list itself must not name it either.
  const safe = preloadSource.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]\)/);
  assert.ok(safe, "REMOTE_SAFE is still declared as a literal set");
  assert.equal(safe[1].includes("copyText"), false);
});

test("the local page's copyText sends only the text, on the one explicit channel", async () => {
  const local = loadPreload(LOCAL);
  assert.equal(typeof local.bridge.copyText, "function");
  await local.bridge.copyText("hello", { channel: "evil:other" });
  assert.deepEqual(local.invoked, [["clipboard:write-text", "hello"]]);
});

// Runs the production registration line from main.mjs against the real
// localOnly wrapper and the real writeClipboardText, with a fake ipcMain.
function productionHandler() {
  const lines = mainSource.split("\n").filter((line) => line.includes('"clipboard:write-text"'));
  assert.equal(lines.length, 1, "exactly one registration of the channel in main.mjs");
  assert.match(lines[0], /^ipcMain\.handle\("clipboard:write-text", localOnly\("clipboard:write-text", /);
  const handlers = new Map();
  const written = [];
  vm.runInNewContext(lines[0], {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly,
    writeClipboardText,
    clipboard: { writeText: (text) => written.push(text) },
  });
  assert.deepEqual([...handlers.keys()], ["clipboard:write-text"]);
  return { handler: handlers.get("clipboard:write-text"), written };
}
const from = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });

test("an untrusted sender is rejected before writeClipboardText runs", async () => {
  const { handler, written } = productionHandler();
  localOrigin.setLocalOrigin(null);
  assert.throws(() => handler(from(`${LOCAL}/`), "hello"), /only available while using the local server/, "origin not known yet: fail closed");
  localOrigin.setLocalOrigin(LOCAL);
  for (const event of [
    from(`${REMOTE}/`),
    from("http://127.0.0.1:48994/"),
    from("about:blank"),
    { senderFrame: { url: "" }, sender: { mainFrame: {}, getURL: () => `${LOCAL}/` } }, // empty child frame
    {},
  ]) {
    assert.throws(() => handler(event, "hello"), /only available while using the local server/);
  }
  assert.deepEqual(written, []);
});

test("the local page reaches the clipboard, and bad payloads still do not", async () => {
  const { handler, written } = productionHandler();
  localOrigin.setLocalOrigin(LOCAL);
  assert.equal(await handler(from(`${LOCAL}/chat`), "hello"), true);
  for (const bad of [undefined, 42, {}, "", "  "]) assert.equal(await handler(from(`${LOCAL}/`), bad), false);
  assert.deepEqual(written, ["hello"]);
});
