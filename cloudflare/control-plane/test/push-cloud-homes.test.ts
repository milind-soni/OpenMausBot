import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { PUSH_DEVICE_LIMIT, PUSH_DEVICE_SEND_LIMIT, PUSH_REGISTER_LIMIT } from "../src/push";
import { CLOUD_HOME_FLEET_SEND_LIMIT, FLEET_ID } from "../src/push-cloud-homes";
import fixture from "./fixtures/cloud-home-push.json";

const BASE_URL = "https://auth.openmausbot.test";
const SECRET = "admin-push-relay-secret-0123456789abcdef";
const PREVIOUS = "admin-push-relay-secret-before-rotation-0123";
const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const MACHINE = "cm_home_one";
const OTHER = "cm_home_two";

type TestWorker = ReturnType<typeof createWorker>;
type Body = Record<string, unknown>;

function fakeApns(answers: Array<{ status: number; reason?: string }> = []) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(new Request(input).url);
    const answer = answers.shift() ?? { status: 200 };
    return new Response(answer.reason ? JSON.stringify({ reason: answer.reason }) : null, { status: answer.status });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function pem(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function pushEnv(extra: Record<string, string> = {}): Promise<Env> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    ...env,
    APNS_KEY_ID: "KEY1234567",
    APNS_TEAM_ID: "TEAM123456",
    APNS_BUNDLE_ID: "com.example.mausbot",
    APNS_PRIVATE_KEY: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer),
    APNS_ENVIRONMENTS: "production,sandbox",
    CLOUD_HOME_PUSH_SECRET: SECRET,
    ...extra,
  } as unknown as Env;
}

