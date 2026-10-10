import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";

// "Open the sign-in page again" crosses two boundaries: the preload bridge and
// the main-process IPC handler. Both run from their real sources here without
// Electron; the managed-desktop client behind them is a synthetic stub, and its
// own reopen rules are covered in managed-desktop.node-test.mjs.
const ORIGIN = "http://127.0.0.1:48993";

function preload({ company = true } = {}) {
  const invoked = [];
  let bridge;
  const context = vm.createContext({
    process: { platform: "fixture", argv: [`--omb-local-origin=${ORIGIN}`, ...(company ? ["--omb-company-desktop=1"] : [])] },
    location: { origin: ORIGIN }, TextEncoder, localStorage: { getItem: () => null },
    require: name => {
      assert.equal(name, "electron");
      return { webUtils: {}, contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: {
        on: () => {}, removeListener: () => {}, send: () => {},
        invoke: (...args) => { invoked.push(args); return Promise.resolve({ status: "connecting" }); },
      } };
    },
  });
  vm.runInContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), context);
  return { bridge, invoked };
}

test("the preload bridge reopens with no renderer-supplied address, and only on the company desktop", async () => {
  const f = preload();
  await f.bridge.organization.reopen("https://attacker.example.test", { verificationUri: "https://attacker.example.test" });
  assert.deepEqual(f.invoked, [["organization:reopen"]]);
  assert.equal(preload({ company: false }).bridge.organization, undefined);
});

const mainSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
function section(start, end) {
  const from = mainSource.indexOf(start), to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Main-process test section moved: ${start}`);
  return mainSource.slice(from, to);
}
const registrations = section("const workspaceOnly =", 'ipcMain.on("company-backups:client-state"');

function main() {
  const handlers = new Map(), calls = [];
  const frame = { url: `${ORIGIN}/` }, contents = { mainFrame: frame };
  const client = { reopen: (...args) => { calls.push(args); return { status: "connecting" }; } };
  localOrigin.setLocalOrigin(ORIGIN);
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    mainWindow: { webContents: contents }, rendererOrigin: () => ORIGIN, environmentsState: { environments: [], activeId: "local" },
    ensureManagedDesktop: () => client, organizationEntry: {},
  });
  vm.runInContext(registrations, context, { filename: "main.mjs (organization IPC fixture)" });
  return { handlers, calls, context, event: { sender: contents, senderFrame: frame } };
}

test("organization:reopen passes nothing from the renderer to the managed-desktop client", async () => {
  const f = main();
  assert.deepEqual(await f.handlers.get("organization:reopen")(f.event, "https://attacker.example.test"), { status: "connecting" });
  assert.deepEqual(f.calls, [[]]);
});

test("organization:reopen answers only the local main window's exact main frame", () => {
  const f = main();
  const reopen = sender => f.handlers.get("organization:reopen")(sender);
  const subframe = { sender: f.event.sender, senderFrame: { url: `${ORIGIN}/embedded` } };
  const anotherWindow = { sender: { mainFrame: f.event.senderFrame }, senderFrame: f.event.senderFrame };
  const external = { sender: f.event.sender, senderFrame: { url: "https://untrusted.example.test/" } };
  for (const sender of [subframe, anotherWindow, external, { sender: f.event.sender }]) assert.throws(() => reopen(sender), /only available/);
  f.context.environmentsState = { activeId: "remote", environments: [{ id: "remote", origin: "https://workspace.example.test", name: "Remote" }] };
  assert.throws(() => reopen({ sender: f.event.sender, senderFrame: { url: "https://workspace.example.test/" } }), /only available/);
  assert.deepEqual(f.calls, []);
});
