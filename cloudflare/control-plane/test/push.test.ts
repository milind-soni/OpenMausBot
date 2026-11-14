import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import {
  APNS_TOKEN_WINDOW_MS,
  PUSH_DEVICE_SEND_LIMIT,
  apnsProviderToken,
  forgetApnsToken,
  readApnsConfig,
} from "../src/push";

const BASE_URL = "https://auth.openmausbot.test";
const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);

type TestWorker = ReturnType<typeof createWorker>;

interface ApnsCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeApns(answers: Array<{ status: number; reason?: string; timestamp?: number }> = []) {
  const calls: ApnsCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      headers: (() => {
        const headers: Record<string, string> = {};
        request.headers.forEach((value, name) => {
          headers[name] = value;
        });
        return headers;
      })(),
      body: await request.json<Record<string, unknown>>(),
    });
    const answer = answers.shift() ?? { status: 200 };
    const body = answer.reason ? JSON.stringify({ reason: answer.reason, timestamp: answer.timestamp }) : null;
    return new Response(body, { status: answer.status });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function pem(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

async function apnsKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { publicKey: pair.publicKey, privateKeyPem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer) };
}

async function pushEnv(privateKeyPem: string, extra: Record<string, string> = {}): Promise<Env> {
  return {
    ...env,
    APNS_KEY_ID: "KEY1234567",
    APNS_TEAM_ID: "TEAM123456",
    APNS_BUNDLE_ID: "com.example.mausbot",
    APNS_PRIVATE_KEY: privateKeyPem,
    APNS_ENVIRONMENTS: "production,sandbox",
    ...extra,
  } as unknown as Env;
}

