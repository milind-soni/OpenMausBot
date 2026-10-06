import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudPageSenderAllowed } from "./cloud-move.mjs";
import environments from "./environments.cjs";
import localOriginModule from "./local-origin.cjs";

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://home-7f3k2.fly.dev";
const OTHER = "https://bots.example.test";

const fixture = vi.hoisted(() => ({ autoUpdater: null, handlers: new Map() }));

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused-updater-test-log" },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: (name, handler) => fixture.handlers.set(name, handler) },
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({ autoUpdater: fixture.autoUpdater }),
}));

/** A page in the main window: its contents, and an IPC event it sends. */
function page(origin) {
  const mainFrame = { url: `${origin}/` };
  const webContents = { mainFrame, send: vi.fn() };
  return { webContents, event: { sender: webContents, senderFrame: mainFrame } };
}

/** main.mjs's own rule for who may use the updater, run against fakes of the
 * window, the saved servers and the Cloud sign-in it reads. */
function mainRule() {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("// ── Who asks, and where to"), end = source.indexOf("// ── end Copy this computer here ──", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  // main registers the updater's channels with exactly this rule.
  expect(source.includes("registerUpdaterIpc({ pageAllowed: updaterPageAllowed });"), "main.mjs wires the updater to updaterPageAllowed").toBe(true);
  const window = { isDestroyed: () => false, webContents: null };
  const context = vm.createContext({
    ipcMain: { handle: () => {} },
    senderIsLocal: localOriginModule.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: window,
    environmentsState: { environments: [], activeId: environments.LOCAL_ID },
    cloudAccount: { homeTarget: () => ({ origin: CLOUD }), state: () => ({ status: "connected", account: { id: "a1" } }) },
    rememberedHome: null,
  });
  vm.runInContext(source.slice(start, end), context);
  const show = (shown, activeId = environments.LOCAL_ID) => {
    window.webContents = shown.webContents;
    context.environmentsState = {
      environments: [{ id: "cloud", name: "My Cloud", origin: CLOUD }, { id: "vps", name: "VPS", origin: OTHER }],
      activeId,
    };
  };
  return { context, window, show, pageAllowed: vm.runInContext("updaterPageAllowed", context) };
}

/** A fresh updater module with a fake electron-updater behind it. */
async function load(pageAllowed) {
  vi.resetModules();
  fixture.handlers.clear();
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = vi.fn(async () => {
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-available", { version: "2.0.0" });
    return { isUpdateAvailable: true };
  });
  autoUpdater.downloadUpdate = vi.fn(async () => {
    autoUpdater.emit("download-progress", { percent: 50 });
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    return ["/unused-staged-update.zip"];
  });
  autoUpdater.quitAndInstall = vi.fn();
  fixture.autoUpdater = autoUpdater;
  const updater = await import("./updater.mjs");
  updater.registerUpdaterIpc({ pageAllowed });
  return { updater, autoUpdater, handlers: fixture.handlers };
}

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

beforeEach(() => {
  localOriginModule.setLocalOrigin(LOCAL);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The bridge preload.cjs gives a page at `origin`. */
function bridgeFor(origin, { clicked = false } = {}) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`] },
    location: { origin }, navigator: { userActivation: { isActive: clicked } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve({ status: "idle" }); } },
    }),
  });
  return { bridge, invoked };
}

it("a server's page gets the update bridge, and it restarts the app only on the person's click", async () => {
  const local = bridgeFor(LOCAL);
  expect(Object.keys(local.bridge.updater).sort()).toEqual(["check", "install", "onState"]);
  await local.bridge.updater.install();
  expect(local.invoked).toEqual([["update:install"]]);

  // Main answers only the person's own Cloud among servers (above); the bridge is there for it.
  const cloud = bridgeFor(CLOUD);
  expect(Object.keys(cloud.bridge.updater).sort()).toEqual(["check", "install", "onState"]);
  await expect(cloud.bridge.updater.install()).rejects.toThrow(/Restart to update/);
  await cloud.bridge.updater.check();
  cloud.bridge.updater.onState(() => {});
  expect(cloud.invoked).toEqual([["update:check"], ["update:get-state"]]);
  const clicked = bridgeFor(CLOUD, { clicked: true });
  await clicked.bridge.updater.install();
  expect(clicked.invoked).toEqual([["update:install"]]);
});

it("downloads an update by itself: the first check after launch starts it, and nothing restarts", async () => {
  const rule = mainRule();
  const local = page(LOCAL);
  rule.show(local);
  const { updater, autoUpdater } = await load(rule.pageAllowed);
  updater.attachUpdaterWindow(rule.window);
  updater.startUpdater();

  await vi.advanceTimersByTimeAsync(15_000);
  await settle();

  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  const statuses = local.webContents.send.mock.calls.map(([, state]) => state.status);
  expect(statuses).not.toContain("available");
  expect(statuses.at(-1)).toBe("downloaded");
});

it("My Cloud's page reads and drives the update channels, and another server's page is refused", async () => {
  const rule = mainRule();
  const { handlers } = await load(rule.pageAllowed);
  // There is no Download step left to ask for.
  expect([...handlers.keys()].sort()).toEqual(["update:check", "update:get-state", "update:install"]);

  const cloud = page(CLOUD);
  rule.show(cloud, "cloud");
  for (const channel of handlers.keys()) expect(() => handlers.get(channel)(cloud.event), channel).not.toThrow();
  // While the sign-in is being checked again, the Cloud this account last verified still counts.
  rule.context.cloudAccount = { homeTarget: () => null, state: () => ({ status: "unavailable", account: { id: "a1" } }) };
  rule.context.rememberedHome = { accountId: "a1", origin: CLOUD };
  expect(() => handlers.get("update:get-state")(cloud.event)).not.toThrow();
  rule.context.rememberedHome = { accountId: "someone-else", origin: CLOUD };
  expect(() => handlers.get("update:get-state")(cloud.event)).toThrow(/only available/);
  rule.context.cloudAccount = { homeTarget: () => ({ origin: CLOUD }), state: () => ({ status: "connected", account: { id: "a1" } }) };

  const other = page(OTHER);
  rule.show(other, "vps");
  for (const channel of handlers.keys()) expect(() => handlers.get(channel)(other.event), channel).toThrow(/only available/);
  // Nor may a page that only claims the Cloud's address, or a frame inside it.
  expect(() => handlers.get("update:get-state")({ sender: other.webContents, senderFrame: { url: `${CLOUD}/` } })).toThrow(/only available/);
  rule.show(cloud, "cloud");
  expect(() => handlers.get("update:get-state")({ sender: cloud.webContents, senderFrame: { url: `${CLOUD}/` } })).toThrow(/only available/);

  const local = page(LOCAL);
  rule.show(local);
  for (const channel of handlers.keys()) expect(() => handlers.get(channel)(local.event), channel).not.toThrow();
});

it("sends update news only to a page allowed to read it", async () => {
  const rule = mainRule();
  const { updater, autoUpdater, handlers } = await load(rule.pageAllowed);
  updater.attachUpdaterWindow(rule.window);
  updater.startUpdater();

  let finish;
  autoUpdater.downloadUpdate = vi.fn(() => new Promise((resolve) => { finish = resolve; }).then(() => {
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    return ["/unused-staged-update.zip"];
  }));

  const other = page(OTHER);
  rule.show(other, "vps");
  await vi.advanceTimersByTimeAsync(15_000);
  await settle();
  expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(other.webContents.send).not.toHaveBeenCalled();
  expect(() => handlers.get("update:get-state")(other.event)).toThrow(/only available/);

  // The person goes to My Cloud while it downloads: that page reads it, then hears it is ready.
  const cloud = page(CLOUD);
  rule.show(cloud, "cloud");
  expect(handlers.get("update:get-state")(cloud.event)).toMatchObject({ status: "downloading", version: "2.0.0" });
  finish();
  await settle();
  expect(cloud.webContents.send).toHaveBeenLastCalledWith("update:state", expect.objectContaining({ status: "downloaded", version: "2.0.0" }));
  expect(other.webContents.send).not.toHaveBeenCalled();
});

it("sends updater progress to a reopened window without restarting the updater", async () => {
  const rule = mainRule();
  const first = page(LOCAL);
  rule.show(first);
  const { updater, autoUpdater, handlers } = await load(rule.pageAllowed);
  updater.attachUpdaterWindow({ webContents: first.webContents });
  updater.startUpdater();
  const listenerCount = autoUpdater.eventNames().reduce((count, name) => count + autoUpdater.listenerCount(name), 0);
  const timerCount = vi.getTimerCount();

  first.webContents.send.mockImplementation(() => { throw new Error("window destroyed"); });
  first.webContents.send.mockClear();
  const reopened = page(LOCAL);
  rule.show(reopened);
  updater.attachUpdaterWindow(rule.window);

  await handlers.get("update:check")(reopened.event);
  await settle();

  expect(first.webContents.send).not.toHaveBeenCalled();
  expect(reopened.webContents.send.mock.calls.map(([, state]) => state.status))
    .toEqual(["checking", "downloading", "downloading", ...(process.platform === "darwin" ? ["preparing"] : []), "downloaded"]);
  expect(autoUpdater.eventNames().reduce((count, name) => count + autoUpdater.listenerCount(name), 0)).toBe(listenerCount);
  expect(vi.getTimerCount()).toBe(timerCount);
});
