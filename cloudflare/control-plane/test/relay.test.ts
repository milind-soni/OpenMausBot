import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import vectors from "../../../companion/src/e2e/vectors/v1.json";
import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { forgetRelayAdoption, importSigningSeed, mintRelayToken, orderNodes, RELAY_TOKEN_LIMIT, rolloutBucket } from "../src/relay";

const BASE_URL = "https://auth.openmausbot.test";
const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));

type TestWorker = ReturnType<typeof createWorker>;
const worker = createWorker((async () => new Response('{"success":false,"errors":[]}', { status: 500 })) as typeof fetch);
const seed = crypto.getRandomValues(new Uint8Array(32));

function relayEnv(extra: Record<string, string> = {}): Env {
  return { ...env, RELAY_TOKEN_SIGNING_KEY: b64u(seed), RELAY_ROLLOUT_PERCENT: "100", ...extra } as unknown as Env;
}

async function call(testEnv: Env, path: string, options: { body?: unknown; token?: string; method?: string; via?: TestWorker } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await (options.via ?? worker).fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function installation(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const signedIn = await call(env, "/api/auth/sign-in/email-otp", { body: { email, name: "Relay owner", otp } });
  const accountToken = signedIn.headers.get("set-auth-token")!;
  const created = await call(env, "/v1/installations", {
    token: accountToken,
    body: { clientInstanceId: crypto.randomUUID(), name: "Test computer", platform: "darwin" },
  });
  const body = await created.json<{ credential: string; installation: { id: string } }>();
  return { credential: body.credential, id: body.installation.id };
}

const ask = (testEnv: Env, credential: string, devices = { e2e: 1, legacy: 0 }) =>
  call(testEnv, "/v1/installations/self/relay-token", { token: credential, body: { appVersion: "0.1.150", devices } });

interface Issued {
  token: string;
  hostId: string;
  nodes: string[];
  expiresAt: number;
  refreshAfter: number;
}

async function verify(token: string, publicKey: CryptoKey) {
  const [body, signature] = token.split(".");
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromB64u(signature), new TextEncoder().encode(body));
  return { ok, claims: JSON.parse(new TextDecoder().decode(fromB64u(body))) as Record<string, unknown> };
}

async function publicKeyOf(seedBytes: Uint8Array): Promise<CryptoKey> {
  const pair = await crypto.subtle.importKey("pkcs8", new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seedBytes]), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair);
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
}

