import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { createLendingDialogs, serverAccessDetail } from "./lending-dialogs.mjs";

function fakeDialog({ response = 1, picked = { canceled: true, filePaths: [] } } = {}) {
  const calls = [];
  return {
    calls,
    dialog: {
      showOpenDialog: async (...args) => { calls.push(["open", ...args]); return picked; },
      showMessageBox: async (...args) => { calls.push(["message", ...args]); return { response }; },
    },
  };
}
const liveWindow = () => ({ isDestroyed: () => false });
const named = async (folders) => folders.map((folder) => ({ ...folder, name: folder.path.split("/").pop() }));

test("a picked folder is checked and lent read only; a cancelled picker lends nothing", async () => {
  const win = liveWindow(), checked = [];
  const validate = async (folders) => { checked.push(folders); return named(folders); };
  const cancelled = fakeDialog();
  assert.equal(await createLendingDialogs({ dialog: cancelled.dialog, window: () => win, validate }).chooseFolder("Choose a folder to share"), null);
  const empty = fakeDialog({ picked: { canceled: false, filePaths: [] } });
  assert.equal(await createLendingDialogs({ dialog: empty.dialog, window: () => win, validate }).chooseFolder("Choose"), null);
  assert.equal(checked.length, 0);
  const picked = fakeDialog({ picked: { canceled: false, filePaths: ["/Users/me/Plans"] } });
  const folder = await createLendingDialogs({ dialog: picked.dialog, window: () => win, validate }).chooseFolder("Choose a folder My Cloud can use");
  assert.deepEqual(picked.calls, [["open", win, { title: "Choose a folder My Cloud can use", properties: ["openDirectory"] }]]);
  assert.equal(checked.length, 1);
  assert.equal(checked[0][0].path, "/Users/me/Plans");
  assert.equal(checked[0][0].write, false);
  assert.deepEqual({ path: folder.path, name: folder.name, write: folder.write }, { path: "/Users/me/Plans", name: "Plans", write: false });
});

test("the whole home folder is lent only after its own warning, and is named in the access dialog", async () => {
  const win = liveWindow(), isHome = async (path) => path === "/Users/me";
  for (const [response, lent] of [[0, true], [1, false], [-1, false]]) {
    const { dialog, calls } = fakeDialog({ response, picked: { canceled: false, filePaths: ["/Users/me"] } });
    const folder = await createLendingDialogs({ dialog, window: () => win, validate: named, isHome }).chooseFolder("Choose a folder or drive to share");
    assert.equal(calls[1][0], "message");
    assert.equal(calls[1][2].message, "Share your whole home folder?");
    // The truth, not a scare: secrets inside it stay private (proven through the lending path in shared-computer-access).
    assert.match(calls[1][2].detail, /readable by the bots you allow\. .*keys, passwords and browser data, like \.ssh .*always stay private\./);
    assert.deepEqual([calls[1][2].defaultId, calls[1][2].cancelId], [1, 1]);
    assert.equal(folder === null, !lent);
    if (lent) assert.deepEqual({ path: folder.path, home: folder.home, write: folder.write }, { path: "/Users/me", home: true, write: false });
  }
  const other = fakeDialog({ picked: { canceled: false, filePaths: ["/Volumes/Photos"] } });
  const drive = await createLendingDialogs({ dialog: other.dialog, window: () => win, validate: named, isHome }).chooseFolder("Choose");
  assert.equal(other.calls.length, 1);
  assert.equal(drive.home, undefined);
  const detail = serverAccessDetail({ name: "S", origin: "https://s.test" }, { folders: [{ path: "/Users/me", write: false, home: true }], terminal: false, computer: false });
  assert.equal(detail.split("\n\n")[1], "Read only: /Users/me (your whole home folder)");
});

