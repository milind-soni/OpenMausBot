import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { FCM_SCOPE, GOOGLE_TOKEN_URL, forgetFcmAccessToken, readFcmConfig } from "../src/push-fcm";

const BASE_URL = "https://auth.openmausbot.test";
const FCM_TOKEN = `cXyZ_1234567890-abc:APA91b${"F".repeat(140)}`;
const OTHER_FCM_TOKEN = `dQwE_0987654321-xyz:APA91b${"G".repeat(140)}`;
const APNS_TOKEN = "a1".repeat(32);
const PROJECT = "mausbot-test-1";

type TestWorker = ReturnType<typeof createWorker>;

interface Call {
  url: string;
  headers: Record<string, string>;
  text: string;
}

interface Answer {
  status: number;
  body?: unknown;
}

/** One fake for Google's token endpoint, FCM and APNs, each with its own queue of answers (200 when it runs out). */
function fakeProviders(answers: { oauth?: Answer[]; fcm?: Answer[]; apns?: Answer[] } = {}) {
  const calls: Call[] = [];
  const queues = { oauth: [...(answers.oauth ?? [])], fcm: [...(answers.fcm ?? [])], apns: [...(answers.apns ?? [])] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({ url: request.url, headers, text: new TextDecoder().decode(await request.arrayBuffer()) });
    const host = new URL(request.url).host;
    const queue = host === "oauth2.googleapis.com" ? queues.oauth : host === "fcm.googleapis.com" ? queues.fcm : queues.apns;
    const fallback: Answer = host === "oauth2.googleapis.com"
      ? { status: 200, body: { access_token: `ya29.test-${calls.length}`, expires_in: 3599, token_type: "Bearer" } }
      : host === "fcm.googleapis.com" ? { status: 200, body: { name: `projects/${PROJECT}/messages/1` } } : { status: 200 };
    const answer = queue.shift() ?? fallback;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const of = (host: string) => calls.filter((call) => new URL(call.url).host === host);
  return { calls, fetch: fetchImpl, oauth: () => of("oauth2.googleapis.com"), fcm: () => of("fcm.googleapis.com"), apns: () => of("api.push.apple.com").concat(of("api.sandbox.push.apple.com")) };
}

function pem(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function serviceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const privateKey = pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  const file = {
    type: "service_account",
    project_id: PROJECT,
    private_key_id: "0123456789abcdef",
    private_key: privateKey,
    client_email: `firebase-adminsdk-test@${PROJECT}.iam.gserviceaccount.com`,
    token_uri: "https://attacker.example/token",
  };
  return { publicKey: pair.publicKey, json: JSON.stringify(file), file };
}

async function apnsKeyPem() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
}

function testEnv(extra: Record<string, string>): Env {
  return { ...env, ...extra } as unknown as Env;
}

