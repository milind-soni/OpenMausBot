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
  const primed = [];
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
    companionE2E: { prime: async () => { primed.push(1); } },
  });
  vm.runInContext(`${slice("function ensureCompanionAccountService()", "// Everything the bug-report bundle needs")}
    globalThis.ensure = ensureCompanionAccountService;`, context);
  context.ensure();

  assert.equal(options.onDemand, true);
  assert.equal(options.autoRecover, true);
  assert.equal(await options.managedEndpointNeeded(), null);
  assert.equal(stateReads.length, 0);
  // A new installation credential asks for the relay token at once.
  options.installationChanged();
  assert.equal(primed.length, 1);

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
  const routes = [];
  const primed = [];
  let refusal = null;
  localOrigin.setLocalOrigin(origin);
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly,
    managedRemoteAccessRefusal: () => refusal,
    rememberCompanionRoute: async (route, on) => { routes.push([route, on]); },
    companionE2E: { prime: async () => { primed.push(1); } },
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
  assert.deepEqual(routes, [["https", true]], "setting up the secure address is the person turning the HTTPS address on");
  assert.equal(primed.length, 1, "a person pairing asks for the relay token before a code opens");
  assert.throws(() => prepare({ senderFrame: { url: "https://remote.example.test/" } }), /only available/);

  refusal = "Example Org does not allow remote access to this computer.";
  assert.throws(() => prepare(local), /Example Org does not allow remote access/);
  assert.equal(prepared.length, 1);
  assert.equal(primed.length, 1);
});

test("the connector reports every status to the account service", () => {
  let options;
  const reported = [];
  const context = vm.createContext({
    managedCompanionConnector: null,
    createManagedCompanionTunnel: (passed) => {
      options = passed;
      return { fixture: true };
    },
    resolveCloudflaredBinary: () => "/fixture/cloudflared",
    resolveManagedCompanionGuardian: () => "/fixture/guardian.mjs",
    app: { isPackaged: true, getAppPath: () => "/fixture", getPath: () => "/fixture" },
    process: { resourcesPath: "/fixture", execPath: "/fixture/node" },
    path: { join: (...parts) => parts.join("/") },
    slog: () => {},
    companionAccountService: { connectorChanged: (status) => reported.push(status.status) },
    companionDesiredThisLaunch: false,
  });
  vm.runInContext(`${slice("function ensureManagedCompanionConnector()", "function reconcileCompanionAdvertisement(")}
    globalThis.ensure = ensureManagedCompanionConnector;`, context);
  context.ensure();
  for (const status of ["starting", "retrying", "ready"]) options.onChange({ status, ready: status === "ready" });
  assert.deepEqual(reported, ["starting", "retrying", "ready"]);
});

test("starting the phone link checks a stored address first and waits on it only without Anywhere", async () => {
  const starts = [];
  const routesOn = new Set();
  const context = vm.createContext({
    managedRemoteAccessRefusal: () => null,
    companionDesiredThisLaunch: false,
    companionLaunchGeneration: 0,
    startCompanion: async () => ({ enabled: true }),
    companionLaunchOptions: () => ({}),
    rememberCompanionRoute: async (route, on) => { if (on) routesOn.add(route); },
    phoneLinkRoutes: { touched: () => {} },
    companionRouteOn: (route) => routesOn.has(route),
    managedCompanionTunnelAccess: () => ({ endpoint: "https://c-fixture.example.test", token: "fixture" }),
    secureCredentials: {},
    companionAccountService: { checkStoredAddress: async () => null },
    startManagedCompanionConnection: async () => ({}),
    startCheckedManagedConnection: async (options) => { starts.push(options); },
    desktopCompanionState: async () => ({ enabled: true }),
  });
  vm.runInContext(`${slice("async function startDesktopCompanion(", "async function stopDesktopCompanion(")}
    globalThis.start = startDesktopCompanion;`, context);

  // Pairing's start turns Same Wi-Fi and Anywhere on: it never waits on the HTTPS address.
  await context.start();
  // A Wi-Fi or Tailscale start (explicit, no routes) does not wait either.
  await context.start({ routes: [] });
  // Only a start without Anywhere that turns a route on still waits for the address to verify.
  routesOn.clear();
  await context.start({ routes: ["wifi"] });
  await context.start({ waitForHosted: false, remember: false });
  assert.deepEqual(starts.map((options) => options.wait), [false, false, true, false]);
  // The check asks the account service only while the HTTPS address is on and stored.
  assert.equal(starts[0].check(), null);
  routesOn.add("https");
  assert.equal(typeof starts[0].check()?.then, "function");
  assert.equal(starts[0].start, context.startManagedCompanionConnection);
  assert.equal(starts[0].desired(), true);
});