describe("relay host tokens", () => {
  it("are byte for byte the V8 vector token, so every relay that passes V8 accepts them", async () => {
    const key = await importSigningSeed(hex(vectors.V8.seed));
    expect(await mintRelayToken(vectors.V8.claims, key)).toBe(vectors.V8.token);
    const publicKey = await publicKeyOf(hex(vectors.V8.seed));
    expect(b64u(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)))).toBe(vectors.V8.publicKeyB64u);
  });

  it("are refused without an installation credential", async () => {
    expect((await call(relayEnv(), "/v1/installations/self/relay-token", { body: { appVersion: "0.1.150", devices: { e2e: 0, legacy: 0 } } })).status).toBe(401);
  });

  it("answer 503 relay_unavailable until the signing key exists, and while the kill switch is on", async () => {
    const { credential } = await installation("unset@example.test");
    for (const testEnv of [env, relayEnv({ RELAY_DISABLED: "1" }), relayEnv({ RELAY_NODES: "relay.example.com" })]) {
      const response = await ask(testEnv, credential);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "relay_unavailable" });
    }
  });

  it("mint a 12 h token for a stable host id, with the node order and the refresh time", async () => {
    const { credential, id } = await installation("mint@example.test");
    const before = Math.floor(Date.now() / 1000);
    // Two nodes, whatever wrangler.jsonc lists today, so the order is still tested.
    const twoNodes = relayEnv({ RELAY_NODES: "relay1.openmausbot.com,relay2.openmausbot.com" });
    const first = await (await ask(twoNodes, credential)).json<Issued>();
    const second = await (await ask(twoNodes, credential)).json<Issued>();
    expect(second.hostId).toBe(first.hostId);
    expect(fromB64u(first.hostId)).toHaveLength(16);
    const { ok, claims } = await verify(first.token, await publicKeyOf(seed));
    expect(ok).toBe(true);
    expect(Object.keys(claims)).toEqual(["v", "kid", "hid", "iid", "iat", "exp"]);
    expect(claims).toMatchObject({ v: 1, kid: "k1", hid: first.hostId, iid: id });
    expect(claims.exp).toBe((claims.iat as number) + 43_200);
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    expect(first.expiresAt).toBe((claims.exp as number) * 1000);
    expect(first.refreshAfter).toBe(((claims.iat as number) + 3600) * 1000);
    expect(first.nodes).toEqual(await orderNodes(fromB64u(first.hostId), { nodes: ["relay1.openmausbot.com", "relay2.openmausbot.com"], americasNodes: new Set() }, null));
  });

  it("admit by rollout bucket, or by name, and never a blocked installation", async () => {
    const { credential, id } = await installation("rollout@example.test");
    const outside = await ask(relayEnv({ RELAY_ROLLOUT_PERCENT: "0" }), credential);
    expect(outside.status).toBe(503);
    const named = await ask(relayEnv({ RELAY_ROLLOUT_PERCENT: "0", RELAY_ALLOW_INSTALLATIONS: `other,${id}` }), credential);
    expect(named.status).toBe(200);
    const { hostId } = await named.json<Issued>();
    const bucket = await rolloutBucket(fromB64u(hostId));
    expect((await ask(relayEnv({ RELAY_ROLLOUT_PERCENT: String(bucket) }), credential)).status).toBe(503);
    expect((await ask(relayEnv({ RELAY_ROLLOUT_PERCENT: String(bucket + 1) }), credential)).status).toBe(200);
    await env.DB.prepare("UPDATE installations SET relay_blocked_at = ? WHERE id = ?").bind(Date.now(), id).run();
    expect((await ask(relayEnv(), credential)).status).toBe(503);
  });

  it(`allow ${RELAY_TOKEN_LIMIT} requests an hour per installation`, async () => {
    const { credential } = await installation("limit@example.test");
    for (let index = 0; index < RELAY_TOKEN_LIMIT; index += 1) expect((await ask(relayEnv(), credential)).status).toBe(200);
    const limited = await ask(relayEnv(), credential);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("refuse a request body outside the schema", async () => {
    const { credential } = await installation("schema@example.test");
    for (const body of [{ appVersion: "0.1.150" }, { appVersion: "x", devices: { e2e: 0, legacy: 0 } }, { appVersion: "0.1.150", devices: { e2e: 0, legacy: 0, extra: 1 } }]) {
      expect((await call(relayEnv(), "/v1/installations/self/relay-token", { token: credential, body })).status).toBe(400);
    }
  });

  it("report adoption sums on /healthz, with no identifiers", async () => {
    const { credential } = await installation("adoption@example.test");
    await ask(relayEnv({ RELAY_ROLLOUT_PERCENT: "0" }), credential, { e2e: 2, legacy: 1 });
    const health = await (await call(relayEnv(), "/healthz", { method: "GET" })).json<{ relayAdoption: Record<string, number> }>();
    expect(Object.keys(health.relayAdoption).sort()).toEqual(["e2eDevices", "installs", "legacyDevices"]);
    expect(health.relayAdoption.e2eDevices).toBeGreaterThanOrEqual(2);
    expect(health.relayAdoption.legacyDevices).toBeGreaterThanOrEqual(1);
  });
});

