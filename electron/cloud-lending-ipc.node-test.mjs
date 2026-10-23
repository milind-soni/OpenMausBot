import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { createLendingTarget, defaultGrant, existingFolders, installCloudLending, pageLending, usualFolderPaths, usualFolders } from "./cloud-lending-ipc.mjs";

const usual = ["Desktop", "Documents", "Downloads"].map((name, i) => ({ id: `id-${i}`, path: `/Users/me/${name}`, name, write: false }));

function setup({ enabled = false, kept = { folders: [], screen: false }, screenAvailable = true, screenReady = false, stopped, confirm = true } = {}) {
  const handlers = new Map(), calls = [];
  let state = { enabled, folders: kept.folders, screen: kept.screen, internet: kept.internet === true, busy: false, connected: enabled, ...(stopped ? { stopped } : {}) };
  const lending = installCloudLending({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: (channel, handler) => (event, ...args) => { if (event.page !== "local") throw new Error(`${channel} is only available in this app's window`); return handler(event, ...args); },
    cloudPage: (channel, handler) => (event, ...args) => { if (!event.page) throw new Error(`${channel} is only available in this app's window`); return handler(event, ...args); },
    snapshot: async () => ({ available: true, screenAvailable, screenReady, state }),
    environment: () => ({ id: "cloud" }),
    save: async (_env, choice) => { calls.push(["save", choice]); state = { ...state, enabled: true, connected: true, folders: choice.folders, screen: choice.screen, internet: choice.internet, terminal: choice.terminal === true }; },
    stop: () => { calls.push(["stop"]); state = { ...state, enabled: false, connected: false, stopped: { reason: "you", at: 1 } }; },
    chooseFolder: async () => null,
    confirmScreen: async () => { calls.push(["confirm"]); return confirm; },
    defaults: async () => usual,
    validate: async ([folder]) => {
      if (folder.path.includes("Gone")) throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      if (folder.path === "/Users/me") throw Object.assign(new Error("Choose specific folders, not the entire computer or home folder"), { code: "HOME_OR_ROOT" });
      return [{ ...folder, name: folder.name ?? folder.path.split("/").pop() }];
    },
  });
  return { handlers, calls, lending };
}

test("turned on with nothing chosen, lending lends the internet connection and the usual folders, read only; a choice already made is kept", async () => {
  const fresh = setup();
  await fresh.handlers.get("lending:save")({ page: "local" }, { folders: [], screen: false });
  assert.deepEqual(fresh.calls, [["save", { folders: usual, screen: false, internet: true }]]);
  const chosen = setup();
  const plans = [{ id: "p", path: "/Users/me/Plans", name: "Plans", write: true }];
  await chosen.handlers.get("lending:save")({ page: "local" }, { folders: plans, screen: true });
  assert.deepEqual(chosen.calls, [["save", { folders: plans, screen: true, internet: false }]]);
});

test("the internet connection alone is a grant: nothing else is added to it", async () => {
  const { handlers, calls } = setup();
  await handlers.get("lending:save")({ page: "local" }, { folders: [], screen: false, internet: true });
  assert.deepEqual(calls, [["save", { folders: [], screen: false, internet: true }]]);
});

test("the terminal is chosen only from this computer's own Settings: alone it is a grant, and My Cloud's page and the move's default never turn it on", async () => {
  const alone = setup();
  await alone.handlers.get("lending:save")({ page: "local" }, { folders: [], screen: false, terminal: true });
  assert.deepEqual(alone.calls, [["save", { folders: [], screen: false, internet: false, terminal: true }]], "nothing else is added to a terminal-only grant");
  const plans = [{ id: "p", path: "/Users/me/Plans", name: "Plans", write: false }];
  const both = setup();
  await both.handlers.get("lending:save")({ page: "local" }, { folders: plans, screen: false, terminal: "yes" });
  assert.deepEqual(both.calls, [["save", { folders: plans, screen: false, internet: false }]], "only a real true counts");
  await assert.rejects(async () => alone.handlers.get("lending:save")({ page: "cloud" }, { folders: [], screen: false, terminal: true }), /only available/);
  const page = setup({ kept: { folders: plans, screen: false, terminal: true } });
  await page.handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  assert.ok(!("terminal" in page.calls[0][1]), "My Cloud's page turns lending on without a terminal, whatever was kept");
  const moved = setup();
  await moved.lending.lendByDefault({ projects: [] });
  assert.ok(!("terminal" in moved.calls[0][1]), "the default grant never includes a terminal");
});