async function call(worker: TestWorker, testEnv: Env, path: string, options: { body?: unknown; token?: string; method?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function installation(worker: TestWorker, testEnv: Env, email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const signedIn = await call(worker, testEnv, "/api/auth/sign-in/email-otp", { body: { email, name: "Push owner", otp } });
  expect(signedIn.status).toBe(200);
  const accountToken = signedIn.headers.get("set-auth-token")!;
  const created = await call(worker, testEnv, "/v1/installations", {
    token: accountToken,
    body: { clientInstanceId: crypto.randomUUID(), name: "Test computer", platform: "linux" },
  });
  expect(created.status).toBe(201);
  const body = await created.json<{ credential: string; installation: { id: string } }>();
  return { accountToken, credential: body.credential, id: body.installation.id };
}

const notification = {
  kind: "approval",
  title: "Scout in Launch needs approval",
  botId: "bot_1",
  botName: "Scout",
  threadId: "th_1",
  roomId: "grp_1",
  roomName: "Launch",
};

const register = (worker: TestWorker, testEnv: Env, credential: string, token = TOKEN_A, environment = "production") =>
  call(worker, testEnv, "/v1/installations/self/push/register", { token: credential, body: { v: 1, token, environment } });
const send = (worker: TestWorker, testEnv: Env, credential: string, body: Record<string, unknown> = {}) =>
  call(worker, testEnv, "/v1/installations/self/push/send", {
    token: credential,
    body: { v: 1, token: TOKEN_A, pairing: "pair-tag-1", notification, ...body },
  });

describe("phone push relay", () => {
  it("is unavailable, and says so, until the APNs secrets are set", async () => {
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const { credential } = await installation(worker, env, "unset@example.test");
    expect(readApnsConfig(env)).toBeNull();
    const response = await register(worker, env, credential);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "push_unavailable" });
    expect(apns.calls).toEqual([]);
  });

  it("pushes only for an installation credential, and only to a token that installation registered", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem);
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const mine = await installation(worker, testEnv, "mine@example.test");
    const theirs = await installation(worker, testEnv, "theirs@example.test");

    // no credential, or an account bearer instead of an installation credential
    expect((await register(worker, testEnv, "")).status).toBe(401);
    expect((await register(worker, testEnv, mine.accountToken)).status).toBe(401);
    expect((await send(worker, testEnv, mine.accountToken)).status).toBe(401);

    expect((await register(worker, testEnv, mine.credential)).status).toBe(200);
    // another installation cannot push to my phone without registering it itself
    const foreign = await send(worker, testEnv, theirs.credential);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "push_device_unknown" });
    expect(apns.calls).toEqual([]);

    expect((await send(worker, testEnv, mine.credential)).status).toBe(202);
    expect(apns.calls).toHaveLength(1);
  });

  it("signs an ES256 provider token and sends a content-free alert", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem);
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const { credential } = await installation(worker, testEnv, "content@example.test");
    expect((await register(worker, testEnv, credential, TOKEN_A, "sandbox")).status).toBe(200);
    const response = await send(worker, testEnv, credential);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ sent: true });

    const [sent] = apns.calls;
    expect(sent!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN_A}`);
    expect(sent!.headers).toMatchObject({
      "apns-topic": "com.example.mausbot",
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    expect(sent!.headers["apns-collapse-id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(sent!.body).toEqual({
      aps: {
        alert: { title: "Scout in Launch needs approval" },
        sound: "default",
        "thread-id": "th_1",
        "interruption-level": "time-sensitive",
      },
      omb: { v: 1, kind: "approval", botId: "bot_1", botName: "Scout", threadId: "th_1", roomId: "grp_1", roomName: "Launch", pairing: "pair-tag-1" },
    });

    const jwt = sent!.headers.authorization!.replace(/^bearer /, "");
    const [header, claims, signature] = jwt.split(".");
    const decode = (part: string) => JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/")));
    expect(decode(header!)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(decode(claims!)).toMatchObject({ iss: "TEAM123456", iat: expect.any(Number) });
    const raw = Uint8Array.from(atob(signature!.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.publicKey, raw, new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
  });

  it("refuses any field that could carry message text instead of dropping it", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem);
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const { credential } = await installation(worker, testEnv, "strict@example.test");
    await register(worker, testEnv, credential);
    for (const body of [
      { notification: { ...notification, body: "rm -rf / and the API key" } },
      { notification: { ...notification, title: "line one\nline two" } },
      { notification: { ...notification, title: "x".repeat(201) } },
      { notification: { ...notification, botName: "x".repeat(81) } },
      { message: "hello" },
      { v: 2 },
    ]) {
      const response = await send(worker, testEnv, credential, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(apns.calls).toEqual([]);
  });

  it("drops a token APNs says is dead, for every installation, and tells the harness", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem);
    const apns = fakeApns([{ status: 410, reason: "Unregistered" }, { status: 400, reason: "BadDeviceToken" }]);
    const worker = createWorker(fetch, apns.fetch);
    const first = await installation(worker, testEnv, "dead-1@example.test");
    const second = await installation(worker, testEnv, "dead-2@example.test");
    await register(worker, testEnv, first.credential);
    await register(worker, testEnv, second.credential);
    const dead = await send(worker, testEnv, first.credential);
    expect(dead.status).toBe(410);
    expect(await dead.json()).toEqual({ error: "push_device_unregistered" });
    expect((await send(worker, testEnv, second.credential)).status).toBe(404);

    await register(worker, testEnv, first.credential, TOKEN_B);
    expect((await send(worker, testEnv, first.credential, { token: TOKEN_B })).status).toBe(410);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installation_push_devices").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("drops a dead token only in the environment APNs judged, and keeps registrations newer than a 410", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem);
    const apns = fakeApns([
      { status: 400, reason: "BadDeviceToken" },
      { status: 410, reason: "Unregistered", timestamp: 1 },
      { status: 410, reason: "Unregistered", timestamp: Date.now() + 60_000 },
    ]);
    const worker = createWorker(fetch, apns.fetch);
    const sandbox = await installation(worker, testEnv, "env-sandbox@example.test");
    const production = await installation(worker, testEnv, "env-production@example.test");
    await register(worker, testEnv, sandbox.credential, TOKEN_A, "sandbox");
    await register(worker, testEnv, production.credential, TOKEN_A, "production");

    expect((await send(worker, testEnv, production.credential)).status).toBe(410);
    expect(apns.calls[0]!.url).toBe(`https://api.push.apple.com/3/device/${TOKEN_A}`);
    expect((await send(worker, testEnv, production.credential)).status).toBe(404);

    expect((await send(worker, testEnv, sandbox.credential)).status).toBe(410);
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM installation_push_devices WHERE installation_id = ?").bind(sandbox.id).first<{ n: number }>();
    expect(kept?.n).toBe(1);

    expect((await send(worker, testEnv, sandbox.credential)).status).toBe(410);
    expect((await send(worker, testEnv, sandbox.credential)).status).toBe(404);
    expect(apns.calls).toHaveLength(3);
  });

  it("retries once with a fresh provider token when APNs refuses it", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem);
    const apns = fakeApns([{ status: 403, reason: "ExpiredProviderToken" }, { status: 200 }]);
    const worker = createWorker(fetch, apns.fetch);
    const { credential } = await installation(worker, testEnv, "expired@example.test");
    await register(worker, testEnv, credential);
    expect((await send(worker, testEnv, credential)).status).toBe(202);
    expect(apns.calls).toHaveLength(2);

    const refused = fakeApns([{ status: 403, reason: "InvalidProviderToken" }, { status: 403, reason: "InvalidProviderToken" }]);
    const refusing = createWorker(fetch, refused.fetch);
    const response = await send(refusing, testEnv, credential, { notification: { ...notification, threadId: "th_2" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "push_unavailable" });
  });

  it("rate-limits each phone, and refuses environments it is not configured for", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem, { APNS_ENVIRONMENTS: "production" });
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const { credential } = await installation(worker, testEnv, "limits@example.test");
    const sandbox = await register(worker, testEnv, credential, TOKEN_B, "sandbox");
    expect(sandbox.status).toBe(400);
    expect(await sandbox.json()).toEqual({ error: "push_environment_not_allowed" });
    await register(worker, testEnv, credential);
    for (let index = 0; index < PUSH_DEVICE_SEND_LIMIT; index += 1) {
      expect((await send(worker, testEnv, credential)).status).toBe(202);
    }
    const limited = await send(worker, testEnv, credential);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(apns.calls).toHaveLength(PUSH_DEVICE_SEND_LIMIT);
    // The refused send took nothing from the installation's own window.
    const workspace = await env.DB.prepare("SELECT attempts FROM installation_action_rate_limits WHERE action = 'push_send' ORDER BY updated_at DESC").first<{ attempts: number }>();
    expect(workspace?.attempts).toBe(PUSH_DEVICE_SEND_LIMIT);
  });

  it("treats a signing key that will not import as the relay being unavailable", async () => {
    const garbage = new Uint8Array(138);
    crypto.getRandomValues(garbage);
    const testEnv = await pushEnv(pem(garbage.buffer));
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const { credential } = await installation(worker, testEnv, "badkey@example.test");
    expect((await register(worker, testEnv, credential)).status).toBeLessThan(300);
    const response = await send(worker, testEnv, credential);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "push_unavailable" });
    expect(apns.calls).toHaveLength(0);
  });

  it("forgets an unregistered token, and every token of a revoked installation", async () => {
    const key = await apnsKey();
    const testEnv = await pushEnv(key.privateKeyPem);
    const worker = createWorker(fetch, fakeApns().fetch);
    const owner = await installation(worker, testEnv, "revoke@example.test");
    await register(worker, testEnv, owner.credential, TOKEN_A);
    await register(worker, testEnv, owner.credential, TOKEN_B);
    const removed = await call(worker, testEnv, "/v1/installations/self/push/unregister", { token: owner.credential, body: { v: 1, token: TOKEN_A } });
    expect(removed.status).toBe(204);
    expect((await send(worker, testEnv, owner.credential)).status).toBe(404);

    const revoked = await call(worker, testEnv, `/v1/installations/${owner.id}`, { method: "DELETE", token: owner.accountToken });
    expect(revoked.status).toBe(204);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installation_push_devices WHERE installation_id = ?").bind(owner.id).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect((await send(worker, testEnv, owner.credential, { token: TOKEN_B })).status).toBe(401);
  });

  it("signs once per 50-minute window and reuses the token inside it", async () => {
    const key = await apnsKey();
    const config = readApnsConfig(await pushEnv(key.privateKeyPem))!;
    forgetApnsToken();
    const start = Math.ceil(Date.now() / APNS_TOKEN_WINDOW_MS) * APNS_TOKEN_WINDOW_MS;
    const first = await apnsProviderToken(config, start);
    expect(await apnsProviderToken(config, start + APNS_TOKEN_WINDOW_MS - 1)).toBe(first);
    const next = await apnsProviderToken(config, start + APNS_TOKEN_WINDOW_MS);
    expect(next).not.toBe(first);
    const claims = JSON.parse(atob(next.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
    expect(claims.iat).toBe((start + APNS_TOKEN_WINDOW_MS) / 1_000);
  });

  it("accepts the .p8 key with escaped newlines, and nothing malformed", async () => {
    const key = await apnsKey();
    expect(readApnsConfig(await pushEnv(key.privateKeyPem.replaceAll("\n", "\\n")))).not.toBeNull();
    expect(readApnsConfig(await pushEnv("not a key"))).toBeNull();
    expect(readApnsConfig(await pushEnv(key.privateKeyPem, { APNS_KEY_ID: "short" }))).toBeNull();
    expect(readApnsConfig(await pushEnv(key.privateKeyPem, { APNS_BUNDLE_ID: "nodots" }))).toBeNull();
    expect(readApnsConfig(await pushEnv(key.privateKeyPem, { APNS_ENVIRONMENTS: "production,staging" }))).toBeNull();
    expect(readApnsConfig(await pushEnv(key.privateKeyPem, { APNS_ENVIRONMENTS: "" }))?.environments).toEqual(new Set(["production"]));
  });
});