describe("relay usage per UTC day", () => {
  type Counts = Record<string, number>;
  const today = () => new Date().toISOString().slice(0, 10);
  async function daily(day = today()): Promise<Counts> {
    const rows = await env.DB.prepare("SELECT kind, installs FROM relay_daily WHERE day = ?").bind(day).all<{ kind: string; installs: number }>();
    return Object.fromEntries(rows.results.map((row) => [row.kind, row.installs]));
  }
  const delta = (after: Counts, before: Counts) =>
    Object.fromEntries(["seen", "token", "e2e", "new"].map((kind) => [kind, (after[kind] ?? 0) - (before[kind] ?? 0)]));

  it("counts each installation once per day and kind: asked, got a token, has end-to-end phones, first time", async () => {
    const a = await installation("daily-a@example.test");
    const b = await installation("daily-b@example.test");
    let before = await daily();
    expect((await ask(relayEnv(), a.credential, { e2e: 2, legacy: 0 })).status).toBe(200);
    expect((await ask(relayEnv(), a.credential, { e2e: 1, legacy: 0 })).status).toBe(200);
    expect(delta(await daily(), before)).toEqual({ seen: 1, token: 1, e2e: 1, new: 1 });

    before = await daily();
    expect((await ask(relayEnv({ RELAY_ROLLOUT_PERCENT: "0" }), b.credential, { e2e: 0, legacy: 3 })).status).toBe(503);
    expect(delta(await daily(), before)).toEqual({ seen: 1, token: 0, e2e: 0, new: 1 });
    before = await daily();
    expect((await ask(relayEnv(), b.credential, { e2e: 0, legacy: 3 })).status).toBe(200);
    expect((await ask(relayEnv(), b.credential, { e2e: 0, legacy: 3 })).status).toBe(200);
    expect(delta(await daily(), before)).toEqual({ seen: 0, token: 1, e2e: 0, new: 0 });

    const c = await installation("daily-c@example.test");
    before = await daily();
    for (let index = 0; index < 2; index += 1) expect((await ask(relayEnv({ RELAY_ROLLOUT_PERCENT: "0" }), c.credential, { e2e: 1, legacy: 0 })).status).toBe(503);
    expect(delta(await daily(), before)).toEqual({ seen: 1, token: 0, e2e: 1, new: 1 });

    // The next day: a's row as yesterday's requests left it.
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE relay_adoption SET updated_at = ?1, token_at = ?1, e2e_at = ?1 WHERE installation_id = ?2").bind(yesterday, a.id).run();
    before = await daily();
    expect((await ask(relayEnv(), a.credential, { e2e: 1, legacy: 0 })).status).toBe(200);
    expect(delta(await daily(), before)).toEqual({ seen: 1, token: 1, e2e: 1, new: 0 });
    const row = await env.DB.prepare("SELECT first_seen_at, token_at, e2e_at FROM relay_adoption WHERE installation_id = ?").bind(a.id).first<Record<string, number>>();
    expect(row!.first_seen_at).toBeLessThan(row!.token_at);
  });

  it("keep only the day, the kind and a count", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(relay_daily)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(["day", "kind", "installs"]);
  });
});

describe("node order", () => {
  const nodes = ["relay1.openmausbot.com", "relay2.openmausbot.com", "relay3.openmausbot.com"];

  it("is the rendezvous hash: highest SHA256(hostId ‖ node)[0:8] first", async () => {
    const hostId = crypto.getRandomValues(new Uint8Array(16));
    const scores = await Promise.all(nodes.map(async (node) => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...hostId, ...new TextEncoder().encode(node)])));
      return { node, score: [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
    }));
    const expected = scores.sort((a, b) => (a.score < b.score ? 1 : -1)).map((entry) => entry.node);
    expect(await orderNodes(hostId, { nodes, americasNodes: new Set() }, "EU")).toEqual(expected);
  });

  it("puts an Americas node first for a computer in the Americas only", async () => {
    const hostId = crypto.getRandomValues(new Uint8Array(16));
    const settings = { nodes, americasNodes: new Set(["relay3.openmausbot.com"]) };
    expect((await orderNodes(hostId, settings, "SA"))[0]).toBe("relay3.openmausbot.com");
    expect(await orderNodes(hostId, settings, "EU")).toEqual(await orderNodes(hostId, { nodes, americasNodes: new Set() }, null));
  });
});

describe("tunnels for relay-capable desktops", () => {
  it("are refused with 409 relay_capable when no old phone needs one, once the release is named", async () => {
    const { credential } = await installation("tunnel@example.test");
    const gated = { ...env, RELAY_CAPABLE_MIN_VERSION: "0.1.150" } as unknown as Env;
    const refused = await call(gated, "/v1/installations/self/endpoint", { token: credential, body: { appVersion: "0.1.151", legacyDevices: 0 } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "relay_capable" });
    for (const [testEnv, body] of [
      [gated, { appVersion: "0.1.151", legacyDevices: 1 }],
      [gated, { appVersion: "0.1.149", legacyDevices: 0 }],
      [gated, { appVersion: "0.1.151" }],
      [env, { appVersion: "0.1.151", legacyDevices: 0 }],
    ] as const) {
      expect((await call(testEnv, "/v1/installations/self/endpoint", { token: credential, body })).status).not.toBe(409);
    }
  });
});

