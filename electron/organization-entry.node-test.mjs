import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { patchOrganizationUpdater } from "../scripts/patch-organization-updater.mjs";
import environments from "./environments.cjs";
import { createOrganizationEntry, isOrganizationDeepLink, takeOrganizationDeepLink, organizationRestartIntent, withOrganizationRestartIntent, withoutOrganizationRestartIntent } from "./organization-entry.mjs";

const remote = { id: "old", name: "Old cloud", origin: "https://old.example" };
const companion = { endpoint: "https://c-old.openmausbot.com", serverName: "Old computer", deviceId: "device-a" };
function fixture({ activeId = "old", remoteAccess = null, restartIntent = false, accepted = true } = {}) {
  const state = { environments: { activeId, environments: [remote] }, remoteAccess, restartIntent };
  const calls = [];
  const options = {
    readState: () => state,
    confirm: async info => { calls.push(["confirm", info]); return accepted; },
    saveEnvironments: async next => { calls.push(["save", next]); state.environments = next; },
    disconnectAndRemember: async () => { calls.push(["disconnect"]); state.remoteAccess = null; state.restartIntent = true; },
    clearRestartIntent: async () => { calls.push(["clear"]); state.restartIntent = false; },
    openLocalSettings: async () => { calls.push(["open-local"]); },
    relaunch: () => { calls.push(["relaunch"]); },
  };
  return { state, calls, options, entry: createOrganizationEntry(options) };
}

test("the organisation protocol is a fixed action without URL routing or credentials", () => {
  assert.equal(isOrganizationDeepLink("openmausbot://organization"), true);
  for (const value of [null, {}, "", "openmausbot://organization/", "openmausbot://organization?", "openmausbot://organization#", "openmausbot://organization?url=https://old.example", "openmausbot://organization#token=secret", "openmausbot://organization/other", "openmausbot://user@organization", "openmausbot://organization:443", "openmausbot://organization.evil", "https://organization", " openmausbot://organization", "openmausbot://%6frganization"]) {
    assert.equal(isOrganizationDeepLink(value), false);
  }
});

test("local entry opens Settings without enrollment or persistence", async () => {
  const h = fixture({ activeId: "local" });
  assert.equal(await h.entry.request(), true);
  assert.deepEqual(h.calls, [["open-local"]]);
});

test("consuming a launch action prevents it replaying on a later restart without changing other arguments", () => {
  const original = ["/Applications/OpenMausBot", "--profile=fixture", "openmausbot://organization?ignored", "openmausbot://install/example"];
  const argv = [...original, "openmausbot://organization", "openmausbot://organization"];
  assert.equal(takeOrganizationDeepLink(argv), true);
  assert.deepEqual(argv, original);
  assert.equal(takeOrganizationDeepLink(argv), false, "the action is consumed exactly once");
  assert.deepEqual(argv, original);
});

test("the actual companion relaunch passes consumed arguments and requests normal shutdown", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const source = main.slice(main.indexOf("function relaunchAfterDesktopRemoteChange()"), main.indexOf('ipcMain.handle("desktop-remote:state"'));
  const argv = ["/fixture/OpenMausBot", "--fixture", "openmausbot://organization", "openmausbot://organization?ignored"];
  takeOrganizationDeepLink(argv);
  const calls = [];
  runInNewContext(`${source}\nrelaunchAfterDesktopRemoteChange();`, {
    process: { argv }, setTimeout: callback => { callback(); return {}; },
    app: { relaunch: options => calls.push(options.args), quit: () => calls.push("quit") },
  });
  assert.deepEqual(calls, [["--fixture", "openmausbot://organization?ignored"], "quit"]);
});

