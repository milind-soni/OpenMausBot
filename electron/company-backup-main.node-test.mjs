import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";
import { randomUUID } from "node:crypto";
import { createCompanyBackupSchedule } from "./company-backup-schedule.mjs";

// Exercise the production main-process functions and IPC registrations without
// importing Electron main (which would start the app). All IO, connection state,
// and transfer results are synthetic; these tests do not prove archive transport,
// OS keychain storage, or a renderer workflow.
// Windows checkouts can have CRLF line endings; the source checks below match "\n".
const mainSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function section(start, end) {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Main-process test section moved: ${start}`);
  return mainSource.slice(from, to);
}
const functions = section("function ensureManagedDesktop()", "function syncDesktopMutationToken(");
const registrations = section("const workspaceOnly =", "const savedWorkspace =");
const ORIGIN = "http://127.0.0.1:48799";
const STAGE = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function fixture() {
  const handlers = new Map(), sent = [], requests = [];
  const frame = { url: `${ORIGIN}/` };
  const contents = { mainFrame: frame, send: (...args) => sent.push(args) };
  const event = { sender: contents, senderFrame: frame };
  const f = {
    connection: { deviceId: DEVICE, organizationId: "fixture-org", portalOrigin: "https://company.example.test", email: "fixture@example.test", expiresAt: Date.now() + 60_000 },
    state: { status: "connected", cloudBackups: true },
    status: { busy: false, pendingRestore: false },
    transfer: async () => ({ id: STAGE, summary: {} }),
    restoreResponse: async () => Response.json({ restoreId: STAGE }),
    onState: null, requests, sent, event, generation: 0, savedSchedule: null, scheduleOptions: null,
    now: Date.now(), scheduleTimer: null, statusResponse: null,
    stores: [], clientOptions: null, libraryOptions: null, libraryFetches: [], librarySent: [],
    library: { runtimeReady: () => {}, receive: () => false, close: () => {} },
  };
  const client = { connection: () => f.connection, state: () => f.state, backupGeneration: () => f.generation,
    fetchLibraryBytes: async (...args) => { f.libraryFetches.push(args); return Buffer.from("{}"); },
    disconnect: async () => { f.generation++; f.connection = null; f.state = { status: "signed-out" }; f.onState(f.state); return f.state; } };
  localOrigin.setLocalOrigin(ORIGIN);
  const context = vm.createContext({
    AbortController, AbortSignal, Date, Headers, setTimeout, clearTimeout, path, randomUUID, Buffer,
    app: { isPackaged: true, getPath: () => "/unused-synthetic-backup-fixture", getVersion: () => "fixture" },
    os: { hostname: () => "Fixture computer" }, process: { platform: "fixture" },
    createManagedDesktopStore: options => {
      const store = { file: options.file, read: async () => f.savedSchedule, write: async value => { f.savedSchedule = structuredClone(value); } };
      f.stores.push(store);
      return store;
    },
    createManagedDesktopClient: options => { f.onState = options.onState; f.clientOptions = options; return client; },
    // The organization library is wired beside company access; a recording stub.
    createOrgLibrary: options => { f.libraryOptions = options; return f.library; },
    managedDesktopRelay: { sendLibrary: async (proc, library) => { f.librarySent.push({ proc, library }); } },
    createCompanyBackupSchedule: options => {
      f.scheduleOptions = options;
      return createCompanyBackupSchedule({ ...options, now: () => f.now,
        setTimer: callback => { f.scheduleTimer = callback; return 1; }, clearTimer: () => { f.scheduleTimer = null; } });
    },
    createCompanyBackups: () => ({ backup: (...args) => f.transfer(...args), prepareRestore: (...args) => f.transfer(...args) }),
    managedDesktop: null, companyBackupController: null, preparedCompanyRestore: null,
    companyBackupSchedule: null, companyBackupClientStateRequest: null, companyRestoreCommitting: false, desktopShutdownStarted: false, companyBackupConfigurationRevision: 0,
    desktopDataDir: () => "/synthetic-fixture-workspace",
    companyBackupState: { busy: false }, serverProc: {}, serverReady: true,
    desktopRemoteAccess: null, mainWindow: { webContents: contents, isDestroyed: () => false },
    rendererOrigin: () => ORIGIN, environmentsState: { environments: [], activeId: "local" },
    activeEnvironment: environments.activeEnvironment, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    localOnly: localOrigin.localOnly, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, handler) => handlers.set(channel, handler) },
    SERVER_PORT: 48799, DESKTOP_MUTATION_HEADER: "x-fixture-desktop-mutation", desktopMutationToken: "synthetic-local-only",
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, ORIGIN, "No external network or live workspace is permitted");
      requests.push({ url, options });
      if (url.endsWith("/status")) return f.statusResponse ? f.statusResponse() : Response.json(f.status);
      assert.equal(url, `${ORIGIN}/api/workspace-backup/restore`);
      return f.restoreResponse();
    },
  });
  vm.runInContext(`${functions}\n${registrations}`, context, { filename: "main.mjs (company backup boundary fixture)" });
  context.ensureManagedDesktop();
  return Object.assign(f, {
    context,
    invoke: (channel, input, sender = event) => handlers.get(`company-backups:${channel}`)(sender, input),
    prepare: () => { context.preparedCompanyRestore = { id: STAGE, proc: context.serverProc, deviceId: DEVICE }; },
  });
}

test("ensureManagedDesktop gives the organization library its own record, the fixed-route client and the local runtime", async () => {
  const f = fixture(), options = f.libraryOptions;
  assert.equal(options.dataDir, path.join("/synthetic-fixture-workspace", "org-library"));
  assert.deepEqual(f.stores.map(store => path.basename(store.file)), ["company-connection.bin", "company-library.bin", "company-backup-schedule.bin"]);
  assert.equal(options.store, f.stores[1], "a separate OS-encrypted record, not the connection's");
  assert.equal(f.clientOptions.store, f.stores[0]);
  assert.equal(f.clientOptions.library, f.library, "every session sync reaches the library");
  assert.equal(options.appVersion, "fixture");
  await options.fetchBytes("/api/desktop/library", 1024, { generation: 3 });
  assert.deepEqual(f.libraryFetches, [["/api/desktop/library", 1024, { generation: 3 }]], "downloads go through the client's fixed routes");
  const library = { digest: "d".repeat(64) };
  await options.relay(library);
  assert.equal(f.librarySent.length, 1);
  assert.equal(f.librarySent[0].proc, f.context.serverProc, "only to the current local runtime");
  assert.equal(f.librarySent[0].library, library);
});

test("main hands the library a restarted runtime, the runtime's own messages and the quit", () => {
  // Outside ensureManagedDesktop(), so checked in the source like the recovery-window rule in server-supervisor.node-test.mjs.
  assert.match(section("onReady(proc) {", "routineWake.start();"), /\n\s*orgLibrary\?\.runtimeReady\(\);\n/);
  const messages = section('proc.on("message", (message) => {', 'proc.once("spawn"');
  assert.match(messages, /if \(!serverSupervisor\.isCurrent\(proc\)\) return;/, "a replaced runtime's messages are dropped first");
  assert.match(messages, /\n\s*if \(orgLibrary\?\.receive\(message\)\) return;\n/);
  assert.match(section('app.on("before-quit"', "managedDesktop?.close();"), /\n\s*orgLibrary\?\.close\(\);\n/);
});

for (const kind of ["preview", "create"]) {
  test(`late cancellation rejects ${kind} instead of accepting its completed result`, async () => {
    const f = fixture(), started = deferred(), completion = deferred();
    f.transfer = (_input, signal) => { started.resolve(signal); return completion.promise; };
    const operation = f.invoke(kind, {});
    const signal = await started.promise;
    f.invoke("cancel");
    assert.equal(signal.aborted, true);
    completion.resolve({ id: STAGE, summary: {} });
    await assert.rejects(operation, /cancelled.*has not been replaced/);
    assert.equal(f.context.preparedCompanyRestore, null);
    assert.equal(f.context.companyBackupController, null);
    assert.equal(f.context.companyBackupState.busy, false);
    assert.equal(f.context.companyBackupState.lastBackupAt, undefined);
    assert.match(f.context.companyBackupState.message, /cancelled/);
    assert.equal(f.requests.filter(row => row.url.endsWith("/restore")).length, 0);
  });
}

for (const [name, change] of [
  ["disabled backup capability", f => { f.state.cloudBackups = false; }],
  ["expired connection", f => { f.connection.expiresAt = Date.now() - 1; }],
  ["reauthentication required", f => { f.state.status = "reauth-required"; }],
  ["unavailable connection", f => { f.state.status = "unavailable"; }],
  ["disconnected account", f => { f.connection = null; }],
  ["different account device", f => { f.connection.deviceId = "33333333-3333-4333-8333-333333333333"; }],
  ["replaced local process", f => { f.context.serverProc = {}; }],
]) {
  test(`restore refuses a prepared preview after ${name}`, async () => {
    const f = fixture(); f.prepare(); change(f);
    await assert.rejects(f.invoke("restore", { id: STAGE, confirmation: "REPLACE" }), /Preview this backup again/);
    assert.equal(f.requests.length, 0, "Rejected authority must not dispatch a local request");
  });
}

test("restore consumes the exact confirmed preview before yielding and refuses duplicate IPC", async () => {
  const f = fixture(), response = deferred(); f.prepare();
  f.restoreResponse = () => response.promise;
  const operation = f.invoke("restore", { id: STAGE, confirmation: "REPLACE" });
  assert.equal(f.context.preparedCompanyRestore, null);
  await assert.rejects(f.invoke("restore", { id: STAGE, confirmation: "REPLACE" }), /Preview this backup again/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.redirect, "error");
  assert.equal(f.requests[0].options.credentials, "omit");
  assert.equal(f.requests[0].options.headers["x-fixture-desktop-mutation"], "synthetic-local-only");
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { id: STAGE, confirmation: "REPLACE" });
  response.resolve(Response.json({ restoreId: STAGE }));
  assert.equal((await operation).restoreId, STAGE);
  assert.equal(f.context.companyBackupState.pendingRestore, true);
});

const ENABLE_SCHEDULE = { enabled: true, confirmation: "BACK UP THIS WORKSPACE DAILY" };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const snapshotRequest = f => f.sent.findLast(([channel]) => channel === "company-backups:collect-client-state")?.[1];

test("enabling daily backups never uploads, and disabling leaves an active manual backup alone", async () => {
  const f = fixture();
  const state = await f.invoke("configure-schedule", ENABLE_SCHEDULE);
  assert.equal(state.schedule.enabled, true);
  assert.equal(state.schedule.nextBackupAt, f.now + 24 * 3600_000);
  assert.equal(snapshotRequest(f), undefined);
  const completion = deferred(), started = deferred();
  f.transfer = (_input, signal) => { started.resolve(signal); return completion.promise; };
  const manual = f.invoke("create", { password: "manual fixture password" });
  const signal = await started.promise;
  await f.invoke("configure-schedule", { enabled: false });
  assert.equal(signal.aborted, false);
  assert.equal(f.savedSchedule, null);
  completion.resolve({ id: STAGE }); await manual;
});

test("disable wins over an earlier enable awaiting local workspace status", async () => {
  const f = fixture(), status = deferred(); f.statusResponse = () => status.promise;
  const enable = f.invoke("configure-schedule", ENABLE_SCHEDULE);
  await f.invoke("configure-schedule", { enabled: false });
  status.resolve(Response.json({ busy: false, pendingRestore: false }));
  await assert.rejects(enable, { code: "workspace_busy" });
  assert.equal(f.savedSchedule, null);
});

test("scheduled native transfer receives fresh client state and disable cancels its own transfer", async () => {
  const f = fixture(), completion = deferred(), started = deferred();
  f.transfer = (input, signal) => { started.resolve({ input, signal }); return completion.promise; };
  await f.invoke("configure-schedule", ENABLE_SCHEDULE);
  f.now += 24 * 3600_000;
  const firing = f.scheduleTimer(); await nextTurn();
  const request = snapshotRequest(f); assert(request?.requestId);
  f.invoke("client-state", { requestId: request.requestId, clientState: { "omb-drafts": "latest synthetic draft" } });
  const { input, signal } = await started.promise;
  assert.equal(input.clientState["omb-drafts"], "latest synthetic draft");
  await f.invoke("configure-schedule", { enabled: false }); assert.equal(signal.aborted, true);
  completion.resolve({ id: STAGE }); await firing;
  assert.equal(f.savedSchedule, null); assert.equal(f.context.companyBackupState.schedule.enabled, false);
  assert.equal(f.context.companyBackupState.lastBackupAt, undefined);
});

for (const [name, mutate] of [
  ["prepared restore preview", f => f.prepare()],
  ["restore commit", f => { f.context.companyRestoreCommitting = true; }],
  ["pending restore", f => { f.status.pendingRestore = true; }],
  ["local backup busy", f => { f.status.busy = true; }],
]) {
  test(`a scheduled backup defers during ${name} without requesting browser state or exporting`, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(f.scheduleOptions.run(new AbortController().signal, f.context.companyBackupScope()), { code: "workspace_busy" });
    assert.equal(snapshotRequest(f), undefined);
  });
}

test("confirmed restore holds the backup exclusion guard until its request settles", async () => {
  const f = fixture(), response = deferred(); f.prepare(); f.restoreResponse = () => response.promise;
  const restoring = f.invoke("restore", { id: STAGE, confirmation: "REPLACE" });
  assert.equal(f.context.companyRestoreCommitting, true);
  await assert.rejects(f.invoke("create", {}), { code: "workspace_busy" });
  response.resolve(Response.json({ restoreId: STAGE })); await restoring;
  assert.equal(f.context.companyRestoreCommitting, false);
});

for (const [name, mutate] of [
  ["different generation", f => { f.generation++; }],
  ["different account", f => { f.connection.email = "another@example.test"; }],
  ["different server process", f => { f.context.serverProc = {}; }],
  ["remote navigation", f => { f.event.senderFrame.url = "https://remote.example.test/"; }],
  ["different main window", f => { f.context.mainWindow = { webContents: f.event.sender, isDestroyed: () => false }; }],
  ["shutdown", f => { f.context.desktopShutdownStarted = true; }],
]) {
  test(`client-state receipt is rejected after ${name}`, async () => {
    const f = fixture(), controller = new AbortController();
    const collecting = f.context.collectCompanyBackupClientState(controller.signal, f.context.companyBackupScope(), f.context.serverProc);
    const request = snapshotRequest(f); mutate(f);
    f.invoke("client-state", { requestId: request.requestId, clientState: { "omb-drafts": "fixture" } });
    await assert.rejects(collecting, { code: "workspace_busy" });
    assert.equal(f.context.companyBackupClientStateRequest, null);
  });
}

test("client-state receipts are one-shot and unsolicited or other-frame replies cannot settle them", async () => {
  const f = fixture(), controller = new AbortController();
  const collecting = f.context.collectCompanyBackupClientState(controller.signal, f.context.companyBackupScope(), f.context.serverProc);
  const request = snapshotRequest(f);
  f.invoke("client-state", { requestId: "not-the-request", clientState: {} });
  f.invoke("client-state", { requestId: request.requestId, clientState: {} }, { sender: f.event.sender, senderFrame: { url: `${ORIGIN}/` } });
  assert(f.context.companyBackupClientStateRequest);
  f.invoke("client-state", { requestId: request.requestId, clientState: { "omb-skin": "fresh fixture skin" } });
  assert.equal((await collecting)["omb-skin"], "fresh fixture skin");
  assert.equal(f.context.companyBackupClientStateRequest, null);
  f.invoke("client-state", { requestId: request.requestId, clientState: { "omb-skin": "ignored duplicate" } });
});

for (const value of [{ unavailable: true }, { clientState: [] }, { clientState: { "omb-drafts": 42 } }, { clientState: { "omb-drafts": "x".repeat(2 * 1024 * 1024) } }]) {
  test(`malformed or unavailable client-state reply is deferred (${Object.keys(value)[0]}, ${typeof value.clientState})`, async () => {
    const f = fixture(), controller = new AbortController();
    const collecting = f.context.collectCompanyBackupClientState(controller.signal, f.context.companyBackupScope(), f.context.serverProc);
    f.invoke("client-state", { requestId: snapshotRequest(f).requestId, ...value });
    await assert.rejects(collecting, { code: "workspace_busy" });
  });
}

test("cancelling a pending fresh-state request removes its authority before any late reply", async () => {
  const f = fixture(), controller = new AbortController();
  const collecting = f.context.collectCompanyBackupClientState(controller.signal, f.context.companyBackupScope(), f.context.serverProc);
  const request = snapshotRequest(f); controller.abort();
  await assert.rejects(collecting, { code: "workspace_busy" });
  f.invoke("client-state", { requestId: request.requestId, clientState: {} });
  assert.equal(f.context.companyBackupClientStateRequest, null);
});

test("a failed commit does not claim replacement or make its consumed preview reusable", async () => {
  const f = fixture(); f.prepare();
  f.restoreResponse = async () => Response.json({ error: "synthetic private path" }, { status: 409 });
  await assert.rejects(f.invoke("restore", { id: STAGE, confirmation: "REPLACE" }), /Check local backup status/);
  assert.equal(f.context.companyBackupState.pendingRestore, undefined);
  assert.equal(f.context.preparedCompanyRestore, null);
  await assert.rejects(f.invoke("restore", { id: STAGE, confirmation: "REPLACE" }), /Preview this backup again/);
  assert.equal(f.requests.length, 1);
});

test("local pending-restore status overrides stale main-process display state", async () => {
  const f = fixture();
  f.context.companyBackupState = { busy: false, pendingRestore: false };
  f.status.pendingRestore = true;
  assert.equal((await f.invoke("state")).pendingRestore, true);
});

for (const state of [{ status: "signed-out" }, { status: "reauth-required" }, { status: "connected", cloudBackups: false }]) {
  test(`connection update ${JSON.stringify(state)} clears prior backup authority and display metadata`, async () => {
    const f = fixture(); f.prepare();
    const controller = new AbortController();
    f.context.companyBackupController = controller;
    f.context.companyBackupState = { busy: false, lastBackupAt: 1, progress: { bytesTransferred: 123 }, message: "Previous account" };
    f.onState(state);
    assert.equal(controller.signal.aborted, true);
    assert.equal(f.context.preparedCompanyRestore, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Object.keys(f.context.companyBackupState), ["busy", "schedule"]);
    assert.equal(f.context.companyBackupState.schedule.enabled, false);
    assert.equal(f.context.companyBackupState.busy, true, "Cleanup remains busy until the active operation settles");
  });
}

test("backup IPC requires the local main window's exact main frame", async () => {
  const f = fixture();
  const subframe = { sender: f.event.sender, senderFrame: { url: `${ORIGIN}/embedded` } };
  const anotherWindow = { sender: { mainFrame: f.event.senderFrame }, senderFrame: f.event.senderFrame };
  const external = { sender: f.event.sender, senderFrame: { url: "https://untrusted.example.test/" } };
  const missingFrame = { sender: f.event.sender };
  for (const sender of [subframe, anotherWindow, external, missingFrame]) {
    for (const channel of ["state", "list", "create", "preview", "cancel", "delete", "restore", "configure-schedule"]) {
      assert.throws(() => f.invoke(channel, { id: STAGE, confirmation: "REPLACE" }, sender), /only available/);
    }
  }
  assert.equal(f.requests.length, 0);
  assert.equal((await f.invoke("state")).pendingRestore, false);
  assert.equal(f.requests.length, 1);
});

test("even a selected remote workspace main frame cannot use local backup IPC", () => {
  const f = fixture();
  f.context.environmentsState = { activeId: "remote", environments: [{ id: "remote", origin: "https://workspace.example.test", name: "Remote" }] };
  f.event.senderFrame.url = "https://workspace.example.test/";
  assert.throws(() => f.invoke("state"), /only available while using the local server/);
  assert.equal(f.requests.length, 0);
});