async function call(worker: TestWorker, environment: Env, path: string, options: { body?: unknown; token?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function installation(worker: TestWorker, environment: Env, email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const signedIn = await call(worker, environment, "/api/auth/sign-in/email-otp", { body: { email, name: "Push owner", otp } });
  expect(signedIn.status).toBe(200);
  const created = await call(worker, environment, "/v1/installations", {
    token: signedIn.headers.get("set-auth-token")!,
    body: { clientInstanceId: crypto.randomUUID(), name: "Test computer", platform: "linux" },
  });
  expect(created.status).toBe(201);
  const body = await created.json<{ credential: string; installation: { id: string } }>();
  return { credential: body.credential, id: body.installation.id };
}

const notification = { kind: "approval", title: "Scout needs approval", botId: "bot_1", botName: "Scout", threadId: "th_1" };

const registerFcm = (worker: TestWorker, environment: Env, credential: string, token = FCM_TOKEN) =>
  call(worker, environment, "/v1/installations/self/push/register", { token: credential, body: { v: 1, platform: "fcm", token } });
const send = (worker: TestWorker, environment: Env, credential: string, body: Record<string, unknown> = {}) =>
  call(worker, environment, "/v1/installations/self/push/send", {
    token: credential,
    body: { v: 1, token: FCM_TOKEN, pairing: "pair-tag-1", collapseId: "openmaus.th_1.42", notification, ...body },
  });

const decode = (part: string) => JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/")));

describe("phone push relay, FCM", () => {
  beforeEach(() => forgetFcmAccessToken());

  it("is unavailable for FCM until the service account is set, whatever APNs has", async () => {
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const apnsOnly = testEnv({
      APNS_KEY_ID: "KEY1234567",
      APNS_TEAM_ID: "TEAM123456",
      APNS_BUNDLE_ID: "com.example.mausbot",
      APNS_PRIVATE_KEY: await apnsKeyPem(),
    });
    const { credential } = await installation(worker, apnsOnly, "fcm-unset@example.test");
    const refused = await registerFcm(worker, apnsOnly, credential);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "push_unavailable" });
    const apns = await call(worker, apnsOnly, "/v1/installations/self/push/register", { token: credential, body: { v: 1, token: APNS_TOKEN, environment: "production" } });
    expect(apns.status).toBe(200);
    expect(providers.calls).toEqual([]);
  });

  it("signs an RS256 assertion for Google and sends a data-only message with no message text", async () => {
    const account = await serviceAccount();
    const environment = testEnv({ FCM_SERVICE_ACCOUNT: account.json });
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const { credential } = await installation(worker, environment, "fcm-send@example.test");
    expect((await registerFcm(worker, environment, credential)).status).toBe(200);
    const sent = await send(worker, environment, credential, { notification: { ...notification, roomId: "grp_1", roomName: "Launch" } });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ sent: true });

    const [oauth] = providers.oauth();
    expect(oauth!.url).toBe(GOOGLE_TOKEN_URL);
    const form = new URLSearchParams(oauth!.text);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims!)).toMatchObject({ iss: account.file.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL });
    expect(decode(claims!).exp - decode(claims!).iat).toBe(3600);
    const raw = Uint8Array.from(atob(signature!.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, account.publicKey, raw, new TextEncoder().encode(`${header}.${claims}`))).toBe(true);

    const [message] = providers.fcm();
    expect(message!.url).toBe(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`);
    expect(message!.headers.authorization).toBe("Bearer ya29.test-1");
    expect(JSON.parse(message!.text)).toEqual({
      message: {
        token: FCM_TOKEN,
        data: {
          title: "Scout needs approval",
          tag: "openmaus.th_1.42",
          channelId: "approval_question",
          categoryId: "OPENMAUS_APPROVAL",
          threadIdentifier: "th_1",
          body: JSON.stringify({ v: 1, kind: "approval", botId: "bot_1", botName: "Scout", threadId: "th_1", roomId: "grp_1", roomName: "Launch", pairing: "pair-tag-1" }),
        },
        android: { priority: "HIGH", ttl: "86400s" },
      },
    });
    // the token_uri in the pasted file is never used
    expect(providers.calls.some((one) => one.url.includes("attacker"))).toBe(false);
  });

  it("reuses Google's access token until it nears expiry, and maps a finished turn to the messages channel", async () => {
    const account = await serviceAccount();
    const environment = testEnv({ FCM_SERVICE_ACCOUNT: account.json });
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const { credential } = await installation(worker, environment, "fcm-cache@example.test");
    await registerFcm(worker, environment, credential);
    expect((await send(worker, environment, credential)).status).toBe(202);
    expect((await send(worker, environment, credential, { collapseId: undefined, notification: { ...notification, kind: "done", title: "Scout finished" } })).status).toBe(202);
    expect(providers.oauth()).toHaveLength(1);
    const second = JSON.parse(providers.fcm()[1]!.text) as { message: { data: Record<string, string> } };
    expect(second.message.data).toMatchObject({ channelId: "bot_messages", categoryId: "OPENMAUS_UPDATE" });
    expect(second.message.data.tag).toMatch(/^[0-9a-f]{32}$/);
  });

  it("drops a token FCM calls unregistered or foreign, for every installation", async () => {
    const account = await serviceAccount();
    const environment = testEnv({ FCM_SERVICE_ACCOUNT: account.json });
    const providers = fakeProviders({
      fcm: [
        { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } } },
        { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "SenderId mismatch", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "SENDER_ID_MISMATCH" }] } } },
      ],
    });
    const worker = createWorker(fetch, providers.fetch);
    const first = await installation(worker, environment, "fcm-dead-1@example.test");
    const second = await installation(worker, environment, "fcm-dead-2@example.test");
    await registerFcm(worker, environment, first.credential);
    await registerFcm(worker, environment, second.credential);
    const dead = await send(worker, environment, first.credential);
    expect(dead.status).toBe(410);
    expect(await dead.json()).toEqual({ error: "push_device_unregistered" });
    expect((await send(worker, environment, second.credential)).status).toBe(404);

    await registerFcm(worker, environment, first.credential, OTHER_FCM_TOKEN);
    expect((await send(worker, environment, first.credential, { token: OTHER_FCM_TOKEN })).status).toBe(410);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installation_push_devices").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("keeps a token when FCM refuses the message itself, and tells throttling and outages apart", async () => {
    const account = await serviceAccount();
    const environment = testEnv({ FCM_SERVICE_ACCOUNT: account.json });
    const providers = fakeProviders({
      fcm: [
        { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid value at 'message.data'", details: [{ errorCode: "INVALID_ARGUMENT" }] } } },
        { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ errorCode: "QUOTA_EXCEEDED" }] } } },
        { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: "try later" } } },
      ],
    });
    const worker = createWorker(fetch, providers.fetch);
    const { credential } = await installation(worker, environment, "fcm-errors@example.test");
    await registerFcm(worker, environment, credential);
    expect((await send(worker, environment, credential)).status).toBe(502);
    const throttled = await send(worker, environment, credential);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    expect((await send(worker, environment, credential)).status).toBe(502);
    const rows = await env.DB.prepare("SELECT platform, environment FROM installation_push_devices").all<{ platform: string; environment: string }>();
    expect(rows.results).toEqual([{ platform: "fcm", environment: "production" }]);
  });

  it("renews the access token once when FCM refuses it, then reports the relay unavailable", async () => {
    const account = await serviceAccount();
    const environment = testEnv({ FCM_SERVICE_ACCOUNT: account.json });
    const unauthenticated = { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." } } };
    const providers = fakeProviders({ fcm: [unauthenticated, { status: 200, body: {} }, unauthenticated, unauthenticated] });
    const worker = createWorker(fetch, providers.fetch);
    const { credential } = await installation(worker, environment, "fcm-renew@example.test");
    await registerFcm(worker, environment, credential);
    expect((await send(worker, environment, credential)).status).toBe(202);
    expect(providers.oauth()).toHaveLength(2);
    const refused = await send(worker, environment, credential);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "push_unavailable" });

    const badGrant = fakeProviders({ oauth: [{ status: 400, body: { error: "invalid_grant" } }] });
    forgetFcmAccessToken();
    const response = await send(createWorker(fetch, badGrant.fetch), environment, credential);
    expect(response.status).toBe(503);
    expect(badGrant.fcm()).toEqual([]);
  });

  it("checks platform, token, environment and collapse id strictly", async () => {
    const account = await serviceAccount();
    const environment = testEnv({ FCM_SERVICE_ACCOUNT: account.json });
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const { credential } = await installation(worker, environment, "fcm-strict@example.test");
    const register = (body: Record<string, unknown>) => call(worker, environment, "/v1/installations/self/push/register", { token: credential, body: { v: 1, ...body } });
    for (const body of [
      { platform: "fcm", token: FCM_TOKEN, environment: "sandbox" },
      { platform: "fcm", token: "short:token" },
      { platform: "fcm", token: `${FCM_TOKEN} ` },
      { platform: "apns", token: FCM_TOKEN, environment: "production" },
      { platform: "webpush", token: FCM_TOKEN },
      { token: FCM_TOKEN, environment: "production" },
    ]) {
      expect((await register(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await register({ platform: "fcm", token: FCM_TOKEN, environment: "production" })).status).toBe(200);
    for (const collapseId of ["x".repeat(65), "has space", "slash/inside", ""]) {
      expect((await send(worker, environment, credential, { collapseId })).status, collapseId).toBe(400);
    }
    expect((await send(worker, environment, credential, { notification: { ...notification, body: "the reply text" } })).status).toBe(400);
    expect(providers.fcm()).toEqual([]);
    const removed = await call(worker, environment, "/v1/installations/self/push/unregister", { token: credential, body: { v: 1, platform: "fcm", token: FCM_TOKEN } });
    expect(removed.status).toBe(204);
    expect((await send(worker, environment, credential)).status).toBe(404);
  });

  it("sends an APNs push with the harness's collapse id when it gives one", async () => {
    const environment = testEnv({
      APNS_KEY_ID: "KEY1234567",
      APNS_TEAM_ID: "TEAM123456",
      APNS_BUNDLE_ID: "com.example.mausbot",
      APNS_PRIVATE_KEY: await apnsKeyPem(),
    });
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const { credential } = await installation(worker, environment, "apns-collapse@example.test");
    await call(worker, environment, "/v1/installations/self/push/register", { token: credential, body: { v: 1, platform: "apns", token: APNS_TOKEN, environment: "production" } });
    expect((await send(worker, environment, credential, { token: APNS_TOKEN, notification: { ...notification, kind: "sign-in", title: "Scout needs you to sign in to a website" } })).status).toBe(202);
    const [apns] = providers.apns();
    expect(apns!.headers["apns-collapse-id"]).toBe("openmaus.th_1.42");
    expect(JSON.parse(apns!.text).aps).toMatchObject({ category: "OPENMAUS_UPDATE", "interruption-level": "time-sensitive" });
    const row = await env.DB.prepare("SELECT platform FROM installation_push_devices").first<{ platform: string }>();
    expect(row?.platform).toBe("apns");
  });

  it("reads the service-account file whole, and nothing malformed", async () => {
    const account = await serviceAccount();
    expect(readFcmConfig(testEnv({ FCM_SERVICE_ACCOUNT: account.json }))).toMatchObject({ projectId: PROJECT, clientEmail: account.file.client_email });
    const escaped = JSON.stringify({ ...account.file, private_key: account.file.private_key.replaceAll("\n", "\\n") });
    expect(readFcmConfig(testEnv({ FCM_SERVICE_ACCOUNT: escaped }))).not.toBeNull();
    for (const broken of [
      "not json",
      JSON.stringify({ ...account.file, project_id: "Bad Project" }),
      JSON.stringify({ ...account.file, client_email: "someone@example.com" }),
      JSON.stringify({ ...account.file, private_key: "not a key" }),
      JSON.stringify([account.file]),
      "",
    ]) {
      expect(readFcmConfig(testEnv({ FCM_SERVICE_ACCOUNT: broken })), broken.slice(0, 30)).toBeNull();
    }
    expect(readFcmConfig(env)).toBeNull();
  });
});