async function call(worker: TestWorker, testEnv: Env, path: string, options: { body?: unknown; token?: string; method?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const home = (worker: TestWorker, testEnv: Env, machine: string, action: string, body: unknown, token = SECRET) =>
  call(worker, testEnv, `/v1/cloud-homes/${machine}/push/${action}`, { token, body });

const notification = { kind: "approval", title: "Scout needs approval", botId: "bot_1", botName: "Scout", threadId: "th_1" };
const registration = (token = TOKEN_A) => ({ v: 1, token, environment: "production" });
const alert = (token = TOKEN_A) => ({ v: 1, token, notification });

async function installationCredential(worker: TestWorker, testEnv: Env, email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const signedIn = await call(worker, testEnv, "/api/auth/sign-in/email-otp", { body: { email, name: "Push owner", otp } });
  const created = await call(worker, testEnv, "/v1/installations", {
    token: signedIn.headers.get("set-auth-token")!,
    body: { clientInstanceId: crypto.randomUUID(), name: "Test computer", platform: "linux" },
  });
  return (await created.json<{ credential: string }>()).credential;
}

const count = async (sql: string, ...bind: unknown[]) => (await env.DB.prepare(sql).bind(...bind).first<{ n: number }>())?.n;

describe("phone push for Cloud homes (the Admin's machine routes)", () => {
  it("refuses every action until the Admin's secret is set, and any other bearer after", async () => {
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const unset = await pushEnv({ CLOUD_HOME_PUSH_SECRET: "" });
    for (const action of ["register", "unregister", "send", "activity", "forget"]) {
      const response = await home(worker, unset, MACHINE, action, {});
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "push_unavailable" });
    }
    // A secret too short to be one is the same as none.
    expect((await home(worker, await pushEnv({ CLOUD_HOME_PUSH_SECRET: "short" }), MACHINE, "register", registration(), "short")).status).toBe(503);

    const testEnv = await pushEnv();
    expect((await home(worker, testEnv, MACHINE, "register", registration(), "")).status).toBe(401);
    expect((await home(worker, testEnv, MACHINE, "register", registration(), `${SECRET}x`)).status).toBe(401);
    expect((await home(worker, testEnv, MACHINE, "send", alert(), "wrong-secret-of-the-same-length-0123456")).status).toBe(401);
    expect((await home(worker, testEnv, MACHINE, "forget", {}, PREVIOUS)).status).toBe(401);
    // An installation credential is not the Admin's secret, nor the other way round.
    const credential = await installationCredential(worker, testEnv, "machine-auth@example.test");
    expect((await home(worker, testEnv, MACHINE, "register", registration(), credential)).status).toBe(401);
    expect((await call(worker, testEnv, "/v1/installations/self/push/register", { token: SECRET, body: registration() })).status).toBe(401);
    // GET is not a route.
    expect((await call(worker, testEnv, `/v1/cloud-homes/${MACHINE}/push/send`, { method: "GET", token: SECRET })).status).toBe(405);
    expect(apns.calls).toEqual([]);
  });

  it("takes the previous secret beside the current one during a rotation", async () => {
    const worker = createWorker(fetch, fakeApns().fetch);
    const rotating = await pushEnv({ CLOUD_HOME_PUSH_SECRET: SECRET, CLOUD_HOME_PUSH_SECRET_PREVIOUS: PREVIOUS });
    expect((await home(worker, rotating, MACHINE, "register", registration(), PREVIOUS)).status).toBe(200);
    expect((await home(worker, rotating, MACHINE, "send", alert(), SECRET)).status).toBe(202);
    // The rotation is over once the previous one is removed.
    expect((await home(worker, await pushEnv(), MACHINE, "send", alert(), PREVIOUS)).status).toBe(401);
  });

  it("sends only to a token the same machine registered, never another machine's or an installation's", async () => {
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const testEnv = await pushEnv();
    expect((await home(worker, testEnv, MACHINE, "register", registration(TOKEN_A))).status).toBe(200);
    const foreign = await home(worker, testEnv, OTHER, "send", alert(TOKEN_A));
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "push_device_unknown" });
    const credential = await installationCredential(worker, testEnv, "machine-owner@example.test");
    expect((await call(worker, testEnv, "/v1/installations/self/push/send", { token: credential, body: alert(TOKEN_A) })).status).toBe(404);
    expect(apns.calls).toEqual([]);

    const sent = await home(worker, testEnv, MACHINE, "send", alert(TOKEN_A));
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ sent: true });
    expect(apns.calls).toEqual([`https://api.push.apple.com/3/device/${TOKEN_A}`]);
    // Stored under the machine, beside (never in) the installations' table.
    expect(await count("SELECT COUNT(*) AS n FROM machine_push_devices WHERE machine_id = ? AND last_sent_at IS NOT NULL", MACHINE)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM installation_push_devices")).toBe(0);
  });

  it("accepts every body the shared fixture accepts and refuses every one it refuses, before Apple is asked", async () => {
    const apns = fakeApns();
    const worker = createWorker(fetch, apns.fetch);
    const testEnv = await pushEnv();
    for (const [action, bodies] of Object.entries(fixture.accept) as [string, Body[]][]) {
      for (const body of bodies) {
        const response = await home(worker, testEnv, MACHINE, action, body);
        expect(response.status, `${action} ${JSON.stringify(body)}`).not.toBe(400);
      }
    }
    const before = apns.calls.length;
    for (const [action, cases] of Object.entries(fixture.refuse) as [string, { why: string; body: Body }[]][]) {
      for (const { why, body } of cases) {
        const response = await home(worker, testEnv, MACHINE, action, body);
        expect(response.status, `${action}: ${why}`).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_request" });
      }
    }
    expect(apns.calls.length).toBe(before);
  });

  it("limits each machine and each phone as an installation is limited, and the whole fleet", async () => {
    const worker = createWorker(fetch, fakeApns().fetch);
    const testEnv = await pushEnv();
    expect((await home(worker, testEnv, MACHINE, "register", registration())).status).toBe(200);
    for (let index = 1; index < PUSH_DEVICE_SEND_LIMIT; index += 1) await home(worker, testEnv, MACHINE, "send", alert());
    expect((await home(worker, testEnv, MACHINE, "send", alert())).status).toBe(202);
    const limited = await home(worker, testEnv, MACHINE, "send", alert());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");

    // Registrations: 120 an hour per machine.
    await env.DB.prepare("UPDATE machine_push_rate_limits SET attempts = ? WHERE machine_id = ? AND action = 'push_register'").bind(PUSH_REGISTER_LIMIT, MACHINE).run();
    expect((await home(worker, testEnv, MACHINE, "register", registration(TOKEN_B))).status).toBe(429);

    // The fleet: every machine's sends together. A send the fleet refuses spends none of the machine's own window.
    expect((await home(worker, testEnv, OTHER, "register", registration(TOKEN_B))).status).toBe(200);
    const now = Date.now();
    await env.DB.prepare("UPDATE machine_push_rate_limits SET attempts = ?, window_started_at = ? WHERE machine_id = ? AND action = 'push_send'")
      .bind(CLOUD_HOME_FLEET_SEND_LIMIT, now, FLEET_ID).run();
    expect((await home(worker, testEnv, OTHER, "send", alert(TOKEN_B))).status).toBe(429);
    expect(await count("SELECT COUNT(*) AS n FROM machine_push_rate_limits WHERE machine_id = ? AND action = 'push_send'", OTHER)).toBe(0);
  });

  it("keeps at most 50 tokens a machine, as for an installation", async () => {
    const worker = createWorker(fetch, fakeApns().fetch);
    const testEnv = await pushEnv();
    const token = (index: number) => index.toString(16).padStart(2, "0").repeat(32);
    for (let index = 0; index < PUSH_DEVICE_LIMIT; index += 1) expect((await home(worker, testEnv, MACHINE, "register", registration(token(index)))).status).toBe(200);
    const full = await home(worker, testEnv, MACHINE, "register", registration(token(99)));
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "push_device_limit" });
    expect((await home(worker, testEnv, OTHER, "register", registration(token(99)))).status).toBe(200);
  });

  it("forgets every token of a machine the Admin deleted, and only that machine's", async () => {
    const worker = createWorker(fetch, fakeApns().fetch);
    const testEnv = await pushEnv();
    await home(worker, testEnv, MACHINE, "register", registration(TOKEN_A));
    await home(worker, testEnv, MACHINE, "register", registration(TOKEN_B));
    await home(worker, testEnv, OTHER, "register", registration(TOKEN_A));
    expect((await home(worker, testEnv, MACHINE, "unregister", { v: 1, token: TOKEN_B })).status).toBe(204);
    expect(await count("SELECT COUNT(*) AS n FROM machine_push_devices WHERE machine_id = ?", MACHINE)).toBe(1);

    const forgot = await home(worker, testEnv, MACHINE, "forget", {});
    expect(forgot.status).toBe(204);
    expect(await count("SELECT COUNT(*) AS n FROM machine_push_devices WHERE machine_id = ?", MACHINE)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM machine_push_rate_limits WHERE machine_id = ?", MACHINE)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM machine_push_devices WHERE machine_id = ?", OTHER)).toBe(1);
    expect((await home(worker, testEnv, MACHINE, "send", alert(TOKEN_A))).status).toBe(404);
    // Again: nothing left, still 204.
    expect((await home(worker, testEnv, MACHINE, "forget", {})).status).toBe(204);
  });

  it("drops a token Apple says is dead for machines and installations alike", async () => {
    const worker = createWorker(fetch, fakeApns([{ status: 410, reason: "Unregistered" }]).fetch);
    const testEnv = await pushEnv();
    const credential = await installationCredential(worker, testEnv, "dead-token@example.test");
    expect((await call(worker, testEnv, "/v1/installations/self/push/register", { token: credential, body: registration(TOKEN_A) })).status).toBe(200);
    await home(worker, testEnv, MACHINE, "register", registration(TOKEN_A));
    const dead = await home(worker, testEnv, MACHINE, "send", alert(TOKEN_A));
    expect(dead.status).toBe(410);
    expect(await dead.json()).toEqual({ error: "push_device_unregistered" });
    expect(await count("SELECT COUNT(*) AS n FROM machine_push_devices WHERE token_hash IS NOT NULL")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM installation_push_devices")).toBe(0);
  });
});
