import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";

const ORIGIN = "http://127.0.0.1:48994";
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `IPC fixture section moved: ${start}`);
  return source.slice(from, to);
}

function fixture(response = 0) {
  const handlers = new Map(), calls = [];
  const frame = { url: `${ORIGIN}/` }, contents = { mainFrame: frame };
  const mainWindow = { webContents: contents, isDestroyed: () => false };
  localOrigin.setLocalOrigin(ORIGIN);
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    mainWindow, rendererOrigin: () => ORIGIN, environmentsState: { activeId: "local", environments: [] },
    dialog: { showMessageBox: async (...args) => { calls.push(args); return { response }; } },
  });
  vm.runInContext(section("const workspaceOnly =", 'ipcMain.handle("organization:settings-opened"')
    + section('ipcMain.handle("dialog:confirm"', 'ipcMain.handle("environments:state"'), context);
  return { confirm: handlers.get("dialog:confirm"), calls, mainWindow, context, event: { sender: contents, senderFrame: frame } };
}

test("local confirmation is parented, defaults to Cancel and accepts only explicit OK", async () => {
  for (const response of [0, 1, -1]) {
    const f = fixture(response);
    assert.equal(await f.confirm(f.event, "Delete the fixture VM?"), response === 0);
    const [parent, options] = f.calls[0];
    assert.equal(parent, f.mainWindow);
    assert.deepEqual(JSON.parse(JSON.stringify(options)), {
      type: "warning", message: "Delete the fixture VM?", buttons: ["OK", "Cancel"], defaultId: 1, cancelId: 1,
    });
  }
});

test("untrusted windows and subframes cannot open a confirmation", () => {
  const f = fixture();
  for (const event of [
    { sender: f.event.sender, senderFrame: { url: `${ORIGIN}/child` } },
    { sender: { mainFrame: f.event.senderFrame }, senderFrame: f.event.senderFrame },
    { sender: f.event.sender, senderFrame: { url: "https://untrusted.example/" } },
    { sender: f.event.sender },
  ]) assert.throws(() => f.confirm(event, "Delete?"), /only available/);
  assert.equal(f.calls.length, 0);
});

test("invalid messages and closed windows fail closed without opening a dialog", async () => {
  const f = fixture();
  for (const message of [null, {}, "", " ", "x".repeat(4097)]) assert.equal(await f.confirm(f.event, message), false);
  f.mainWindow.isDestroyed = () => true;
  assert.equal(await f.confirm(f.event, "Delete?"), false);
  assert.equal(f.calls.length, 0);
});
