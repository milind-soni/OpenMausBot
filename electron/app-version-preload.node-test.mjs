import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LOCAL = "http://127.0.0.1:8799";

function app(origin, argv = [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1", "--omb-app-version=0.1.127"]) {
  let bridge;
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv },
    location: { origin }, navigator: { userActivation: { isActive: false } }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: () => undefined, invoke: () => Promise.resolve() } }),
  });
  return bridge.app ? { ...bridge.app } : undefined;
}

test("every page in the window learns this app's own version, and only this computer's page counts as this app's own", () => {
  assert.deepEqual(app(LOCAL), { version: "0.1.127", ownPage: true });
  assert.deepEqual(app("https://bots.example.test"), { version: "0.1.127", ownPage: false }, "a server added in the Server menu");
  assert.deepEqual(app("https://home-7f3k2.fly.dev"), { version: "0.1.127", ownPage: false }, "My Cloud");
  assert.equal(app(LOCAL, [`--omb-local-origin=${LOCAL}`]).version, "", "no version passed: About keeps the page's own");
});

test("main passes the app's version to the window it opens", () => {
  const start = MAIN.indexOf("additionalArguments: [");
  assert.ok(start >= 0);
  assert.ok(MAIN.slice(start, MAIN.indexOf("],\n", start)).includes("`--omb-app-version=${app.getVersion()}`"));
});