test("the shipped updater adapter explicitly omits only the fixed action and its reproducible patch fails closed", () => {
  const before = "      relaunch() {\n        this.app.relaunch();\n      }";
  const patched = patchOrganizationUpdater(before);
  // Git may check the vendored bundle out with CRLF on Windows.
  const bundle = readFileSync(new URL("./vendor/electron-updater.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(bundle.includes(patched));
  const calls = [];
  const argv = ["/fixture/OpenMausBot", "--fixture", "openmausbot://organization", "openmausbot://organization?ignored"];
  runInNewContext(`({ app, ${patched} }).relaunch();`, {
    process: { argv }, app: { relaunch: options => calls.push(options.args) },
  });
  assert.deepEqual(calls, [["--fixture", "openmausbot://organization?ignored"]]);
  for (const changed of ["", `${before}\n${before}`, patched]) {
    assert.throws(() => patchOrganizationUpdater(changed), /to patch, found/);
  }
});

test("cancel keeps an old hosted workspace byte-for-byte unchanged", async () => {
  const h = fixture({ accepted: false });
  const before = JSON.stringify(h.state);
  assert.equal(await h.entry.request(), false);
  assert.equal(JSON.stringify(h.state), before);
  assert.deepEqual(h.calls.map(call => call[0]), ["confirm"]);
});

test("confirmed hosted entry keeps the saved connection and survives ordinary restart locally", async () => {
  const h = fixture();
  await h.entry.request();
  assert.deepEqual(h.calls.map(call => call[0]), ["confirm", "save", "open-local"]);
  assert.deepEqual(h.state.environments.environments, [remote]);
  assert.equal(environments.parseEnvironments(environments.serializeEnvironments(h.state.environments)).activeId, "local");
  assert.equal(await h.entry.restore(), false);
});

test("ordinary restart/update never changes an intentionally selected remote workspace", async () => {
  const h = fixture();
  assert.equal(await h.entry.restore(), false);
  assert.deepEqual(h.calls, []);
  assert.equal(environments.parseEnvironments(environments.serializeEnvironments(h.state.environments)).activeId, "old");
});

test("companion cancellation does not disconnect or set a restart intent", async () => {
  const h = fixture({ remoteAccess: companion, accepted: false });
  const before = JSON.stringify(h.state);
  assert.equal(await h.entry.request(), false);
  assert.equal(JSON.stringify(h.state), before);
  assert.deepEqual(h.calls.map(call => call[0]), ["confirm"]);
});

test("companion confirmation commits restart intent before relaunch and only local panel acknowledgment clears it", async () => {
  const h = fixture({ remoteAccess: companion });
  await h.entry.request();
  assert.equal(h.calls[0][1].kind, "companion");
  assert.deepEqual(h.calls.map(call => call[0]), ["confirm", "disconnect", "relaunch"]);
  assert.equal(h.state.restartIntent, true);
  assert.equal(h.state.environments.activeId, "old");
  await h.entry.request();
  assert.equal(h.calls.length, 3, "a second link cannot repeat the pending restart");
  const restarted = createOrganizationEntry(h.options);
  assert.equal(await restarted.restore(), true);
  assert.deepEqual(h.calls.slice(3).map(call => call[0]), ["save", "open-local"]);
  assert.equal(h.state.environments.activeId, "local");
  assert.deepEqual(h.state.environments.environments, [remote]);
  assert.equal(h.state.restartIntent, true, "document loading must not consume the durable intent");
  assert.equal(await restarted.settingsOpened(), true);
  assert.deepEqual(h.calls.at(-1), ["clear"]);
  assert.equal(h.state.restartIntent, false);
  assert.equal(await restarted.settingsOpened(), false);
  assert.equal(await restarted.restore(), false);
});

test("remote or unsolicited panel acknowledgments cannot clear a confirmed restart destination", async () => {
  for (const options of [
    { restartIntent: true },
    { activeId: "local", remoteAccess: companion, restartIntent: true },
    { activeId: "local" },
  ]) {
    const h = fixture(options);
    const before = JSON.stringify(h.state);
    assert.equal(await h.entry.settingsOpened(), false);
    assert.equal(JSON.stringify(h.state), before);
    assert.deepEqual(h.calls, []);
  }
});

test("a process exit between document loading and panel mount retries the destination on restart", async () => {
  const h = fixture({ restartIntent: true });
  await h.entry.restore();
  assert.equal(h.state.restartIntent, true);
  const restarted = createOrganizationEntry(h.options);
  assert.equal(await restarted.restore(), true);
  assert.equal(h.calls.filter(call => call[0] === "open-local").length, 2);
  assert.equal(await restarted.settingsOpened(), true);
  assert.equal(h.state.restartIntent, false);
});

test("a failed credential write cannot disconnect or restart", async () => {
  const h = fixture({ remoteAccess: companion });
  const entry = createOrganizationEntry({ ...h.options, disconnectAndRemember: async () => { throw new Error("write failed"); } });
  await assert.rejects(entry.request(), /write failed/);
  assert.equal(h.state.remoteAccess, companion);
  assert.equal(h.state.restartIntent, false);
  assert.deepEqual(h.calls.map(call => call[0]), ["confirm"]);
});

test("failed local loading keeps the confirmed restart intent for the next launch", async () => {
  const h = fixture({ restartIntent: true });
  const entry = createOrganizationEntry({ ...h.options, openLocalSettings: async () => { throw new Error("load failed"); } });
  await assert.rejects(entry.restore(), /load failed/);
  assert.equal(h.state.restartIntent, true);
  assert.deepEqual(h.calls.map(call => call[0]), ["save"]);
});

test("native entry checks owned server readiness before creating, sending to, or navigating a window", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const navigation = main.slice(main.indexOf("  openLocalSettings: async () => {"), main.indexOf("  relaunch: relaunchAfterDesktopRemoteChange"));
  assert.match(navigation, /if \(!serverReady\) throw new Error\(/);
  const guard = navigation.indexOf("if (!serverReady)");
  for (const action of ["createWindow(", "win.webContents.send(", "win.loadURL("]) {
    assert.ok(navigation.indexOf(action) > guard, `${action} must follow the owned-server guard`);
  }
});

test("startup delivers a pending organisation action before default navigation and falls back after cancellation", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const startup = main.slice(main.indexOf("  let restoredOrganizationEntry = false;"), main.indexOf("  // Reconcile incomplete setup"));
  assert.ok(startup.indexOf("await deliverOrganizationEntry()") < startup.indexOf("createWindow()"));
  assert.match(startup, /if \(!restoredOrganizationEntry && !deliveredOrganizationEntry && \(!mainWindow \|\| mainWindow.isDestroyed\(\)\)\) createWindow\(\)/);
});

test("concurrent links share one confirmation and stale confirmations cannot change a new selection", async () => {
  const h = fixture();
  let decide;
  const entry = createOrganizationEntry({ ...h.options, confirm: () => new Promise(resolve => { decide = resolve; }) });
  const first = entry.request();
  assert.equal(entry.request(), first);
  h.state.environments = { ...h.state.environments, activeId: "local" };
  decide(true);
  await assert.rejects(first, /selected server changed/);
  assert.deepEqual(h.calls, []);
});

test("the encrypted credential update records intent and removes only companion access atomically", () => {
  const before = { provider: { fixture: true }, desktopCompanionRemote: companion };
  const next = withOrganizationRestartIntent(before);
  assert.equal(organizationRestartIntent(next), true);
  assert.equal(next.desktopCompanionRemote, undefined);
  assert.deepEqual(next.provider, before.provider);
  assert.equal(before.desktopCompanionRemote, companion);
  assert.deepEqual(withoutOrganizationRestartIntent(next), { provider: before.provider });
  assert.equal(organizationRestartIntent({ desktopOrganizationSettingsPending: "true" }), false);
});
