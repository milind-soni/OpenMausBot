import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";

const origin = "http://127.0.0.1:48993", methods = ["state", "begin", "signInAgain", "reopen", "cancel", "refresh", "signOut", "openDashboard"];
const bridgeMethods = [...methods, "connectHome", "connectHomeForPhone"];
function preload({ enabled = true, remote = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "fixture", argv: [`--omb-local-origin=${origin}`, ...(enabled ? ["--omb-company-desktop=1"] : [])] },
    location: { origin: remote ? "https://remote.example.test" : origin }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve({ status: "signed-out" }); } } }),
  });
  return { bridge, invoked };
}
test("personal Cloud bridge is desktop-local, contains no capability access, and discards all renderer arguments", async () => {
  const f = preload();
  for (const method of bridgeMethods) await f.bridge.cloudAccount[method]({ origin: "https://evil.example.test", paid: true, accessToken: "forged", code: "ABCD-EFGH-JKLM" });
  assert.deepEqual(f.invoked, bridgeMethods.map(method => [`cloud-account:${method}`]));
  assert.equal(f.bridge.cloudAccount.connection, undefined);
  assert.equal(preload({ enabled: false }).bridge.cloudAccount, undefined);
  assert.equal(preload({ remote: true }).bridge.cloudAccount, undefined);
});
test("production personal Cloud IPC guards exact local main frame and forwards no arguments", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), start = source.indexOf("const workspaceOnly ="), end = source.indexOf('ipcMain.handle("organization:settings-opened"', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(), calls = [], frame = { url: `${origin}/` }, contents = { mainFrame: frame };
  localOrigin.setLocalOrigin(origin);
  const context = vm.createContext({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed, mainWindow: { webContents: contents },
    rendererOrigin: () => origin, environmentsState: { environments: [], activeId: "local" },
    ensureCloudAccount: () => Object.fromEntries(methods.map(method => [method, (...args) => { calls.push([method, ...args]); return { status: "signed-out" }; }])),
    connectCloudHome: (...args) => { calls.push(["connectHome", ...args]); return { status: "connected" }; },
  });
  vm.runInContext(source.slice(start, end), context);
  for (const method of bridgeMethods) {
    const handle = handlers.get(`cloud-account:${method}`);
    await handle({ sender: contents, senderFrame: frame }, { paid: true });
    for (const sender of [{ sender: contents, senderFrame: { url: `${origin}/subframe` } }, { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: "https://remote.example.test" } }, { sender: contents }]) assert.throws(() => handle(sender), /only available/);
  }
  // connectHomeForPhone forwards only its own fixed "phone", never what the page sent.
  assert.deepEqual(calls, bridgeMethods.map(method => method === "connectHomeForPhone" ? ["connectHome", "phone"] : [method]));
});
