import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCloudFiles } from "./cloud-sync-main.mjs";

test("Files keeps its settings in the folder main names (the staging Admin's own), else cloud-sync", async (t) => {
  const { existsSync } = await import("node:fs");
  for (const [stateDir, folder] of [[undefined, "cloud-sync"], ["cloud-sync-staging", "cloud-sync-staging"]]) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-files-dir-")));
    const installed = installCloudFiles({
      app: { getPath: (name) => join(dir, name) }, ipcMain: { handle: () => {} }, dialog: {}, shell: { trashItem: async () => {} }, powerMonitor: { on: () => {} },
      fetch: async () => { throw new Error("offline"); }, localWorkspaceOnly: (_channel, handler) => handler, send: () => {}, cloudOrigin: () => null,
      cloudAccount: () => ({ openDashboard: async () => {} }), localDataDir: join(dir, "home", ".openmausbot"), ...(stateDir ? { stateDir } : {}),
    });
    // Close before removing: Windows will not delete a folder whose Files database is still open.
    t.after(() => { installed.close(); rmSync(dir, { recursive: true, force: true }); });
    assert.ok(existsSync(join(dir, "userData", folder, "settings.json")), folder);
    assert.equal(existsSync(join(dir, "userData", folder === "cloud-sync" ? "cloud-sync-staging" : "cloud-sync")), false);
  }
});

test("Files channels answer this computer's own window only, and share only a folder the person picked here", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-files-main-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const picked = join(dir, "home", "Clients");
  mkdirSync(picked, { recursive: true });
  const handlers = new Map(), guards = [], opened = [];
  let pick = { canceled: false, filePaths: [picked] };
  const installed = installCloudFiles({
    app: { getPath: (name) => join(dir, name) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => pick },
    shell: { trashItem: async () => {}, openPath: async (folder) => { opened.push(folder); return ""; } },
    powerMonitor: { on: () => {} },
    fetch: async () => { throw new Error("offline"); },
    localWorkspaceOnly: (channel, handler) => { guards.push(channel); return handler; },
    send: () => {}, cloudOrigin: () => null, cloudAccount: () => ({ openDashboard: async () => {} }),
    localDataDir: join(dir, "home", ".openmausbot"),
  });
  t.after(() => installed.close());
  assert.deepEqual(guards, ["files:state", "files:pick", "files:check", "files:share", "files:stop", "files:deletes", "files:locate", "files:outputs", "files:open", "files:more-space"]);
  const checked = await handlers.get("files:pick")({});
  assert.equal(checked.name, "Clients");
  assert.equal(checked.refusal, null);
  // Only the token stands for the folder: a made-up one, or the same one twice, shares nothing.
  await assert.rejects(handlers.get("files:share")({}, "not-a-token"), /Choose the folder again/);
  const state = await handlers.get("files:share")({}, checked.token);
  assert.deepEqual(state.shared.map((folder) => folder.pcPath), [picked]);
  await assert.rejects(handlers.get("files:share")({}, checked.token), /Choose the folder again/);
  // A refused folder gets no token that shares it.
  pick = { canceled: false, filePaths: [join(dir, "home")] };
  const broad = await handlers.get("files:pick")({});
  assert.equal(broad.refusal, "too-broad");
  await assert.rejects(handlers.get("files:share")({}, broad.token));
  pick = { canceled: true, filePaths: [] };
  assert.equal(await handlers.get("files:pick")({}), null);
  await assert.rejects(handlers.get("files:check")({}, "not a list"));
  await handlers.get("files:open")({}, { outputs: true });
  assert.deepEqual(opened, [join(dir, "documents", "MausBot")]);
  // before-quit runs twice when quitting: closing again must not throw.
  installed.close();
  assert.doesNotThrow(() => installed.close());
});

test("a folder added on the Files page is lent, read only, and Stop sharing takes it back from lending", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-files-lend-")));
  const picked = join(dir, "home", "Clients");
  mkdirSync(picked, { recursive: true });
  const handlers = new Map();
  const env = { id: "my-cloud", origin: "https://omb-u-aaaaaaaaaaaa.fly.dev" };
  let state = { enabled: false, folders: [], screen: false, internet: false, chrome: false, terminal: false };
  const saves = [];
  const sharing = {
    cloudState: () => state, lentToCloud: () => (state.enabled ? { lendingId: "8b6f1c1e-3d6a-4a8e-9f1e-0a1b2c3d4e5f", folders: state.folders, protectedPaths: [] } : { off: true }),
    saveCloud: async (_env, input) => { saves.push(input); state = { ...state, ...input, enabled: true }; return state; }, revoke: () => { saves.push("revoked"); state = { ...state, enabled: false }; },
  };
  const installed = installCloudFiles({
    app: { getPath: (name) => join(dir, name) }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [picked] }) }, shell: { trashItem: async () => {} }, powerMonitor: { on: () => {} },
    fetch: async () => { throw new Error("offline"); }, localWorkspaceOnly: (_channel, handler) => handler, send: () => {}, cloudOrigin: () => null,
    cloudAccount: () => ({ openDashboard: async () => {}, state: () => ({}) }), localDataDir: join(dir, "home", ".openmausbot"),
    lending: { environment: () => env, sharing: () => sharing, validate: async ([folder]) => [{ ...folder, name: "Clients" }] },
  });
  // Close before removing: Windows will not delete a folder whose Files database is still open.
  t.after(() => { installed.close(); rmSync(dir, { recursive: true, force: true }); });
  const checked = await handlers.get("files:pick")({});
  const shared = await handlers.get("files:share")({}, checked.token);
  assert.deepEqual(saves, [{ folders: [{ id: state.folders[0].id, path: picked, write: false, name: "Clients" }] }]);
  assert.deepEqual(shared.shared.map((folder) => ({ pcPath: folder.pcPath, lent: folder.lent })), [{ pcPath: picked, lent: true }]);
  await handlers.get("files:stop")({}, shared.shared[0].id);
  assert.equal(saves.at(-1), "revoked", "it was all that was lent");
});
