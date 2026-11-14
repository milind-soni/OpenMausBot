import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const origin = "http://127.0.0.1:48992";
function load({ remote, active = true }) {
  const invoked = [];
  let bridge;
  const context = vm.createContext({
    process: { platform: "fixture", argv: [`--omb-local-origin=${origin}`, "--omb-company-desktop=1"] },
    location: { origin: remote ? "https://omb-u-aaaaaaaaaaaa.fly.dev" : origin }, TextEncoder,
    navigator: { userActivation: { isActive: active } },
    localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: {
      on: () => {}, removeListener: () => {}, send: () => {}, sendSync: () => false,
      invoke: (...args) => { invoked.push(args); return Promise.resolve(null); },
    } }),
  });
  vm.runInContext(source, context);
  return { bridge, invoked };
}

test("the My Cloud page gets no Files bridge at all", () => {
  const remote = load({ remote: true });
  assert.equal(remote.bridge.cloudAccount, undefined);
  assert.equal(remote.bridge.cloudSync, undefined);
});

test("this computer's own window gets the Files controls", async () => {
  const local = load({ remote: false });
  await local.bridge.cloudAccount.files.share("token-1");
  assert.deepEqual(local.invoked.at(-1), ["files:share", "token-1"]);
  await local.bridge.cloudAccount.files.answerDeletes("f1", true);
  assert.deepEqual(local.invoked.at(-1), ["files:deletes", "f1", true]);
});
