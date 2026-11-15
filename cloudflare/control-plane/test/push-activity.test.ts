import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { forgetFcmAccessToken } from "../src/push-fcm";

const BASE_URL = "https://auth.openmausbot.test";
const ACTIVITY_TOKEN = "ac".repeat(40);
const START_TOKEN = "5a".repeat(40);
const ALERT_TOKEN = "a1".repeat(32);
const FCM_TOKEN = `cXyZ_1234567890-abc:APA91b${"F".repeat(140)}`;

type TestWorker = ReturnType<typeof createWorker>;
interface Call { url: string; headers: Record<string, string>; text: string }

function fakeProviders() {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({ url: request.url, headers, text: new TextDecoder().decode(await request.arrayBuffer()) });
    const host = new URL(request.url).host;
    if (host === "oauth2.googleapis.com") return Response.json({ access_token: "ya29.test", expires_in: 3599 });
    return new Response(host === "fcm.googleapis.com" ? "{}" : null, { status: 200 });
  }) as typeof fetch;
  const apns = () => calls.filter((call) => call.url.includes("push.apple.com"));
  const fcm = () => calls.filter((call) => call.url.includes("fcm.googleapis.com"));
  return { calls, fetch: fetchImpl, apns, fcm };
}

function pem(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function pushEnv(): Promise<Env> {
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    ...env,
    APNS_KEY_ID: "KEY1234567",
    APNS_TEAM_ID: "TEAM123456",
    APNS_BUNDLE_ID: "com.example.mausbot",
    APNS_PRIVATE_KEY: pem(await crypto.subtle.exportKey("pkcs8", ec.privateKey) as ArrayBuffer),
    FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: "mausbot-test-1", client_email: "push@mausbot-test-1.iam.gserviceaccount.com", private_key: pem(await crypto.subtle.exportKey("pkcs8", rsa.privateKey) as ArrayBuffer) }),
  } as unknown as Env;
}

