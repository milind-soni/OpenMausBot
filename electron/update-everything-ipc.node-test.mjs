import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";

const origin = "http://127.0.0.1:48993";
function preload(remote) {
  let bridge; const calls = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "fixture", argv: [`--omb-local-origin=${origin}`] },
    location: { origin: remote ? "https://remote.invalid" : origin }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { calls.push(args); return Promise.resolve({}); } } }),
  });
  return { bridge, calls };
}
test("only local pages get the update-all bridge; no origins or commands cross it", async () => {
  const f = preload(false);
  await f.bridge.updateEverything.state({ origin: "https://untrusted.invalid" });
  await f.bridge.updateEverything.check({ command: "anything" });
  await f.bridge.updateEverything.run("native-plan", { origin: "https://untrusted.invalid" });
  assert.deepEqual(f.calls, [["updates-all:state"], ["updates-all:check"], ["updates-all:run", "native-plan"]]);
  assert.equal(preload(true).bridge.updateEverything, undefined);
});

test("native handlers reject other windows, subframes and remote pages", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const workspaceOnly =");
  const end = source.indexOf("// Personal Cloud authority stays in main.", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(); const calls = [];
  const frame = { url: `${origin}/` }; const contents = { mainFrame: frame };
  localOrigin.setLocalOrigin(origin);
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    mainWindow: { webContents: contents }, environmentsState: { environments: [], activeId: "local" }, rendererOrigin: () => origin,
    path: { join: () => "/fixture/receipt" }, app: { getPath: () => "/fixture", getVersion: () => "1" },
    fs: { readFileSync: () => { throw new Error("no receipt"); } },
    createUpdateEverything: () => Object.fromEntries(["state", "check", "run"].map(method => [method, (...args) => calls.push([method, ...args])])),
  });
  for (const method of ["state", "check", "run"]) {
    const handler = handlers.get(`updates-all:${method}`);
    handler({ sender: contents, senderFrame: frame }, "native-plan", { command: "bad" });
    for (const sender of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url: `${origin}/frame` } },
      { sender: contents, senderFrame: { url: "https://remote.invalid" } }, { sender: contents }]) assert.throws(() => handler(sender), /only available/);
  }
  assert.deepEqual(calls, [["state"], ["check"], ["run", "native-plan"]]);
});