test("My Cloud's page turns lending on in place with no native confirmation, says it lends the internet connection, and off at once", async () => {
  const { handlers, calls } = setup();
  const on = await handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  assert.deepEqual(calls, [["save", { folders: usual, screen: false, internet: true }]]);
  assert.deepEqual(on, { available: true, on: true, status: "lent", folders: usual.map(({ name, write }) => ({ name, write })), screen: false, screenAvailable: true, internet: true });
  assert.ok(!JSON.stringify(on).includes("/Users/me"), "the page never learns a path");
  const off = await handlers.get("cloud-lending:set")({ page: "cloud" }, false);
  assert.equal(off.on, false);
  assert.deepEqual(calls.at(-1), ["stop"]);
});

test("an off switch lends again what it lent before, the internet connection included or not", async () => {
  const plans = [{ id: "p", path: "/Users/me/Plans", name: "Plans", write: false }];
  const again = setup({ kept: { folders: plans, screen: true } });
  await again.handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  assert.deepEqual(again.calls, [["save", { folders: plans, screen: true, internet: false }]]);
  const withInternet = setup({ kept: { folders: plans, screen: false, internet: true } });
  await withInternet.handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  assert.deepEqual(withInternet.calls.at(-1), ["save", { folders: plans, screen: false, internet: true }]);
  const noScreen = setup({ kept: { folders: plans, screen: true }, screenAvailable: false });
  await noScreen.handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  assert.deepEqual(noScreen.calls.at(-1), ["save", { folders: plans, screen: false, internet: false }]);
});

test("My Cloud's page lends Apps and screen only after this app's own dialog, keeps what else is lent, and takes it back at once", async () => {
  const plans = [{ id: "p", path: "/Users/me/Plans", name: "Plans", write: false }];
  const lent = setup({ enabled: true, kept: { folders: plans, screen: false, internet: true } });
  const on = await lent.handlers.get("cloud-lending:screen")({ page: "cloud" }, true);
  assert.deepEqual(lent.calls, [["confirm"], ["save", { folders: plans, screen: true, internet: true }]]);
  assert.equal(on.screen, true);
  const off = await lent.handlers.get("cloud-lending:screen")({ page: "cloud" }, false);
  assert.deepEqual(lent.calls.slice(2), [["save", { folders: plans, screen: false, internet: true }]]);
  assert.equal(off.screen, false);

  const declined = setup({ enabled: true, kept: { folders: plans, screen: false }, confirm: false });
  assert.equal((await declined.handlers.get("cloud-lending:screen")({ page: "cloud" }, true)).screen, false);
  assert.deepEqual(declined.calls, [["confirm"]]);
});

test("Apps and screen is never lent from My Cloud's page while lending is off or computer control isn't set up", async () => {
  const off = setup();
  assert.equal((await off.handlers.get("cloud-lending:screen")({ page: "cloud" }, true)).on, false);
  const unavailable = setup({ enabled: true, screenAvailable: false });
  assert.equal((await unavailable.handlers.get("cloud-lending:screen")({ page: "cloud" }, true)).screen, false);
  assert.deepEqual([...off.calls, ...unavailable.calls], []);
});

test("the move's default grant: the usual folders read only, each project folder with editing, the internet connection, and the screen when lent before or already working here", async () => {
  const fresh = setup();
  const lent = await fresh.lending.lendByDefault({ projects: ["/Users/me/code/site", "/Users/me", "relative/path", "/Users/me/Gone"] });
  assert.deepEqual(fresh.calls, [["save", { folders: [...usual, { id: fresh.calls[0][1].folders[3].id, path: "/Users/me/code/site", name: "site", write: true }], screen: false, internet: true }]],
    "a project folder that is the home folder, relative or gone is left out, never failing the move");
  assert.equal(lent.internet, true);
  const screenBefore = setup({ kept: { folders: [], screen: true }, stopped: { reason: "signed-out", at: 1 } });
  await screenBefore.lending.lendByDefault();
  assert.deepEqual(screenBefore.calls.at(-1)[1].screen, true, "the screen lent before is lent again");
  const notAvailable = setup({ kept: { folders: [], screen: true }, screenAvailable: false });
  await notAvailable.lending.lendByDefault();
  assert.equal(notAvailable.calls.at(-1)[1].screen, false, "not when this app's computer control is not ready");
  const workingHere = setup({ screenReady: true });
  assert.equal((await workingHere.lending.lendByDefault({ projects: [] })).screen, true, "apps and screen this computer's own bots could use are lent too, with no dialog");
  assert.deepEqual(workingHere.calls.map(([kind]) => kind), ["save"]);
  assert.equal(defaultGrant({ usual, projects: [], screenAvailable: false, screenReady: true }).screen, false, "never while computer control can't be reached");
  // A project inside a usual folder is its own entry; the same folder twice keeps editing.
  assert.deepEqual(defaultGrant({ kept: { folders: [{ ...usual[0], write: false }] }, usual, projects: [{ ...usual[0], write: true }] }).folders.map((folder) => [folder.name, folder.write]),
    [["Desktop", true], ["Documents", false], ["Downloads", false]]);
});