describe("a Worker deployed before migration 0012", () => {
  it("keeps health, pairing endpoints and the cron working, and the relay off", async () => {
    const db = env.MIGRATION_DB;
    const relayMigration = env.TEST_MIGRATIONS.findIndex((migration) => migration.name.startsWith("0012_"));
    expect(relayMigration).toBeGreaterThan(0);
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, relayMigration));
    const oldEnv = { ...relayEnv({ RELAY_CAPABLE_MIN_VERSION: "0.1.150" }), DB: db } as unknown as Env;

    const now = Date.now();
    const lookup = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const credential = `omb_install_${lookup}.${b64u(crypto.getRandomValues(new Uint8Array(32)))}`;
    const secretHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const installationId = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind("old-user", "Old", "old@example.test", now, now),
      db.prepare("INSERT INTO installations (id, owner_user_id, client_instance_id, display_name, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(installationId, "old-user", crypto.randomUUID(), "Old computer", "darwin", now, now),
      db.prepare("INSERT INTO installation_credentials (id, installation_id, lookup_id, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), installationId, lookup, secretHash, now, now + 3_600_000),
    ]);

    forgetRelayAdoption();
    const health = await call(oldEnv, "/healthz", { method: "GET" });
    expect(health.status).toBe(200);
    const body = await health.json<Record<string, unknown>>();
    expect(body).toMatchObject({ ok: true, service: "openmausbot-control-plane" });
    expect(body).not.toHaveProperty("relayAdoption");

    const token = await ask(oldEnv, credential);
    expect(token.status).toBe(503);
    expect(await token.json()).toEqual({ error: "relay_unavailable" });

    const refused = await call(oldEnv, "/v1/installations/self/endpoint", { token: credential, body: { appVersion: "0.1.151", legacyDevices: 0 } });
    expect(refused.status).toBe(409);
    for (const body of [{ appVersion: "0.1.151", legacyDevices: 1 }, { appVersion: "0.1.149" }]) {
      const response = await call(oldEnv, "/v1/installations/self/endpoint", { token: credential, body });
      expect(response.status).not.toBe(500);
      expect(await response.json()).not.toEqual({ error: "internal_error" });
    }

    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), oldEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect((await call(oldEnv, "/v1/installations/self", { token: credential, method: "GET" })).status).toBe(200);
  });
});

describe("a Worker deployed before migration 0014", () => {
  it("still mints tokens and records adoption, without the daily counts", async () => {
    const db = env.MIGRATION_DB;
    const daily = env.TEST_MIGRATIONS.findIndex((migration) => migration.name.startsWith("0014_"));
    expect(daily).toBeGreaterThan(0);
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, daily));
    const oldEnv = { ...relayEnv(), DB: db } as unknown as Env;
    const now = Date.now();
    const lookup = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const credential = `omb_install_${lookup}.${b64u(crypto.getRandomValues(new Uint8Array(32)))}`;
    const secretHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const installationId = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind("pre-0014-user", "Old", "pre-0014@example.test", now, now),
      db.prepare("INSERT INTO installations (id, owner_user_id, client_instance_id, display_name, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(installationId, "pre-0014-user", crypto.randomUUID(), "Old computer", "darwin", now, now),
      db.prepare("INSERT INTO installation_credentials (id, installation_id, lookup_id, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), installationId, lookup, secretHash, now, now + 3_600_000),
    ]);
    const response = await ask(oldEnv, credential, { e2e: 1, legacy: 2 });
    expect(response.status).toBe(200);
    const row = await db.prepare("SELECT e2e_devices, legacy_devices FROM relay_adoption WHERE installation_id = ?").bind(installationId).first();
    expect(row).toEqual({ e2e_devices: 1, legacy_devices: 2 });
  });
});