async function call(worker: TestWorker, environment: Env, path: string, options: { body?: unknown; token?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, { method: "POST", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function installation(worker: TestWorker, environment: Env, email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const signedIn = await call(worker, environment, "/api/auth/sign-in/email-otp", { body: { email, name: "Push owner", otp } });
  const created = await call(worker, environment, "/v1/installations", {
    token: signedIn.headers.get("set-auth-token")!,
    body: { clientInstanceId: crypto.randomUUID(), name: "Test computer", platform: "linux" },
  });
  return (await created.json<{ credential: string }>()).credential;
}

const activity = {
  botId: "bot_1",
  botName: "Scout",
  kind: "needsYou",
  headline: "Scout needs you",
  since: 1_794_700_000_000,
  link: "openmausbot://chat/th_1",
  color: "#7C5CFF",
  gradient: ["#7C5CFF", "#4A2FE0"],
  body: "round",
};

const register = (worker: TestWorker, environment: Env, credential: string, body: Record<string, unknown>) =>
  call(worker, environment, "/v1/installations/self/push/register", { token: credential, body: { v: 1, environment: "production", ...body } });
const push = (worker: TestWorker, environment: Env, credential: string, body: Record<string, unknown>) =>
  call(worker, environment, "/v1/installations/self/push/activity", { token: credential, body: { v: 1, activity, ...body } });

describe("Live Activities and ongoing notifications by push", () => {
  beforeEach(() => forgetFcmAccessToken());

  it("updates a registered activity through APNs liveactivity, with names and kind only", async () => {
    const environment = await pushEnv();
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const credential = await installation(worker, environment, "activity-update@example.test");
    expect((await register(worker, environment, credential, { purpose: "activity", token: ACTIVITY_TOKEN })).status).toBe(200);
    const before = Math.floor(Date.now() / 1_000);
    expect((await push(worker, environment, credential, { token: ACTIVITY_TOKEN, event: "update", activity: { ...activity, kind: "working", headline: "Scout is working" } })).status).toBe(202);

    const [sent] = providers.apns();
    expect(sent!.url).toBe(`https://api.push.apple.com/3/device/${ACTIVITY_TOKEN}`);
    expect(sent!.headers).toMatchObject({ "apns-push-type": "liveactivity", "apns-topic": "com.example.mausbot.push-type.liveactivity", "apns-priority": "5" });
    expect(sent!.headers["apns-collapse-id"]).toBeUndefined();
    const body = JSON.parse(sent!.text) as { aps: Record<string, unknown> & { "content-state": { name: string; props: string } } };
    expect(body.aps).toMatchObject({ event: "update", "content-state": { name: "BotActivity" } });
    expect(body.aps["stale-date"]).toBeGreaterThanOrEqual(before + 15 * 60);
    expect(body.aps.alert).toBeUndefined();
    expect(JSON.parse(body.aps["content-state"].props)).toEqual({
      botId: "bot_1", name: "Scout", color: "#7C5CFF", gradient: ["#7C5CFF", "#4A2FE0"], body: "round",
      mood: "working", kind: "working", headline: "Scout is working", line: "", since: 1_794_700_000_000, link: "openmausbot://chat/th_1", answers: [],
    });
  });

  it("starts one with the push-to-start token, ringing, and ends one with a dismissal date", async () => {
    const environment = await pushEnv();
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const credential = await installation(worker, environment, "activity-start@example.test");
    await register(worker, environment, credential, { purpose: "activity-start", token: START_TOKEN });
    await register(worker, environment, credential, { purpose: "activity", token: ACTIVITY_TOKEN });
    expect((await push(worker, environment, credential, { token: START_TOKEN, event: "start", alert: true })).status).toBe(202);
    expect((await push(worker, environment, credential, { token: ACTIVITY_TOKEN, event: "end" })).status).toBe(202);

    const [start, end] = providers.apns().map((one) => ({ headers: one.headers, aps: (JSON.parse(one.text) as { aps: Record<string, unknown> }).aps }));
    expect(start!.headers["apns-priority"]).toBe("10");
    expect(start!.aps).toMatchObject({ event: "start", "attributes-type": "LiveActivityAttributes", attributes: { url: "openmausbot://chat/th_1" }, alert: { title: "Scout needs you", body: "Scout", sound: "default" } });
    expect(end!.aps.event).toBe("end");
    expect(end!.aps["dismissal-date"]).toEqual(expect.any(Number));
    expect(end!.aps["stale-date"]).toBeUndefined();
    expect(end!.aps.alert).toBeUndefined();
  });

  it("sends each token only what it was registered for", async () => {
    const environment = await pushEnv();
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const credential = await installation(worker, environment, "activity-purpose@example.test");
    await register(worker, environment, credential, { purpose: "activity-start", token: START_TOKEN });
    await register(worker, environment, credential, { purpose: "activity", token: ACTIVITY_TOKEN });
    await register(worker, environment, credential, { token: ALERT_TOKEN });
    expect((await push(worker, environment, credential, { token: ACTIVITY_TOKEN, event: "start" })).status).toBe(404);
    expect((await push(worker, environment, credential, { token: START_TOKEN, event: "update" })).status).toBe(404);
    expect((await push(worker, environment, credential, { token: ALERT_TOKEN, event: "update" })).status).toBe(404);
    const alert = await call(worker, environment, "/v1/installations/self/push/send", {
      token: credential,
      body: { v: 1, token: ACTIVITY_TOKEN, notification: { kind: "done", title: "Scout finished", botId: "bot_1", botName: "Scout", threadId: "th_1" } },
    });
    expect(alert.status).toBe(404);
    expect(providers.calls).toEqual([]);
    expect((await register(worker, environment, credential, { platform: "fcm", purpose: "activity", token: FCM_TOKEN, environment: undefined })).status).toBe(400);
  });

  it("sends Android a data message for its ongoing notification, urgent only when the bot needs the person", async () => {
    const environment = await pushEnv();
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const credential = await installation(worker, environment, "activity-fcm@example.test");
    await register(worker, environment, credential, { platform: "fcm", token: FCM_TOKEN, environment: undefined });
    expect((await push(worker, environment, credential, { token: FCM_TOKEN, event: "update", alert: true })).status).toBe(202);
    expect((await push(worker, environment, credential, { token: FCM_TOKEN, event: "update", activity: { ...activity, kind: "working", headline: "Scout is working" } })).status).toBe(202);
    const [needs, working] = providers.fcm().map((one) => (JSON.parse(one.text) as { message: { data: Record<string, string>; android: { priority: string } } }).message);
    expect(needs!.data).toMatchObject({ omb_kind: "activity", event: "update", bot_id: "bot_1", bot_name: "Scout", kind: "needsYou", headline: "Scout needs you", since: "1794700000000", link: "openmausbot://chat/th_1", alert: "1" });
    expect(needs!.data.title).toBeUndefined();
    expect(needs!.android.priority).toBe("HIGH");
    expect(working!.android.priority).toBe("NORMAL");
  });

  it("refuses anything that could carry message text or an answer link", async () => {
    const environment = await pushEnv();
    const providers = fakeProviders();
    const worker = createWorker(fetch, providers.fetch);
    const credential = await installation(worker, environment, "activity-strict@example.test");
    await register(worker, environment, credential, { purpose: "activity", token: ACTIVITY_TOKEN });
    for (const body of [
      { activity: { ...activity, line: "the reply text" } },
      { activity: { ...activity, answers: [{ label: "Allow", link: "openmausbot://answer?key=secret" }] } },
      { activity: { ...activity, headline: "Scout\nneeds you" } },
      { activity: { ...activity, link: "https://example.com/phish" } },
      { activity: { ...activity, color: "red" } },
      { activity: { ...activity, kind: "done" } },
      { event: "dismiss" },
      { message: "hello" },
    ]) {
      expect((await push(worker, environment, credential, { token: ACTIVITY_TOKEN, event: "update", ...body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(providers.calls).toEqual([]);
  });
});
