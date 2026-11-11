import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// Node tests run without Electron: satisfy preload's require("electron") from the require cache; the real preload still runs.
const require = createRequire(import.meta.url);
// The company desktop's keys are part of the bridge too: the test looks at the whole of it.
process.argv.push("--omb-company-desktop=1");
const exposed = { api: null };
const fakeElectron = {
  ipcRenderer: { on: () => undefined, removeListener: () => undefined, invoke: async () => undefined, send: () => undefined },
  contextBridge: { exposeInMainWorld: (_name, api) => { exposed.api = api; } },
  webUtils: { getPathForFile: () => "" },
};
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = { id: electronEntry, filename: electronEntry, loaded: true, exports: fakeElectron };
require("./preload.cjs");

const contract = JSON.parse(readFileSync(new URL("./bridge-contract.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const listed = (name) => {
  const match = new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`).exec(source);
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((found) => found[1]) : [];
};
const KEEP = `A Cloud or server page on ${contract.releases.join(" or ")} still calls it once this desktop updates ahead of that Cloud. `
  + "Keep it, as a stub if need be, for two releases after the last page that calls it; only then take it out of electron/bridge-contract.json.";

test("the bridge keeps every function a page of the last two releases calls", () => {
  for (const path of contract.paths) {
    const value = path.split(".").reduce((at, key) => at?.[key], exposed.api);
    assert.notEqual(value, undefined, `window.ogb.${path} is gone. ${KEEP}`);
  }
});

test("a Cloud or server page keeps the bridge keys it had, and the home page its own", () => {
  const remote = new Set(listed("REMOTE_SAFE")), home = new Set([...remote, ...listed("HOME_PAGE")]);
  for (const key of contract.remoteSafe) assert.ok(remote.has(key), `${key} left REMOTE_SAFE. ${KEEP}`);
  for (const key of contract.homePage) assert.ok(home.has(key), `${key} left the home page's bridge. ${KEEP}`);
});
