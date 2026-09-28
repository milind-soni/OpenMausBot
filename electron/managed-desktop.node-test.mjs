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
function fixture(t, { saved = null, handler, apply, write, now, appVersion } = {}) {
  // A second client in the same test (a restart) shares the mocked clock.
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); } catch (error) { if (error?.code !== "ERR_INVALID_STATE") throw error; }
  const applied = [], policies = [], identities = [], requests = [], opened = [], states = [], record = { value: saved };
  let writes = Promise.resolve();
  let approved = false;
  const client = createManagedDesktopClient({ platform: "linux", deviceName: "Fixture laptop", store: {
    read: async () => record.value,
    write: value => {
      const operation = writes.catch(() => {}).then(async () => { await write?.(value); record.value = structuredClone(value); });
      writes = operation; return operation;
    },
  }, applyConnection: async connection => { applied.push(connection); await apply?.(connection); }, applyPolicy: async policy => { policies.push(policy); }, migrateIdentity: async identity => { identities.push({ identity, saved: structuredClone(record.value) }); },
  ...(now ? { now } : {}), ...(appVersion ? { appVersion } : {}), openBrowser: async url => { opened.push(url); },
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
  return { client, record, applied, policies, identities, requests, opened, states, approve: () => { approved = true; }, tick: async ms => { t.mock.timers.tick(ms); await settle(); } };
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
test("reopen opens only the pending attempt's own sign-in page, never a renderer address", async t => {
  const f = fixture(t), page = `${origin}/enroll?code=ABCDE-FGHJK`;
  await f.client.start();
  await f.client.reopen();
  assert.deepEqual(f.opened, [], "nothing is pending before sign-in starts");
  await f.client.begin({ portalOrigin: origin });
  assert.deepEqual(f.opened, [page]);
  const before = f.requests.length;
  const state = await f.client.reopen("https://attacker.example.test", { verificationUri: "https://attacker.example.test" });
  assert.deepEqual(f.opened, [page, page]);
  assert.equal(state.status, "connecting");
  assert.equal(f.requests.length, before, "reopening makes no portal request and starts no new attempt");
  f.approve(); await f.tick(5000);
  assert.equal(f.client.state().status, "connected");
  await f.client.reopen();
  assert.deepEqual(f.opened, [page, page], "a finished attempt is never reopened");
});
test("reopen does nothing after the attempt is cancelled or has expired", async t => {
  let clock = Date.now();
  const cancelled = fixture(t);
  await cancelled.client.begin({ portalOrigin: origin });
  await cancelled.client.cancelEnrollment();
  await cancelled.client.reopen();
  assert.deepEqual(cancelled.opened, [`${origin}/enroll?code=ABCDE-FGHJK`]);
  const expired = fixture(t, { now: () => clock });
  await expired.client.begin({ portalOrigin: origin });
  clock += 601_000;
  await expired.client.reopen();
  assert.deepEqual(expired.opened, [`${origin}/enroll?code=ABCDE-FGHJK`]);
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

const DAY = 86400_000;
const renewalConfig = (extra = {}) => Response.json({ desktopContractVersion: 1, capabilities: { desktopEnrollment: true, deviceRenewal: 1 }, license: { state: "active" }, ...extra });
const policy = (overrides = {}) => ({ version: 2, companyModelsOnly: true, allowedEngines: ["claudeAgent"], mcp: { allowCustom: false, allowlist: ["github"] },
  computers: { thisComputer: false, localVm: true, box: true, vps: true }, remoteAccess: false, futureField: "ignored", ...overrides });
const body = row => JSON.parse(row.options.body);

test("renews on start with an Admin that advertises it, keeping the deviceId and reporting the app", async t => {
  let clock = Date.now();
  const saved = { ...grant(), expiresAt: clock + 3 * DAY };
  const f = fixture(t, { saved, now: () => clock, appVersion: "0.1.86", handler: (url, options) => {
    if (url.endsWith("/api/public/config")) return renewalConfig();
    if (url.endsWith("/api/desktop/session/renew")) return Response.json({ renewed: true, expiresAt: clock + 30 * DAY, device: { id: deviceId, organizationId, email: saved.email } });
    if (url.endsWith("/api/desktop/session") && options.method !== "DELETE") return Response.json(session(f.record.value));
    return null;
  } });
  await f.client.start();
  assert.equal(f.client.state().status, "connected");
  assert.equal(f.record.value.expiresAt, clock + 30 * DAY); assert.equal(f.record.value.deviceId, deviceId); assert.equal(f.record.value.token, token);
  const renewals = f.requests.filter(row => row.url.endsWith("/session/renew"));
  assert.equal(renewals.length, 1);
  assert.deepEqual(body(renewals[0]), { platform: "linux", appVersion: "0.1.86" });
  assert.equal(renewals[0].options.headers.authorization, `Bearer ${token}`);
  // Not again while plenty of time remains; again once fewer than seven days are left.
  await f.client.refresh();
  assert.equal(f.requests.filter(row => row.url.endsWith("/session/renew")).length, 1);
  clock += 24 * DAY; await f.client.refresh();
  assert.equal(f.requests.filter(row => row.url.endsWith("/session/renew")).length, 2);
  assert.equal(f.client.state().status, "connected");
});

test("stores a rotated device token encrypted before using it", async t => {
  const rotated = `omd_${"z".repeat(43)}`, saved = grant();
  const f = fixture(t, { saved, handler: (url, options) => {
    if (url.endsWith("/api/public/config")) return renewalConfig();
    if (url.endsWith("/api/desktop/session/renew")) return Response.json({ renewed: true, accessToken: rotated, expiresAt: saved.expiresAt + DAY, device: { id: deviceId, organizationId, email: saved.email } });
    if (url.endsWith("/api/desktop/session") && options.method !== "DELETE") return Response.json(session(f.record.value));
    return null;
  } });
  await f.client.start();
  assert.equal(f.record.value.token, rotated); assert.equal(f.record.value.deviceId, deviceId);
  const heartbeat = f.requests.findLast(row => row.url.endsWith("/api/desktop/session") && row.options.method === "GET");
  assert.equal(heartbeat.options.headers.authorization, `Bearer ${rotated}`);
  assert(!JSON.stringify(f.states).includes(rotated));
});

test("adopts a later expiry after a renewal it could not save, and never an earlier one", async t => {
  const saved = grant();
  let served = saved.expiresAt + 10 * DAY;
  const f = fixture(t, { saved, handler: url => url.endsWith("/api/desktop/session") ? Response.json({ ...session(saved), device: { ...session(saved).device, expiresAt: served } }) : null });
  await f.client.start();
  assert.equal(f.client.state().status, "connected"); assert.equal(f.record.value.expiresAt, served);
  served = saved.expiresAt; await f.client.refresh();
  assert.equal(f.client.state().status, "reauth-required");
});

test("against an Admin without renewal or policies it behaves as before: no renewal, no policy", async t => {
  const f = fixture(t, { saved: grant() });
  await f.client.start();
  assert.equal(f.client.state().status, "connected");
  assert.equal(f.requests.filter(row => row.url.endsWith("/renew") || row.url.endsWith("/heartbeat")).length, 0);
  assert.deepEqual(f.policies, [null]); assert.equal(f.record.value.policy, undefined); assert.equal(f.client.policy(), null);
});

test("a lapsed Admin licence is not revocation: no sign-in loop, Company models unavailable, recovers by itself", async t => {
  let lapsed = false;
  const f = fixture(t, { saved: grant(), handler: (url, options) => lapsed && options.method !== "DELETE"
    ? Response.json({ code: "admin_license_expired", error: "Your organization's OpenMaus Admin license has expired." }, { status: 503 }) : null });
  await f.client.start(); lapsed = true;
  await f.client.refresh();
  assert.equal(f.client.state().status, "license-expired"); assert.equal(f.client.state().message, undefined);
  assert.equal(f.applied.at(-1).suspended, "license-expired"); assert.equal(f.applied.at(-1).token, modelToken);
  assert(f.applied.every(Boolean), "Company access is never torn down");
  assert.equal(f.requests.filter(row => row.options.method === "DELETE").length, 0);
  assert(f.record.value, "the saved sign-in is kept");
  const before = f.requests.length; await f.tick(60_000);
  assert(f.requests.length > before, "keeps checking"); assert.equal(f.client.state().status, "license-expired");
  lapsed = false; await f.tick(60_000);
  assert.equal(f.client.state().status, "connected"); assert.equal(f.applied.at(-1).suspended, undefined);
});

test("sign-in against an Admin whose licence expired says so instead of failing vaguely", async t => {
  const f = fixture(t, { handler: url => url.endsWith("/api/public/config") ? Response.json({ desktopContractVersion: 1, capabilities: { desktopEnrollment: true }, license: { state: "expired" } }) : null });
  await f.client.begin({ portalOrigin: origin });
  assert.deepEqual(f.client.state(), { status: "signed-out", notice: "license-expired" }); assert.deepEqual(f.opened, []);
});

test("applies the organisation policy read-only, keeps it with the encrypted grant, and restores it offline", async t => {
  let current = policy();
  const saved = grant();
  const f = fixture(t, { saved, handler: (url, options) => {
    if (url.endsWith("/api/public/config")) return renewalConfig();
    if (url.endsWith("/api/desktop/session/renew")) return Response.json({ renewed: false, expiresAt: saved.expiresAt, device: { id: deviceId, organizationId, email: saved.email } });
    if (url.endsWith("/api/desktop/heartbeat")) return Response.json({ device: {} });
    if (url.endsWith("/api/desktop/session") && options.method !== "DELETE") return Response.json({ ...session(saved), policy: current });
    return null;
  } });
  await f.client.start(); await settle();
  const applied = f.policies.at(-1);
  assert.equal(applied.remoteAccess, false); assert.equal(applied.organizationName, "Example company"); assert.equal(applied.organizationId, organizationId);
  assert.equal(applied.expiresAt, saved.expiresAt); assert.equal("futureField" in applied, false);
  assert.equal(f.record.value.policy.version, 2); assert.equal(f.client.policy().remoteAccess, false);
  assert.equal("policy" in f.applied.at(-1), false, "the model grant never carries the policy");
  const report = f.requests.find(row => row.url.endsWith("/api/desktop/heartbeat"));
  assert.equal(body(report).policyVersion, 2, "Admin learns which policy is applied");
  // A malformed policy keeps the last one rather than widening access.
  current = { ...policy(), computers: "all" }; await f.client.refresh();
  assert.equal(f.policies.at(-1).version, 2); assert.equal(f.client.policy().remoteAccess, false);

  // Restart while the Admin is unreachable: the saved policy applies first.
  let appliedBeforeNetwork = null, offline = null;
  offline = fixture(t, { saved: f.record.value, handler: () => { appliedBeforeNetwork ??= structuredClone(offline.policies); throw new Error("offline"); } });
  await offline.client.start();
  assert.equal(offline.client.state().status, "unavailable");
  assert.ok(appliedBeforeNetwork.length >= 1, "applied before the first request");
  assert.ok(appliedBeforeNetwork.every(sent => sent.remoteAccess === false && sent.version === 2));
  assert.equal(offline.policies.at(-1).remoteAccess, false, "still applied after the failed heartbeat");

  await f.client.disconnect();
  assert.equal(f.policies.at(-1), null); assert.equal(f.client.policy(), null);
});

test("revocation and expiry lift the policy with company access", async t => {
  let revoked = false;
  const f = fixture(t, { saved: grant(), handler: (url, options) => revoked ? Response.json({ error: "invalid_token" }, { status: 401 })
    : url.endsWith("/api/desktop/session") && options.method !== "DELETE" ? Response.json({ ...session(grant()), policy: policy() }) : null });
  await f.client.start(); assert.equal(f.policies.at(-1).version, 2);
  revoked = true; await f.client.refresh();
  assert.equal(f.client.state().status, "reauth-required"); assert.equal(f.policies.at(-1), null);
  assert.equal(f.client.policy(), null, "Electron main stops enforcing it too");
});

test("sends the saved enrollment's identity, never its token, on start, on expiry and before disconnect clears it", async t => {
  const expired = { ...grant(), expiresAt: Date.now() - 1 };
  const f = fixture(t, { saved: expired });
  await f.client.start();
  assert.equal(f.client.state().status, "reauth-required");
  assert.ok(f.identities.length >= 1);
  assert.deepEqual(f.identities[0].identity, { portalOrigin: origin, organizationId, deviceId, email: expired.email });
  assert(!JSON.stringify(f.identities.map(row => row.identity)).includes(token));
  const before = f.identities.length;
  await f.client.disconnect();
  const sent = f.identities.slice(before);
  assert.equal(sent.length, 1); assert.equal(sent[0].identity.deviceId, deviceId);
  assert.ok(sent[0].saved, "sent while the saved enrollment still existed");
  assert.equal(f.record.value, null);
});

test("never adopts a rotated token it could not store", async t => {
  const rotated = `omd_${"z".repeat(43)}`, saved = grant();
  let failWrites = true;
  const f = fixture(t, { saved, write: () => { if (failWrites) throw new Error("keychain locked"); }, handler: (url, options) => {
    if (url.endsWith("/api/public/config")) return renewalConfig();
    if (url.endsWith("/api/desktop/session/renew")) return Response.json({ renewed: true, accessToken: rotated, expiresAt: saved.expiresAt + DAY, device: { id: deviceId, organizationId, email: saved.email } });
    if (url.endsWith("/api/desktop/session") && options.method !== "DELETE") return Response.json(session(saved));
    return null;
  } });
  await f.client.start();
  const heartbeat = f.requests.findLast(row => row.url.endsWith("/api/desktop/session") && row.options.method === "GET");
  assert.equal(heartbeat.options.headers.authorization, `Bearer ${token}`);
  assert.equal(f.record.value.token, token);
  failWrites = false;
});

test("re-sends the saved policy before any network call when the runtime restarts", async t => {
  let release;
  const f = fixture(t, { saved: grant(), handler: (url, options) => url.endsWith("/api/desktop/session") && options.method !== "DELETE" ? Response.json({ ...session(grant()), policy: policy() }) : null });
  await f.client.start(); await settle();
  // The runtime restarted and lost its overlay; the heartbeat is slow.
  const before = f.policies.length;
  const slow = fixture(t, { saved: f.record.value, handler: (url, options) => url.endsWith("/api/desktop/session") && options.method !== "DELETE" ? new Promise(resolve => { release = resolve; }) : null });
  const starting = slow.client.start(); await settle();
  assert.equal(slow.policies.at(-1).version, 2, "applied while the network call is still pending");
  // A later refresh (the runtime's ready hook) also re-sends it first.
  const count = slow.policies.length;
  release(Response.json({ ...session(grant()), policy: policy() })); await starting;
  const refreshing = slow.client.refresh(); await settle();
  assert.ok(slow.policies.length > count + 1, "sent again before the next heartbeat answered");
  release(Response.json({ ...session(grant()), policy: policy() })); await refreshing;
  assert.ok(f.policies.length >= before);
});

test("reports when the saved enrollment has been read", async t => {
  const f = fixture(t, { saved: { ...grant(), policy: { ...policy(), organizationName: "Example company" } } });
  let restored = false;
  void f.client.whenRestored().then(() => { restored = true; });
  await settle(); assert.equal(restored, false);
  await f.client.start(); await settle();
  assert.equal(restored, true); assert.equal(f.policies[0].remoteAccess, false, "the saved policy applied before the Admin answered");
});
