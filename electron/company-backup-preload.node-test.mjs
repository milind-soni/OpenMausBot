import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { WORKSPACE_BACKUP_CLIENT_KEYS } from "../shared/workspace-backup-client.ts";

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const origin = "http://127.0.0.1:48992";
const requestId = "11111111-1111-4111-8111-111111111111";
function fixture({ remote = false, company = true, remoteClient = false, storage } = {}) {
  const listeners = new Map(), sent = [], invoked = [], values = new Map();
  const location = { origin: remote ? "https://remote.invalid" : origin };
  let bridge;
  const context = vm.createContext({
    process: { platform: "fixture", argv: [`--omb-local-origin=${origin}`, ...(company ? ["--omb-company-desktop=1"] : []), ...(remoteClient ? ["--openmausbot-remote-client"] : [])] },
    location, TextEncoder,
    localStorage: storage ?? { getItem: key => values.get(key) ?? null },
    require: name => {
      assert.equal(name, "electron");
      return { webUtils: {}, contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: {
        on: (channel, handler) => listeners.set(channel, handler),
        send: (channel, value) => sent.push([channel, JSON.parse(JSON.stringify(value))]),
        invoke: (channel, value) => { invoked.push([channel, value]); return Promise.resolve({ busy: false }); },
      } };
    },
  });
  vm.runInContext(source, context);
  return { values, sent, invoked, location, bridge, context,
    collect: input => listeners.get("company-backups:collect-client-state")?.({}, input),
    listening: listeners.has("company-backups:collect-client-state"),
  };
}

test("private snapshot allowlist stays exactly equal to the full-backup browser-state allowlist", () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(COMPANY_BACKUP_CLIENT_KEYS)", f.context)), [...WORKSPACE_BACKUP_CLIENT_KEYS]);
  assert.equal(f.sent.length, 0, "preload startup does not export data");
  assert.equal(f.bridge.companyBackups.collectClientState, undefined, "no renderer-callable snapshot capability");
});

test("each native request collects fresh allowed state and never credentials or unknown keys", () => {
  const f = fixture();
  f.values.set("omb-drafts", "first draft"); f.values.set("omb-skin", "dark");
  f.values.set("auth-token", "synthetic secret");
  f.collect({ requestId });
  assert.deepEqual(f.sent[0], ["company-backups:client-state", { requestId, clientState: { "omb-drafts": "first draft", "omb-skin": "dark" } }]);
  f.values.set("omb-drafts", "newer draft"); f.values.delete("omb-skin");
  f.collect({ requestId });
  assert.deepEqual(f.sent[1][1].clientState, { "omb-drafts": "newer draft" });
  assert.equal(JSON.stringify(f.sent).includes("synthetic secret"), false);
});

for (const options of [{ remote: true }, { company: false }, { remoteClient: true }]) {
  test(`snapshot listener is absent outside the owned local company desktop: ${JSON.stringify(options)}`, () => {
    const f = fixture(options); assert.equal(f.listening, false);
    f.collect({ requestId }); assert.equal(f.sent.length, 0);
  });
}

test("navigation, inaccessible storage and oversized UTF-8 snapshots return only a safe failure", () => {
  const navigated = fixture(); navigated.location.origin = "https://remote.invalid";
  const unreadable = fixture({ storage: { getItem: () => { throw new Error("private path"); } } });
  const oversized = fixture(); oversized.values.set("omb-drafts", "🐭".repeat(600_000));
  for (const f of [navigated, unreadable, oversized]) {
    f.collect({ requestId });
    assert.deepEqual(f.sent, [["company-backups:client-state", { requestId, unavailable: true }]]);
  }
});

test("invalid snapshot requests are ignored and schedule settings use only their narrow IPC", async () => {
  const f = fixture();
  for (const input of [null, {}, { requestId: "bad" }, { requestId: 7 }]) f.collect(input);
  assert.equal(f.sent.length, 0);
  const input = { enabled: false };
  await f.bridge.companyBackups.configureSchedule(input);
  assert.deepEqual(f.invoked, [["company-backups:configure-schedule", input]]);
});
