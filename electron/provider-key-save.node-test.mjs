import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import * as patches from "./credential-patch.mjs";

function loadSave({ encryption }) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function saveWorkspaceCredential(");
  const end = source.indexOf('ipcMain.handle("credential:set"', start);
  assert.ok(start >= 0 && end > start);
  const fetches = [];
  const stored = [];
  const context = vm.createContext({
    app: { isPackaged: true },
    safeStorage: { isAsyncEncryptionAvailable: async () => encryption },
    serverReady: true,
    SERVER_PORT: 49_321,
    desktopMutationToken: "token",
    desktopServerHeaders: (headers) => headers,
    fetch: async (url, init) => { fetches.push({ url, init }); return { ok: true, json: async () => ({}) }; },
    updateSecureCredentialDocument: async (mutate, apply) => { stored.push(mutate({})); return apply(); },
    ...patches,
  });
  vm.runInContext(source.slice(start, end), context);
  return { save: context.saveWorkspaceCredential, fetches, stored };
}

test("a phone's provider key reaches the server's settings, never the encrypted store", async () => {
  const { save, fetches, stored } = loadSave({ encryption: false });
  await save("anthropicApiKey", " sk-ant-fake ");
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "http://127.0.0.1:49321/api/config");
  assert.equal(fetches[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(fetches[0].init.body), { anthropic: { key: "sk-ant-fake", everyClaudeBot: false } });
  assert.deepEqual(stored, []);
});

test("a desktop slot key still goes through the encrypted store", async () => {
  const { save, fetches, stored } = loadSave({ encryption: true });
  await save("xaiApiKey", "xai-fake");
  assert.deepEqual(stored, [{ xaiApiKey: "xai-fake" }]);
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0].url.endsWith("/api/config?secretStorage=external"));
});