test("Use my Mac lends apps and screen on top of what is lent, once computer control works; never while lending is off", async () => {
  const plans = [{ id: "p", path: "/Users/me/Plans", name: "Plans", write: true }];
  const lent = setup({ enabled: true, kept: { folders: plans, screen: false, internet: true } });
  assert.equal((await lent.lending.lendScreen()).screen, true);
  assert.deepEqual(lent.calls, [["save", { folders: plans, screen: true, internet: true }]], "no dialog: the person chose it in this app's own popup");
  await lent.lending.lendScreen();
  assert.equal(lent.calls.length, 1, "lent once");
  const off = setup({ kept: { folders: plans, screen: false } });
  assert.equal(await off.lending.lendScreen(), null);
  const unavailable = setup({ enabled: true, screenAvailable: false });
  assert.equal(await unavailable.lending.lendScreen(), null);
  assert.deepEqual([...off.calls, ...unavailable.calls], []);
  assert.deepEqual(await setup({ screenReady: true, stopped: { reason: "you", at: 1 } }).lending.state(),
    { available: true, on: false, status: null, folders: [], screen: false, screenAvailable: true, internet: false, screenReady: true, ownOff: true });
});

test("the person's own Off is never undone: the move's default leaves lending off, while other stops are lent again", async () => {
  const off = setup();
  await off.handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  await off.handlers.get("cloud-lending:set")({ page: "cloud" }, false);
  const calls = off.calls.length;
  assert.equal(await off.lending.lendByDefault({ projects: ["/Users/me/code/site"] }), null);
  assert.equal(off.calls.length, calls, "nothing saved");
  const signedOut = setup({ stopped: { reason: "signed-out", at: 1 } });
  assert.equal((await signedOut.lending.lendByDefault()).on, true);
  // The person choosing Use my Mac, or turning it on again themselves, still works.
  assert.equal((await off.lending.lendByDefault({ asked: true })).on, true);
  await off.handlers.get("cloud-lending:set")({ page: "cloud" }, false);
  assert.equal((await off.handlers.get("cloud-lending:set")({ page: "cloud" }, true)).on, true);
});

test("lending's Cloud comes from the verified sign-in, and survives a brief disconnect of the same account only", () => {
  let state = { status: "connected", account: { id: "acct_1" }, machine: { origin: "https://omb-u-1.fly.dev" } };
  const cloud = { id: "cloud", origin: "https://omb-u-1.fly.dev" };
  const target = createLendingTarget({ account: () => ({ state: () => state }), environments: () => [{ id: "other", origin: "https://other.example" }, cloud] });
  assert.deepEqual(target.cloud(), { status: "connected", accountId: "acct_1", origin: "https://omb-u-1.fly.dev" });
  assert.equal(target.environment(), cloud);
  state = { status: "unavailable", account: { id: "acct_1" }, machine: null };
  assert.equal(target.environment(), cloud, "the same account, briefly unreachable");
  state = { status: "unavailable", account: { id: "acct_2" }, machine: null };
  assert.equal(target.environment(), null, "another account never inherits it");
  state = { status: "signed-out", message: "restoring", account: null, machine: null };
  assert.equal(target.cloud().status, "restoring");
  assert.equal(createLendingTarget({ account: () => null, environments: () => [cloud] }).environment(), null);
});

test("only this computer's own Settings chooses folders; any other page gets nothing", async () => {
  const { handlers } = setup();
  for (const channel of ["lending:state", "lending:folder", "lending:save", "lending:stop"]) assert.throws(() => handlers.get(channel)({ page: "cloud" }), /only available/, channel);
  for (const channel of ["cloud-lending:state", "cloud-lending:set", "cloud-lending:screen"]) assert.throws(() => handlers.get(channel)({ page: null }), /only available/, channel);
});

