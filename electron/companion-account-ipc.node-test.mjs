import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { managedEndpointNeed } from "./companion-account-service.mjs";
import localOrigin from "./local-origin.cjs";

const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `main.mjs no longer has ${from}`);
  return source.slice(start, end);
};

test("the desktop holds its address on demand, read from the running companion", async () => {
  let options;
  let running = false;
  let answer = async () => ({ enabled: true, devices: [], pairing: null });
  const stateReads = [];
  const context = vm.createContext({
    companionAccountService: null,
    resolveCompanionControlPlaneURL: () => "",
    createControlPlaneClient: () => null,
    createCompanionAccountService: (passed) => {
      options = passed;
      return { fixture: true };
    },
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    process: { env: {}, platform: "darwin" },
    installationDisplayName: () => "Fixture Mac",
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    secureCredentialState: null,
    secureCredentials: {},
    updateSecureCredentialDocument: async () => {},
    activatePersistedManagedCompanionEndpoint: async () => ({}),
    stopManagedCompanionEndpointLocally: async () => ({}),
    publicManagedCompanionState: () => ({ status: "stopped", ready: false }),
    companionDesiredThisLaunch: false,
    slog: () => {},
    companionRunning: () => running,
    companionState: () => {
      stateReads.push(1);
      return answer();
    },
    managedEndpointNeed,
  });
  vm.runInContext(`${slice("function ensureCompanionAccountService()", "const gatherDiagnostics = ")}
    globalThis.ensure = ensureCompanionAccountService;`, context);
  context.ensure();

  assert.equal(options.onDemand, true);
  assert.equal(options.autoRecover, true);
  assert.equal(await options.managedEndpointNeeded(), null);
  assert.equal(stateReads.length, 0);

  running = true;
  assert.equal(await options.managedEndpointNeeded(), false);
  answer = async () => ({ enabled: true, devices: [{ id: "phone-1" }], pairing: null });
  assert.equal(await options.managedEndpointNeeded(), true);
  answer = async () => ({ enabled: true, devices: [], pairing: null, devicesUnreadable: true });
  assert.equal(await options.managedEndpointNeeded(), null);
  answer = async () => {
    throw new Error("control port closed");
  };
  assert.equal(await options.managedEndpointNeeded(), null);
});

test("prepare is local-only, takes nothing from the page, and an organisation can refuse it", async () => {
  const origin = "http://127.0.0.1:49210";
  const handlers = new Map();
  const prepared = [];
  let refusal = null;
  localOrigin.setLocalOrigin(origin);
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly,
    managedRemoteAccessRefusal: () => refusal,
    ensureCompanionAccountService: () => ({
      state: () => ({ status: "ready" }),
      requestCode: () => ({}),
      verifyCode: () => ({}),
      retry: () => ({}),
      signOut: () => ({}),
      prepare: (...args) => {
        prepared.push(args);
        return { available: true, status: "ready" };
      },
    }),
  });
  vm.runInContext(slice('ipcMain.handle("companion-account:state"', "const workspaceOnly ="), context);
  const prepare = handlers.get("companion-account:prepare");
  assert.equal(typeof prepare, "function");

  const local = { senderFrame: { url: `${origin}/` } };
  assert.deepEqual(await prepare(local, { endpoint: "https://evil.example.test" }), { available: true, status: "ready" });
  assert.deepEqual(prepared, [[]]);
  assert.throws(() => prepare({ senderFrame: { url: "https://remote.example.test/" } }), /only available/);

  refusal = "Example Org does not allow remote access to this computer.";
  assert.throws(() => prepare(local), /Example Org does not allow remote access/);
  assert.equal(prepared.length, 1);
});
