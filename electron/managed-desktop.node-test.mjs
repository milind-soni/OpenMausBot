import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { createManagedDesktopClient, createManagedDesktopRelay, createManagedDesktopStore, managedPortalOrigin } from "./managed-desktop.mjs";

const origin = "https://company.example.test";
const token = `omd_${"a".repeat(43)}`;
const modelToken = `omg_${"c".repeat(43)}`;
const deviceId = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const grant = () => ({ portalOrigin: origin, token, deviceId, organizationId, email: "person@example.test", expiresAt: Date.now() + 86400_000 });
const session = saved => ({ desktopContractVersion: 1, modelAccessToken: modelToken, device: { id: deviceId, organizationId, email: saved.email, revokedAt: null, expiresAt: saved.expiresAt },
  organization: { id: organizationId, name: "Example company" }, providers: [{ id: "openrouter", configured: true, models: ["fixture/model"] }], cloudBackups: true });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const branding = { logo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", icons: [] };
test("branding refreshes with the granted organization and disappears on disconnect", async t => {
  const saved = grant(); let current = branding;
  const f = fixture(t, { saved, handler: (url, options) => url.endsWith("/session") && options.method !== "DELETE" ? Response.json({ ...session(saved), branding: current }) : null });
  await f.client.start(); assert.deepEqual(f.client.state().branding, branding);
  assert.equal(f.applied.at(-1).branding, undefined, "cosmetic metadata never changes the runtime's strict model grant");
  assert.equal(f.record.value.branding, undefined, "branding is not persisted with credentials");
  current = { logo: "https://tracker.invalid/image", icons: [] };
  await f.client.refresh();
  assert.equal(f.client.state().status, "connected", "bad cosmetic data cannot break model access");
  assert.deepEqual(f.client.state().branding, { logo: null, icons: [] });
  await f.client.disconnect(); assert.equal(f.client.state().branding, undefined);
});
function fixture(t, { saved = null, handler, apply, write } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const applied = [], requests = [], opened = [], states = [], record = { value: saved };
  let writes = Promise.resolve();
  let approved = false;
  const client = createManagedDesktopClient({ platform: "linux", deviceName: "Fixture laptop", store: {
    read: async () => record.value,
    write: value => {
      const operation = writes.catch(() => {}).then(async () => { await write?.(value); record.value = structuredClone(value); });
      writes = operation; return operation;
    },
  }, applyConnection: async connection => { applied.push(connection); await apply?.(connection); }, openBrowser: async url => { opened.push(url); },
  onState: state => states.push(state), fetch: async (url, options) => {
    requests.push({ url, options });
    const overridden = await handler?.(url, options); if (overridden) return overridden;
    if (url.endsWith("/api/public/config")) return Response.json({ desktopContractVersion: 1, capabilities: { desktopEnrollment: true } });
    if (url.endsWith("/api/desktop/enrollment")) return Response.json({ deviceCode: "b".repeat(43), userCode: "ABCDE-FGHJK", verificationUriComplete: `${origin}/enroll?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    if (url.endsWith("/api/desktop/enrollment/token")) {
      const value = grant();
      return approved ? Response.json({ accessToken: value.token, expiresAt: value.expiresAt, device: { id: deviceId, organizationId, email: value.email } }) : Response.json({ error: "authorization_pending" }, { status: 400 });
    }
    if (url.endsWith("/api/desktop/session") && options.method === "DELETE") return Response.json({ ok: true });
    if (url.endsWith("/api/desktop/session")) return Response.json(session(record.value));
    throw new Error("Unexpected fixture route");
  } });
  t.after(() => client.close());
  return { client, record, applied, requests, opened, states, approve: () => { approved = true; }, tick: async ms => { t.mock.timers.tick(ms); await settle(); } };
}

test("accepts exact HTTPS origins and loopback fixtures, never URL credentials, paths or cleartext network hosts", () => {
  assert.equal(managedPortalOrigin(origin + "/"), origin);
  assert.equal(managedPortalOrigin("http://127.0.0.1:4444"), "http://127.0.0.1:4444");
  for (const input of ["http://company.example.test", `${origin}/workspaces`, `${origin}?token=secret`, "https://u:p@company.example.test", "file:///tmp/foo", "javascript:alert(1)"]) assert.throws(() => managedPortalOrigin(input));
});
test("enrollment requires browser consent, stores a separate token, and exposes no token to the renderer", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.client.start(), { status: "signed-out" });
  await f.client.begin({ portalOrigin: origin });
  assert.equal(f.client.state().status, "connecting");
  assert.deepEqual(f.opened, [`${origin}/enroll?code=ABCDE-FGHJK`]);
  assert.equal(f.record.value, null);
  await f.tick(5000); assert.equal(f.client.state().status, "connecting");
  f.approve(); await f.tick(5000);
  assert.equal(f.client.state().status, "connected");
  assert.equal(f.record.value.token, token);
  assert.equal(f.applied.at(-1).token, modelToken);
  assert.equal(f.client.state().providers[0].models[0], "fixture/model");
  assert(!JSON.stringify(f.states).includes(token));
  assert(!JSON.stringify(f.states).includes(modelToken));
  assert(!JSON.stringify(f.states).includes("b".repeat(43)));
  for (const { options } of f.requests) { assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); }
});
test("restores only the exact granted device and organisation", async t => {
  const f = fixture(t, { saved: grant(), handler: url => url.endsWith("/session") ? Response.json({ ...session(grant()), organization: { id: "33333333-3333-4333-8333-333333333333", name: "Other tenant" } }) : null });
  await f.client.start();
  assert.equal(f.client.state().status, "reauth-required");
  assert.deepEqual(f.applied, [null]);
});
test("disconnect removes only company access and revokes its own portal device", async t => {
  const f = fixture(t, { saved: grant() }); await f.client.start();
  await f.client.disconnect();
  assert.equal(f.record.value, null); assert.equal(f.applied.at(-1), null);
  assert.equal(f.client.state().status, "signed-out");
  const revoke = f.requests.find(row => row.options.method === "DELETE");
  assert.equal(revoke.url, `${origin}/api/desktop/session`);
  assert.equal(revoke.options.headers.authorization, `Bearer ${token}`);
});
test("portal revocation removes Company instances and never attempts a personal-account fallback", async t => {
  let revoked = false;
  const f = fixture(t, { saved: grant(), handler: () => revoked ? Response.json({ error: "invalid_token" }, { status: 401 }) : null });
  await f.client.start(); revoked = true; await f.client.refresh();
  assert.equal(f.client.state().status, "reauth-required"); assert.equal(f.applied.at(-1), null);
  await f.tick(120_000);
  assert.equal(f.applied.filter(Boolean).length, 1);
});
test("an expired saved token is not sent to the portal", async t => {
  const f = fixture(t, { saved: { ...grant(), expiresAt: Date.now() - 1 } }); await f.client.start();
  assert.equal(f.client.state().status, "reauth-required"); assert.equal(f.requests.length, 0);
});
test("temporary portal failures do not drop a previously valid Company snapshot or expose server errors", async t => {
  let unavailable = false;
  const f = fixture(t, { saved: grant(), handler: () => { if (unavailable) throw new Error(`network failure ${token}`); } });
  await f.client.start(); unavailable = true;
  const appliedBefore = f.applied.length;
  await f.client.refresh();
  assert.equal(f.client.state().status, "unavailable"); assert.equal(f.client.connection().token, modelToken);
  // A server process that restarted while offline has an empty overlay.
  assert.equal(f.applied.length, appliedBefore + 1); assert.equal(f.applied.at(-1).token, modelToken);
  assert(!JSON.stringify(f.states).includes(token));
  unavailable = false; await f.tick(60_000); assert.equal(f.client.state().status, "connected");
});
test("a malicious verification link never opens another origin", async t => {
  const f = fixture(t, { handler: url => url.endsWith("/enrollment") ? Response.json({ deviceCode: "b".repeat(43), userCode: "ABCDE-FGHJK", verificationUriComplete: "https://attacker.example.test", expiresIn: 600, interval: 5 }) : null });
  await f.client.begin({ portalOrigin: origin });
  assert.equal(f.client.state().status, "signed-out"); assert.deepEqual(f.opened, []);
});
test("cancel prevents a late enrollment response opening a browser", async t => {
  let release;
  const f = fixture(t, { handler: url => url.endsWith("/enrollment") ? new Promise(resolve => { release = resolve; }) : null });
  const begun = f.client.begin({ portalOrigin: origin }); await settle();
  await f.client.cancelEnrollment(); release(Response.json({})); await begun;
  assert.equal(f.client.state().status, "signed-out"); assert.deepEqual(f.opened, []);
});
test("cancel revokes a saved grant while its first session response is still pending", async t => {
  let release;
  const f = fixture(t, { handler: (url, options) => url.endsWith("/session") && options.method === "GET" ? new Promise(resolve => { release = resolve; }) : null });
  await f.client.begin({ portalOrigin: origin }); f.approve(); await f.tick(5000);
  const saved = f.record.value;
  assert(saved); assert.equal(f.client.state().status, "connecting");
  await f.client.cancelEnrollment();
  assert.equal(f.record.value, null); assert.equal(f.client.state().status, "signed-out");
  const deletes = f.requests.filter(row => row.options.method === "DELETE");
  assert.equal(deletes.length, 1); assert.equal(deletes[0].options.headers.authorization, `Bearer ${token}`);
  release(Response.json(session(saved))); await settle();
  assert.equal(f.client.state().status, "signed-out"); assert.equal(f.client.connection(), null);
  assert.deepEqual(f.applied, [null]);
});
test("cancel fences a granted enrollment whose runtime application completes late", async t => {
  let release;
  const f = fixture(t, { apply: value => value ? new Promise(resolve => { release = resolve; }) : undefined });
  await f.client.begin({ portalOrigin: origin }); f.approve(); await f.tick(5000);
  assert.equal(f.client.state().status, "connecting");
  await f.client.cancelEnrollment(); release(); await settle();
  assert.equal(f.record.value, null); assert.equal(f.client.connection(), null);
  assert.equal(f.client.state().status, "signed-out"); assert.equal(f.applied.at(-1), null);
  assert.equal(f.requests.filter(row => row.options.method === "DELETE").length, 1);
});
test("cancel queues durable removal after an in-flight token save and revokes the issued token", async t => {
  let release;
  const f = fixture(t, { write: value => value ? new Promise(resolve => { release = resolve; }) : undefined });
  await f.client.begin({ portalOrigin: origin }); f.approve(); await f.tick(5000);
  const cancelling = f.client.cancelEnrollment(); await settle();
  assert.equal(f.requests.filter(row => row.options.method === "DELETE").length, 1);
  release(); await cancelling; await settle();
  assert.equal(f.record.value, null); assert.equal(f.client.state().status, "signed-out");
  assert.equal(f.requests.filter(row => row.url.endsWith("/session") && row.options.method === "GET").length, 0);
});
test("a token response received after cancellation is revoked without persisting or applying it", async t => {
  let release;
  const f = fixture(t, { handler: url => url.endsWith("/enrollment/token") ? new Promise(resolve => { release = resolve; }) : null });
  await f.client.begin({ portalOrigin: origin }); await f.tick(5000);
  await f.client.cancelEnrollment();
  const saved = grant();
  release(Response.json({ accessToken: saved.token, expiresAt: saved.expiresAt, device: { id: deviceId, organizationId, email: saved.email } }));
  await settle();
  assert.equal(f.record.value, null); assert.equal(f.client.state().status, "signed-out");
  const revoked = f.requests.find(row => row.options.method === "DELETE");
  assert(revoked); assert.equal(revoked.options.signal.aborted, false);
  assert.deepEqual(f.applied, [null]);
});
test("runtime clear failure still removes the saved credential and revokes the portal device", async t => {
  const f = fixture(t, { saved: grant(), apply: value => { if (value === null) throw new Error(`runtime down ${modelToken}`); } });
  await f.client.start(); const state = await f.client.disconnect();
  assert.equal(f.record.value, null); assert.equal(f.client.connection(), null); assert.equal(state.status, "signed-out");
  assert.match(state.message, /did not confirm stopping/); assert(!state.message.includes(modelToken));
  assert.equal(f.requests.filter(row => row.options.method === "DELETE").length, 1);
  await f.client.disconnect(); // The first attempt already fulfilled remote revocation.
  assert.equal(f.requests.filter(row => row.options.method === "DELETE").length, 1);
});
test("failed durable removal preserves a cleanup target and blocks reconnect until retry succeeds", async t => {
  let locked = true;
  const f = fixture(t, { saved: grant(), write: value => { if (value === null && locked) throw new Error("locked fixture keychain"); } });
  await f.client.start(); await f.client.disconnect();
  assert.equal(f.client.state().status, "unavailable"); assert.match(f.client.state().message, /saved company sign-in could not be cleared/);
  assert(f.record.value); assert.equal(f.client.connection(), null);
  await assert.rejects(f.client.begin({ portalOrigin: origin }), /Disconnect/);
  await assert.rejects(f.client.requestBackup("/api/desktop/backups"), /Reconnect/);
  locked = false; await f.client.disconnect();
  assert.equal(f.record.value, null); assert.equal(f.client.state().status, "signed-out");
  assert.equal(f.requests.filter(row => row.options.method === "DELETE").length, 2);
});
test("new enrollment cannot overtake cancellation persistence and is usable afterward", async t => {
  let release;
  const f = fixture(t, { write: value => value === null ? new Promise(resolve => { release = resolve; }) : undefined });
  await f.client.begin({ portalOrigin: origin });
  const cancelling = f.client.cancelEnrollment(); await settle();
  await assert.rejects(f.client.begin({ portalOrigin: origin }), /Wait for company sign-out/);
  assert.equal(f.opened.length, 1);
  release(); await cancelling; await f.client.begin({ portalOrigin: origin });
  assert.equal(f.client.state().status, "connecting"); assert.equal(f.opened.length, 2);
});
test("late expiry cleanup cannot overwrite a new enrollment or coalesce its refresh", async t => {
  let release, clears = 0;
  const f = fixture(t, { saved: { ...grant(), expiresAt: Date.now() - 1 }, apply: value => value === null && clears++ === 0 ? new Promise(resolve => { release = resolve; }) : undefined });
  const starting = f.client.start(); await settle();
  await f.client.disconnect(); await f.client.begin({ portalOrigin: origin });
  f.approve(); await f.tick(5000);
  assert.equal(f.client.state().status, "connected");
  release(); await starting;
  assert.equal(f.client.state().status, "connected"); assert.equal(f.client.connection().token, modelToken);
});
test("slow-down responses increase the poll interval and consent denial stops retries", async t => {
  let count = 0;
  const f = fixture(t, { handler: url => url.endsWith("/enrollment/token") ? (count++ === 0 ? Response.json({ error: "slow_down", interval: 10 }, { status: 400 }) : Response.json({ error: "access_denied" }, { status: 400 })) : null });
  await f.client.begin({ portalOrigin: origin }); await f.tick(5000); await f.tick(5000);
  assert.equal(count, 1); await f.tick(5000); assert.equal(count, 2);
  assert.equal(f.client.state().status, "signed-out"); await f.tick(60_000); assert.equal(count, 2);
});
test("runtime failure never reports Company models as ready", async t => {
  const f = fixture(t, { saved: grant(), apply: async value => { if (value) throw new Error("fixture runtime down"); } });
  await f.client.start(); assert.equal(f.client.state().status, "unavailable"); assert.equal(f.client.connection(), null);
});
test("offline disconnect is explicit about remaining portal revocation", async t => {
  const f = fixture(t, { saved: grant(), handler: (_url, options) => { if (options.method === "DELETE") throw new Error("offline"); } });
  await f.client.start(); await f.client.disconnect();
  assert.equal(f.record.value, null); assert.match(f.client.state().message, /revoke this device/);
});
test("utility replies cannot be forged by another child or reused across requests", async () => {
  const relay = createManagedDesktopRelay(); let message;
  const proc = { postMessage: value => { message = value; } }, foreign = {};
  let completed = false; const operation = relay.send(proc, null).then(() => { completed = true; });
  relay.receive(foreign, { type: "openmausbot:managed-desktop-result", requestId: message.requestId, ok: true });
  await settle(); assert.equal(completed, false);
  relay.receive(proc, { type: "openmausbot:managed-desktop-result", requestId: message.requestId, ok: true });
  await operation; assert.equal(completed, true);
  const pending = relay.send(proc, { fixture: true }); relay.rejectProcess(proc);
  await assert.rejects(pending, /could not be connected/);
});
test("secure record is encrypted, atomic, bounded and does not follow a symlink on read", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omb-managed-store-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = randomBytes(32); let unlocked = true;
  const encryption = { available: async () => unlocked, encrypt: async text => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }, decrypt: async buffer => { const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12)); decipher.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8"); } };
  const file = path.join(root, "connection.bin"), store = createManagedDesktopStore({ file, encryption });
  assert.equal(await store.read(), null);
  const saved = grant(); await store.write(saved);
  assert(!(await fs.readFile(file)).includes(token)); assert.deepEqual(await store.read(), saved);
  unlocked = false; await assert.rejects(store.read(), /keychain/);
  await store.write(null); assert.equal(await store.read(), null);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await store.write(null); // Missing records are already forgotten.
  unlocked = true; await store.write(saved); assert.deepEqual(await store.read(), saved);
  await Promise.all([store.write(saved), store.write(null)]); assert.equal(await store.read(), null);
  assert.deepEqual(await fs.readdir(root), []);
  if (process.platform !== "win32") {
    await store.write(saved);
    const link = path.join(root, "link.bin"); await fs.symlink(file, link);
    await assert.rejects(createManagedDesktopStore({ file: link, encryption }).read(), /could not be read/);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});

test("a captured backup generation cannot send a later account's backup request", async t => {
  const f = fixture(t, { saved: grant() }); await f.client.start();
  const generation = f.client.backupGeneration();
  await f.client.disconnect();
  const count = f.requests.length;
  await assert.rejects(f.client.requestBackup("/api/desktop/backups", { generation }), /connection changed/);
  assert.equal(f.requests.length, count);
});