test("the usual folders: each one that exists and passes the folder checks, the rest left out", async () => {
  const found = await usualFolders(["/a/Desktop", "/a/Missing", "/a/Documents"], async ([folder]) => {
    if (folder.path.endsWith("Missing")) throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    return [{ ...folder, name: folder.path.split("/").pop() }];
  });
  assert.deepEqual(found.map((folder) => [folder.name, folder.write]), [["Desktop", false], ["Documents", false]]);
  assert.deepEqual(pageLending({ available: true, state: { enabled: false, folders: usual, internet: true, problem: "signed-out" } }), { available: true, on: false, status: "signed-out", folders: [], screen: false, screenAvailable: false, internet: false });
  assert.equal(pageLending({ available: true, state: { enabled: true, connected: true, folders: [], internet: true, link: "unsupported" } }).link, "unsupported", "the page can say My Cloud is updating");
});

test("a folder lent before and gone since is left out instead of failing the switch; with none left, the usual folders go", async () => {
  const gone = [{ id: "g", path: "/Users/me/Gone", name: "Gone", write: false }];
  const onlyGone = setup({ kept: { folders: gone, screen: false } });
  await onlyGone.handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  assert.deepEqual(onlyGone.calls.at(-1), ["save", { folders: usual, screen: false, internet: true }]);
  const plans = { id: "p", path: "/Users/me/Plans", name: "Plans", write: false };
  const mixed = setup();
  await mixed.handlers.get("lending:save")({ page: "local" }, { folders: [...gone, plans], screen: false });
  assert.deepEqual(mixed.calls, [["save", { folders: [plans], screen: false, internet: false }]]);
});

test("only a folder that is gone is left out; any other refusal still fails the switch", async () => {
  const refuse = async ([folder]) => {
    if (folder.path === "/Users/me") throw new Error("Choose specific folders, not the entire computer or home folder");
    if (folder.path.endsWith("Gone")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return [folder];
  };
  assert.deepEqual(await existingFolders([{ path: "/Users/me/Gone" }, { path: "/Users/me/Plans" }], refuse), [{ path: "/Users/me/Plans" }]);
  await assert.rejects(existingFolders([{ path: "/Users/me" }], refuse), /not the entire computer/);
});

test("a usual folder the system places at the home folder or a whole disk is looked for by its usual name instead, and else left out", async () => {
  // This platform's own paths, as main builds them: /home/me/Documents here, C:\home\me\Documents on Windows.
  const ROOT = path.parse(process.cwd()).root;
  const HOME = path.join(ROOT, "home", "me");
  const at = (name) => path.join(HOME, name);
  const exists = new Set([at("Desktop"), at("Documents")]);
  const validate = async ([folder]) => {
    if (folder.path === HOME || folder.path === ROOT) throw Object.assign(new Error("Choose specific folders, not the entire computer or home folder"), { code: "HOME_OR_ROOT" });
    if (!exists.has(folder.path)) throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    return [{ ...folder, name: path.basename(folder.path) }];
  };
  // Linux without user-dirs.dirs: Documents and Downloads are the home folder itself.
  const linux = await usualFolders(usualFolderPaths((name) => name === "desktop" ? at("Desktop") : HOME, HOME), validate);
  assert.deepEqual(linux.map((folder) => folder.path), [at("Desktop"), at("Documents")], "Documents by its usual name; no Downloads anywhere, so none");
  // A usual folder placed at a whole disk.
  const root = await usualFolders(usualFolderPaths((name) => name === "documents" ? ROOT : path.join(ROOT, "nowhere", name), HOME), validate);
  assert.deepEqual(root.map((folder) => folder.path), [at("Documents")]);
  // Both names the same folder: lent once.
  const twice = await usualFolders([{ path: HOME, named: at("Documents") }, { path: at("Documents"), named: at("Documents") }], validate);
  assert.deepEqual(twice.map((folder) => folder.path), [at("Documents")]);
  // The usual name is never tried for a folder that is merely gone, and a usual folder that is a file is left out.
  const tried = [], elsewhere = path.join(ROOT, "elsewhere", "Docs");
  await usualFolders([{ path: elsewhere, named: at("Documents") }], async ([folder]) => { tried.push(folder.path); throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  assert.deepEqual(tried, [elsewhere]);
  assert.deepEqual(await usualFolders([at("notes.txt")], async () => { throw Object.assign(new Error("Choose a folder, not a file"), { code: "NOT_FOLDER" }); }), []);
});

test("with the real folder checks and a home folder with Documents only, the usual folders are Documents, never the home folder", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import("node:fs");
  const { homedir, tmpdir } = await import("node:os");
  const { validateSharedFolders } = await import("./computer-sharing.mjs");
  // The folder checks' own spelling (fsp.realpath is the native one): on Windows the long name, never 8.3 (RUNNER~1).
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "omb-lend-home-")));
  // The home folder the checks guard is os.homedir(): HOME on macOS and Linux, USERPROFILE on Windows.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    mkdirSync(path.join(home, "Documents"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(realpathSync.native(homedir()), home, "the folder checks take this temporary folder for the home folder");
    const found = await usualFolders(usualFolderPaths((name) => name === "desktop" ? path.join(home, "Desktop") : home, home), validateSharedFolders);
    assert.deepEqual(found.map((folder) => [folder.path, folder.name, folder.write]), [[path.join(home, "Documents"), "Documents", false]]);
    await assert.rejects(validateSharedFolders([{ id: "8b0c8d3e-1f2a-4b5c-8d6e-7f8091a2b3c4", path: home, write: false }]), { code: "HOME_OR_ROOT" }, "a folder picked by hand still refuses the home folder");
  } finally {
    // Assigning undefined would set the text "undefined", so a variable that was unset is removed again.
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(home, { recursive: true, force: true });
  }
});

