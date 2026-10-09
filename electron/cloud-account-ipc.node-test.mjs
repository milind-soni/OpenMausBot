import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";

const origin = "http://127.0.0.1:48993", methods = ["state", "begin", "signInAgain", "reopen", "cancel", "refresh", "signOut", "openDashboard", "offer"];
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
test("a checkout from the page carries only a plan and a source, as text; the server menu only 'howto'", async () => {
  const f = preload();
  await f.bridge.cloudAccount.checkout("pro", "app_card", { origin: "https://evil.example.test", paid: true });
  await f.bridge.cloudAccount.checkout({ toString: () => "max" }, undefined);
  await f.bridge.workspaces.menu({ from: "howto", origin: "https://evil.example.test" });
  await f.bridge.workspaces.menu({ from: "elsewhere" });
  await f.bridge.workspaces.menu();
  assert.deepEqual(f.invoked, [["cloud-account:checkout", "pro", "app_card"], ["cloud-account:checkout", "max", "undefined"],
    ["workspaces:menu", "howto"], ["workspaces:menu"], ["workspaces:menu"]]);
});
test("main opens a checkout only for a plan the offer sells now and one of this app's sources, where Cloud is offered", async () => {
  const { CHECKOUT_SOURCES } = await import("./cloud-account.mjs");
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), start = source.indexOf("const workspaceOnly ="), end = source.indexOf('ipcMain.handle("organization:settings-opened"', start);
  const handlers = new Map(), calls = [], frame = { url: `${origin}/` }, contents = { mainFrame: frame };
  localOrigin.setLocalOrigin(origin);
  let allowed = true;
  const offer = { plans: [{ tier: "personal", amount: 2900 }, { tier: "pro", amount: 4900, trialDays: 7 }], recommended: "pro" };
  const context = vm.createContext({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed, mainWindow: { webContents: contents },
    rendererOrigin: () => origin, environmentsState: { environments: [], activeId: "local" }, CHECKOUT_SOURCES, cloudOffersReady: async () => allowed,
    ensureCloudAccount: () => ({ offer: async () => offer, checkout: async (...args) => { calls.push(args); return { outcome: "opened", state: { status: "connected" } }; } }),
    connectCloudHome: () => ({ status: "connected" }),
  });
  vm.runInContext(source.slice(start, end), context);
  const handle = handlers.get("cloud-account:checkout"), event = { sender: contents, senderFrame: frame };
  assert.deepEqual(await handle(event, "pro", "app_card"), { outcome: "opened", state: { status: "connected" } });
  for (const [plan, from] of [["max", "app_card"], ["team", "app_menu"], ["pro", "site_pro"], ["pro", "cloud_page"], [{ tier: "pro" }, "app_card"], ["pro", undefined]]) {
    await assert.rejects(handle(event, plan, from), /Choose a plan/, `${plan} ${from}`);
  }
  assert.throws(() => handle({ sender: contents, senderFrame: { url: "https://remote.example.test/" } }, "pro", "app_card"), /only available/);
  allowed = false;
  await assert.rejects(handle(event, "pro", "app_card"), /isn't offered/);
  assert.deepEqual(calls, [["pro", "app_card"]]);
});
