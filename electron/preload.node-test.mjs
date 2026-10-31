import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

// Node tests run without Electron: satisfy preload's require("electron") from the require cache; the real preload still runs.
const require = createRequire(import.meta.url);

const listeners = new Map();
const exposed = { name: null, api: null };
const invocations = [];
const fakeIpcRenderer = {
  on: (channel, handler) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(handler);
  },
  removeListener: (channel, handler) => {
    listeners.get(channel)?.delete(handler);
  },
  invoke: async (...args) => { invocations.push(args); },
  send: () => undefined,
};
const fakeElectron = {
  ipcRenderer: fakeIpcRenderer,
  contextBridge: {
    exposeInMainWorld: (name, api) => {
      exposed.name = name;
      exposed.api = api;
    },
  },
  webUtils: { getPathForFile: () => "" },
};

const electronEntry = require.resolve("electron");
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: fakeElectron,
};
require("./preload.cjs");

const emit = (channel, ...args) => {
  for (const handler of listeners.get(channel) ?? []) handler({}, ...args);
};
const subscriberCount = (channel) => listeners.get(channel)?.size ?? 0;

test("exposes the full local-shell bridge on window.ogb", () => {
  assert.equal(exposed.name, "ogb");
  assert.equal(typeof exposed.api, "object");
  assert.equal(typeof exposed.api.onOpenAppSettings, "function");
});

test("openLogsFolder asks main for its own logs folder and names no path", async () => {
  const before = invocations.length;
  await exposed.api.openLogsFolder("C:\\Windows\\System32");
  assert.deepEqual(invocations.slice(before), [["desktop:open-logs"]]);
});

test("copyText forwards only the text over the explicit clipboard:write-text channel", async () => {
  const before = invocations.length;
  await exposed.api.copyText("hello");
  assert.deepEqual(invocations.slice(before), [["clipboard:write-text", "hello"]]);
  assert.equal("ipcRenderer" in exposed.api, false);
});

test("browser control forwards a separate per-device capability, not the cloud grant", async () => {
  const before = invocations.length;
  await exposed.api.companion.browserControl("phone-1", true);
  await exposed.api.companion.browserControl("phone-1", false);
  assert.deepEqual(invocations.slice(before), [
    ["companion:browser-control", "phone-1", true],
    ["companion:browser-control", "phone-1", false],
  ]);
});

test("the talk bridge asks main over its own channels with only what it understands", async () => {
  const before = invocations.length;
  await exposed.api.talkShortcut.state();
  await exposed.api.talkShortcut.set({ enabled: false, key: "ctrl-shift-space", extra: "x" });
  await exposed.api.callActive(true);
  await exposed.api.callActive("yes");
  assert.deepEqual(invocations.slice(before), [["talk-shortcut:state"], ["talk-shortcut:set", { enabled: false, key: "ctrl-shift-space" }], ["call:active", true], ["call:active", false]]);
});

test("account prepare asks for the secure address over its own channel and sends nothing from the page", async () => {
  const before = invocations.length;
  await exposed.api.companionAccount.prepare({ endpoint: "https://evil.example.test" });
  assert.deepEqual(invocations.slice(before), [["companion-account:prepare"]]);
});

test("onOpenAppSettings subscribes to the exact app:open-settings channel, forwards every emit, and unsubscribes cleanly", () => {
  // main.mjs sends "app:open-settings"; a different name would leave the shortcut inert while menu tests still pass.
  const cbCalls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(() => cbCalls.push(1));
  assert.equal(subscriberCount("app:open-settings"), 1);

  emit("app:open-settings");
  emit("app:open-settings");
  assert.equal(cbCalls.length, 2);

  unsubscribe();
  assert.equal(subscriberCount("app:open-settings"), 1, "the preload retains its cold-start listener");
  emit("app:open-settings");
  assert.equal(cbCalls.length, 2);
});

test("an organisation action arriving before React subscriptions is delivered exactly once after mount", async () => {
  emit("app:open-settings", "organization");
  const calls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(["app", section]));
  const unsubscribePanel = exposed.api.onOpenAppSettings(section => calls.push(["panel", section]));
  assert.deepEqual(calls, []);
  await Promise.resolve();
  assert.deepEqual(calls, [["app", "organization"], ["panel", "organization"]]);
  unsubscribe(); unsubscribePanel();
  const late = exposed.api.onOpenAppSettings(section => calls.push(["late", section]));
  await Promise.resolve();
  assert.equal(calls.length, 2, "later subscriptions must not reopen Settings");
  late();
});

test("a transient subscription cannot consume a cold-start action before the actual mount", async () => {
  emit("app:open-settings", "organization");
  const calls = [];
  exposed.api.onOpenAppSettings(section => calls.push(section))();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(section));
  await Promise.resolve();
  assert.deepEqual(calls, ["organization"]);
  unsubscribe();
});

test("native Settings requests accept only the fixed organisation section, Cloud link and plain Cloud settings", () => {
  const calls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(section));
  emit("app:open-settings", "organization");
  emit("app:open-settings", "cloud");
  emit("app:open-settings", "cloud-settings");
  emit("app:open-settings", "https://other.example");
  emit("app:open-settings", "cloudAccount");
  emit("app:open-settings", "openmausbot://cloud");
  emit("app:open-settings", { section: "organization", url: "https://other.example" });
  emit("app:open-settings", ["cloud"]);
  assert.deepEqual(calls, ["organization", "cloud", "cloud-settings", undefined, undefined, undefined, undefined, undefined]);
  unsubscribe();
});

test("a Cloud link arriving before React subscriptions is delivered exactly once after mount", async () => {
  emit("app:open-settings", "https://other.example");
  emit("app:open-settings", "cloud");
  const calls = [];
  const unsubscribe = exposed.api.onOpenAppSettings(section => calls.push(section));
  await Promise.resolve();
  assert.deepEqual(calls, ["cloud"]);
  unsubscribe();
  const late = exposed.api.onOpenAppSettings(section => calls.push(section));
  await Promise.resolve();
  assert.deepEqual(calls, ["cloud"], "later subscriptions must not reopen Settings");
  late();
});