test("with no usual folders the internet connection is still lent; a refused folder is said plainly (no Try again); anything else is passed on as it was", async () => {
  const handlers = new Map(), calls = [];
  let fail = null, chosen = null;
  installCloudLending({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: (_channel, handler) => handler, cloudPage: (_channel, handler) => handler,
    snapshot: async () => ({ available: true, screenAvailable: false, state: { enabled: false, folders: chosen ?? [], screen: false } }),
    environment: () => ({ id: "cloud" }),
    save: async (_env, choice) => { calls.push(["save", choice]); if (fail) throw fail; },
    stop: () => {},
    chooseFolder: async () => { throw Object.assign(new Error("Choose specific folders, not the entire computer or home folder"), { code: "HOME_OR_ROOT" }); },
    defaults: async () => [],
    validate: async ([folder]) => { throw Object.assign(new Error(`refused ${folder.path}`), { code: "NOT_FOLDER" }); },
  });
  await handlers.get("cloud-lending:set")({ page: "cloud" }, true);
  assert.deepEqual(calls, [["save", { folders: [], screen: false, internet: true }]], "a computer with no usual folders lends its internet connection");
  calls.length = 0;
  await assert.rejects(handlers.get("lending:folder")({ page: "local" }), { message: "lending-refused:home-or-root" });
  chosen = [{ id: "f", path: "/Users/me/notes.txt", name: "notes.txt", write: false }];
  await assert.rejects(handlers.get("cloud-lending:set")({ page: "cloud" }, true), { message: "lending-refused:not-folder" });
  fail = new Error("My Cloud didn't answer");
  await assert.rejects(handlers.get("lending:save")({ page: "local" }, { folders: [], screen: true }), { message: "My Cloud didn't answer" });
});

test("My Cloud's page asks main to lend Apps and screen only from the person's click; taking it back needs none", async () => {
  const page = (activation) => {
    let bridge; const invoked = [];
    vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
      process: { platform: "darwin", argv: ["--omb-local-origin=http://127.0.0.1:5173", "--omb-company-desktop=1"] },
      location: { origin: "https://my.mausbot.example" }, navigator: { userActivation: { isActive: activation } },
      TextEncoder, localStorage: { getItem: () => null },
      require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: () => false, invoke: (...args) => { invoked.push(args); return Promise.resolve({}); } } }),
    });
    return { bridge, invoked };
  };
  const unclicked = page(false);
  await assert.rejects(unclicked.bridge.cloudLending.screen(true), /Tick Apps and screen/);
  await unclicked.bridge.cloudLending.screen(false);
  const clicked = page(true);
  await clicked.bridge.cloudLending.screen(true);
  assert.deepEqual([...unclicked.invoked, ...clicked.invoked].filter(([channel]) => channel === "cloud-lending:screen"), [["cloud-lending:screen", false], ["cloud-lending:screen", true]]);
  // A bot's Use my Mac link only opens main's own popup, and only from the person's click.
  await assert.rejects(unclicked.bridge.cloudLending.offer(), /Press Use my Mac/);
  await clicked.bridge.cloudLending.offer();
  assert.deepEqual([...unclicked.invoked, ...clicked.invoked].filter(([channel]) => channel === "cloud-lending:offer"), [["cloud-lending:offer"]]);
});