test("a server's computer access is allowed only by the dialog's own Allow, and it says what each part lets the bots do", async () => {
  const env = { name: "Team server", origin: "https://team.example.test" };
  const grant = { folders: [{ path: "/Users/me/Plans", write: true }, { path: "/Users/me/Notes", write: false }], terminal: true, computer: false };
  for (const response of [0, 1, -1]) {
    const win = liveWindow(), { dialog, calls } = fakeDialog({ response });
    assert.equal(await createLendingDialogs({ dialog, window: () => win, validate: named }).confirmServerAccess(env, grant), response === 0);
    const [[kind, parent, options]] = calls;
    assert.equal(kind, "message");
    assert.equal(parent, win);
    assert.deepEqual({ ...options, detail: undefined }, { type: "warning", message: "Allow computer access for Team server?", detail: undefined, buttons: ["Allow access", "Cancel"], defaultId: 1, cancelId: 1 });
    assert.equal(options.detail, serverAccessDetail(env, grant));
  }
  const detail = serverAccessDetail(env, grant).split("\n\n");
  assert.equal(detail[0], "Server: https://team.example.test");
  assert.deepEqual(detail.slice(1, 3), ["Read and write: /Users/me/Plans", "Read only: /Users/me/Notes"]);
  assert.match(detail[3], /^Terminal: UNRESTRICTED commands as your user/);
  assert.equal(detail[4], "Computer control: off");
  const quiet = serverAccessDetail(env, { folders: [], terminal: "yes", computer: true }).split("\n\n");
  assert.equal(quiet[1], "Terminal: off");
  assert.match(quiet[2], /^Computer control: can view your screen/);
});

const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function mainSection(start, end) {
  const from = MAIN.indexOf(start), to = MAIN.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `main.mjs section moved: ${start}`);
  return MAIN.slice(from, to);
}

function mainSharing({ response }) {
  const handlers = new Map(), saved = [], win = liveWindow();
  const { dialog, calls } = fakeDialog({ response, picked: { canceled: false, filePaths: ["/Users/me/Plans"] } });
  const team = { id: "team", name: "Team server", origin: "https://team.example.test" };
  const context = vm.createContext({
    createLendingDialogs, dialog, mainWindow: win, validateSharedFolders: named, isHomeFolder: async () => false,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, localWorkspaceOnly: (_channel, handler) => handler,
    requireSharedComputers: async () => {}, savedWorkspace: () => team,
    sharingController: () => ({ identity: async () => ({ id: "info" }), save: async (env, grant, info) => { saved.push([env.id, grant, info]); } }),
  });
  vm.runInContext(mainSection("const lendingDialogs = createLendingDialogs(", 'ipcMain.handle("sharing:revoke"')
    + mainSection('ipcMain.handle("sharing:save"', "const cloudSync = installCloudFiles("), context);
  return { handlers, saved, calls };
}

test("main asks in its own dialog before a server gets this computer, and Cancel saves nothing", async () => {
  const cancelled = mainSharing({ response: 1 });
  assert.equal(await cancelled.handlers.get("sharing:save")({}, "team", { folders: [{ path: "/Users/me/Plans", write: true }], terminal: true }), null);
  assert.deepEqual(cancelled.calls.map(([kind, , options]) => [kind, options.message]), [["message", "Allow computer access for Team server?"]]);
  assert.deepEqual(cancelled.saved, []);

  const allowed = mainSharing({ response: 0 });
  await allowed.handlers.get("sharing:save")({}, "team", { folders: [{ path: "/Users/me/Plans", write: true }], terminal: true });
  assert.deepEqual(allowed.saved.map(([id]) => id), ["team"]);
  assert.deepEqual(JSON.parse(JSON.stringify(allowed.saved[0][1])), { folders: [{ path: "/Users/me/Plans", write: true, name: "Plans" }], terminal: true, computer: false });
  const folder = await allowed.handlers.get("sharing:folder")({});
  assert.deepEqual({ path: folder.path, write: folder.write }, { path: "/Users/me/Plans", write: false });
  assert.equal(allowed.calls.at(-1)[2].title, "Choose a folder or drive to share");
});
