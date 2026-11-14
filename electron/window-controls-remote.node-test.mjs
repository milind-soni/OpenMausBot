import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const LOCAL = "http://127.0.0.1:48993";
const REMOTE = "https://remote.example.test";
const preloadSource = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

function loadPreload(origin) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(preloadSource, {
    process: { platform: "win32", argv: [`--omb-local-origin=${LOCAL}`] },
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

// Windows hides the native caption buttons (titleBarStyle "hidden"), so a remote server's page must still be able to draw them.
test("a remote server's page gets the window controls, and they reach only the window channels", async () => {
  const remote = loadPreload(REMOTE);
  assert.deepEqual(Object.keys(remote.bridge.windowControls).sort(), ["close", "minimize", "onMaximizedChanged", "state", "toggleMaximize"]);
  await remote.bridge.windowControls.minimize();
  await remote.bridge.windowControls.toggleMaximize();
  await remote.bridge.windowControls.state();
  await remote.bridge.windowControls.close();
  assert.deepEqual(remote.invoked, [["window:minimize"], ["window:toggle-maximize"], ["window:state"], ["window:close"]]);
  assert.equal(remote.bridge.copyText, undefined, "local-only APIs stay off the remote bridge");
});

test("the local page keeps its window controls", () => {
  const local = loadPreload(LOCAL);
  assert.equal(typeof local.bridge.windowControls.minimize, "function");
});
