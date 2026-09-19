import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { withOpenAIConnectionKey } from "./workspace-credentials.mjs";

// Execute production IPC handlers with an isolated credential document and
// synthetic loopback responses. This does not exercise the OS keychain.
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const from = source.indexOf("async function mutateOpenAIConnection(");
const to = source.indexOf('ipcMain.handle("approvals:set-trusted-mode"', from);
assert.ok(from >= 0 && to > from);
const origin = "http://127.0.0.1:48799";

function fixture() {
  const handlers = new Map(), requests = [], persisted = [];
  const initial = { xaiApiKey: "untouched", openaiConnectionKeys: {
    "api-a": { key: "old-a", url: "https://a.example/v1" },
    "api-b": { key: "key-b", url: "https://b.example/v1" },
  } };
  const state = createSecureCredentialState(initial, async value => persisted.push(structuredClone(value)));
  const f = { status: 200, encryption: true, requests, persisted, state };
  localOrigin.setLocalOrigin(origin);
  const frame = { url: `${origin}/` };
  const sender = { mainFrame: frame };
  const event = { sender, senderFrame: frame };
  const context = vm.createContext({
    app: { isPackaged: true }, desktopRemoteAccess: null, environmentsState: {},
    activeEnvironment: () => null, serverReady: true, SERVER_PORT: 48799,
    safeStorage: { isAsyncEncryptionAvailable: async () => f.encryption },
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    desktopMutationToken: "synthetic-desktop-token",
    desktopServerHeaders: (headers, options) => ({ ...headers, "x-fixture-token": options.token }),
    localOnly: localOrigin.localOnly, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    withOpenAIConnectionKey,
    updateSecureCredentialDocument: (derive, afterPersist) => state.update(derive, afterPersist),
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, origin);
      requests.push({ url, options, credentialsAtRequest: persisted.at(-1) });
      return Response.json(f.status === 200 ? { ok: true } : { error: "Connection is in use" }, { status: f.status });
    },
  });
  vm.runInContext(source.slice(from, to), context);
  return Object.assign(f, { context, invoke: (kind, input, fromEvent = event) => handlers.get(`openai-connection:${kind}`)(fromEvent, input), event });
}

test("saves the exact new connection key before making it live, and never sends it back", async () => {
  const f = fixture();
  const result = await f.invoke("save", { displayName: "Provider A", url: "https://a.example/v1", auth: "bearer", key: "new-a" });
  const id = "api-11111111-1111-4111-8111-111111111111";
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(f.requests[0].credentialsAtRequest.openaiConnectionKeys[id], { key: "new-a", url: "https://a.example/v1" });
  assert.equal(f.requests[0].url, `${origin}/api/instances/openai-compatible?secretStorage=external`);
  assert.equal(JSON.parse(f.requests[0].options.body).instanceId, id);
  assert.equal(f.state.read().openaiConnectionKeys["api-b"].key, "key-b");
});

test("preserves omitted keys and clears only the selected key for unauthenticated connections", async () => {
  const f = fixture();
  await f.invoke("save", { instanceId: "api-a", displayName: "Renamed", auth: "bearer" });
  assert.equal(f.state.read().openaiConnectionKeys["api-a"].key, "old-a");
  await f.invoke("save", { instanceId: "api-a", auth: "none" });
  assert.deepEqual(f.state.read().openaiConnectionKeys, { "api-b": { key: "key-b", url: "https://b.example/v1" } });
});

test("restores the key if the server refuses deletion of a referenced connection", async () => {
  const f = fixture();
  f.status = 409;
  await assert.rejects(f.invoke("remove", "api-a"), /Connection is in use/);
  assert.equal(f.requests[0].options.method, "DELETE");
  assert.equal(f.requests[0].credentialsAtRequest.openaiConnectionKeys["api-a"], undefined);
  assert.equal(f.state.read().openaiConnectionKeys["api-a"].key, "old-a");
});

test("remote workspace and unavailable store failures do not write credentials", async () => {
  const f = fixture();
  const remoteFrame = { url: "https://remote.example/" };
  assert.throws(() => f.invoke("remove", "api-a", { sender: { mainFrame: remoteFrame }, senderFrame: remoteFrame }), /local server/);
  f.context.desktopRemoteAccess = {};
  await assert.rejects(f.invoke("remove", "api-a"), /selected workspace server/);
  f.context.desktopRemoteAccess = null;
  f.encryption = false;
  await assert.rejects(f.invoke("remove", "api-a"), /credential store is unavailable/);
  assert.equal(f.persisted.length, 0);
  assert.equal(f.requests.length, 0);
});

test("development retains the server-owned credential persistence path", async () => {
  const f = fixture();
  f.context.app.isPackaged = false;
  await f.invoke("save", { instanceId: "api-a", auth: "bearer", key: "development-key" });
  assert.equal(f.persisted.length, 0);
  assert.equal(f.requests[0].url, `${origin}/api/instances/api-a/openai-compatible`);
});
