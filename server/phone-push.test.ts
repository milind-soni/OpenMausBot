import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PUSH_KINDS, phonePushCollapseId } from "../shared/phone-push.ts";
import {
  MAX_PUSH_DEVICES,
  PHONE_PUSH_DESKTOP_MESSAGE,
  PHONE_PUSH_FILE,
  PUSH_COALESCE_MS,
  PUSH_DEVICE_WINDOW_MAX,
  PUSH_MAX_AGE_MS,
  PUSH_RETRY_MS,
  PhonePush,
  PhonePushAccessSource,
  RELAY_UNAVAILABLE_PAUSE_MS,
  phonePushEnabled,
  phonePushNotification,
  registrationSchema,
  type PhonePushOptions,
} from "./phone-push.ts";

const CREDENTIAL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const ACCESS = { controlPlane: "https://accounts.openmausbot.test", credential: CREDENTIAL };
const APNS = "ab".repeat(32);
const APNS_2 = "cd".repeat(32);
const FCM = `fcmInstance_1:APA91b${"x".repeat(140)}`;
const PHONE = "session:phone-1";
const OTHER = "companion:device-2";

interface RelayCall { path: string; body: Record<string, unknown>; authorization: string | null }

function fakeRelay() {
  const calls: RelayCall[] = [];
  const answers: Array<{ status: number; error?: string; retryAfter?: number } | "unreachable"> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
    const answer = answers.shift();
    if (answer === "unreachable") throw new TypeError("fetch failed");
    const status = answer?.status ?? (url.pathname.endsWith("/send") ? 202 : url.pathname.endsWith("/unregister") ? 204 : 200);
    return new Response(answer?.error ? JSON.stringify({ error: answer.error }) : status === 204 ? null : "{}", {
      status,
      headers: answer?.retryAfter ? { "retry-after": String(answer.retryAfter) } : {},
    });
  }) as typeof fetch;
  return { calls, answers, fetchImpl, sends: () => calls.filter((call) => call.path.endsWith("/send")) };
}

let dataDir: string;
let clock: number;
let timers: Array<{ run: () => void; at: number }>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-phone-push-"));
  clock = 1_000_000;
  timers = [];
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function harness(options: Partial<PhonePushOptions> & { liveKeys?: Set<string> } = {}) {
  const relay = fakeRelay();
  const liveKeys = options.liveKeys ?? new Set<string>();
  let enabled = true;
  const push = new PhonePush({
    dataDir,
    access: () => ACCESS,
    enabled: () => enabled,
    live: (key) => liveKeys.has(key),
    room: () => undefined,
    fetchImpl: relay.fetchImpl,
    now: () => clock,
    log: () => {},
    timers: {
      set: (run, ms) => {
        const timer = { run, at: clock + ms };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        timers = timers.filter((timer) => timer !== handle);
      },
    },
    ...options,
  });
  return { push, relay, liveKeys, setEnabled: (on: boolean) => { enabled = on; } };
}

/** Moves the clock and runs the timers that came due. */
async function advance(push: PhonePush, ms: number) {
  clock += ms;
  for (const timer of timers.filter((one) => one.at <= clock)) {
    timers = timers.filter((one) => one !== timer);
    timer.run();
  }
  await push.flush();
}

const notification = (overrides: Record<string, unknown> = {}) => ({
  kind: "approval",
  botId: "bot_1",
  botName: "Scout",
  threadId: "th_1",
  title: "Scout needs approval",
  body: "PRIVATE: run `cat ~/payroll.csv` with API_KEY=sk-live-123",
  ...overrides,
});
const everyone = () => true;

describe("phone push switch", () => {
  it("is off unless config or OMB_PHONE_PUSH turns it on, and the variable wins", () => {
    expect(phonePushEnabled({}, {})).toBe(false);
    expect(phonePushEnabled({ features: { phonePush: true } }, {})).toBe(true);
    expect(phonePushEnabled({ features: { phonePush: true } }, { OMB_PHONE_PUSH: "0" })).toBe(false);
    expect(phonePushEnabled({}, { OMB_PHONE_PUSH: "1" })).toBe(true);
    expect(phonePushEnabled({ features: { phonePush: false } }, { OMB_PHONE_PUSH: "yes" })).toBe(false);
  });

  it("switched off, keeps nothing, sends nothing and says so", async () => {
    const { push, relay, setEnabled } = harness();
    setEnabled(false);
    const answer = await push.register(PHONE, { platform: "apns", token: APNS, environment: "production" });
    expect(answer).toEqual({ push: "off", device: null, relay: "off" });
    push.offer({ notification: notification(), seq: 7 }, everyone);
    await push.flush();
    expect(relay.calls).toEqual([]);
    expect(() => readFileSync(join(dataDir, PHONE_PUSH_FILE))).toThrow();
  });
});

describe("registering a phone", () => {
  it("keeps the token on this computer only (0600), registers it at the relay and never echoes it", async () => {
    const { push, relay } = harness();
    const answer = await push.register(PHONE, { platform: "apns", token: APNS, environment: "sandbox", pairing: "pair-tag-0001" });
    expect(answer).toEqual({ push: "on", relay: "registered", device: { platform: "apns", environment: "sandbox", pairing: "pair-tag-0001", kinds: [...PUSH_KINDS], updatedAt: clock } });
    expect(JSON.stringify(answer)).not.toContain(APNS);
    expect(relay.calls).toEqual([{ path: "/v1/installations/self/push/register", body: { v: 1, platform: "apns", token: APNS, environment: "sandbox" }, authorization: `Bearer ${CREDENTIAL}` }]);
    const file = join(dataDir, PHONE_PUSH_FILE);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new PhonePush({ dataDir, access: () => ACCESS, enabled: () => true, live: () => false, room: () => undefined, fetchImpl: relay.fetchImpl, log: () => {} }).answer(PHONE).device?.environment).toBe("sandbox");
  });

  it("registers an FCM token with no environment, and says when there is no account to push with", async () => {
    const { push, relay } = harness({ access: () => null });
    expect(await push.register(OTHER, { platform: "fcm", token: FCM, kinds: ["approval"] })).toMatchObject({ push: "no-account", relay: "off", device: { platform: "fcm", environment: "production", kinds: ["approval"] } });
    expect(relay.calls).toEqual([]);
  });

  it("moves a token to the newest pairing of the same phone, and unregisters a replaced token no one else uses", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    await push.register(OTHER, { platform: "apns", token: APNS });
    expect(push.answer(PHONE).device).toBeNull();
    expect(push.answer(OTHER).device).not.toBeNull();
    await push.register(OTHER, { platform: "apns", token: APNS_2 });
    expect(relay.calls.map((call) => [call.path.split("/").at(-1), call.body.token])).toEqual([
      ["register", APNS], ["register", APNS], ["unregister", APNS], ["register", APNS_2],
    ]);
  });

  it("forgets a phone here and at the relay when it is unpaired or removes itself", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "fcm", token: FCM });
    push.forget(PHONE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(push.answer(PHONE).device).toBeNull();
    expect(relay.calls.at(-1)).toMatchObject({ path: "/v1/installations/self/push/unregister", body: { v: 1, platform: "fcm", token: FCM } });
    expect(await push.remove(PHONE)).toBe(false);
  });

  it("caps the phones one computer keeps", async () => {
    const { push } = harness();
    for (let index = 0; index < MAX_PUSH_DEVICES; index += 1) {
      await push.register(`session:p${index}`, { platform: "apns", token: index.toString(16).padStart(2, "0").repeat(32) });
    }
    await expect(push.register("session:one-more", { platform: "apns", token: "ef".repeat(32) })).rejects.toMatchObject({ status: 409 });
  });

  it("takes only a well-formed registration", () => {
    expect(registrationSchema.safeParse({ platform: "apns", token: APNS.toUpperCase() }).data).toEqual({ platform: "apns", token: APNS, environment: "production" });
    for (const body of [
      { platform: "apns", token: FCM },
      { platform: "fcm", token: "short" },
      { platform: "fcm", token: FCM, environment: "sandbox" },
      { platform: "apns", token: APNS, kinds: ["routine-failed"] },
      { platform: "apns", token: APNS, pairing: "no spaces allowed" },
      { platform: "apns", token: APNS, pushToken: APNS },
      { platform: "webpush", token: FCM },
    ]) expect(registrationSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });
});

describe("offering a notify frame", () => {
  it("pushes only to a phone with no live stream that would have seen it, content-free, with the stream's identifier", async () => {
    const { push, relay, liveKeys } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS, pairing: "pair-tag-0001" });
    await push.register(OTHER, { platform: "fcm", token: FCM });
    await push.register("session:hidden", { platform: "apns", token: APNS_2 });
    liveKeys.add(OTHER);
    push.offer({ notification: notification(), seq: 42 }, (key) => key !== "session:hidden");
    await push.flush();
    expect(relay.sends()).toEqual([{
      path: "/v1/installations/self/push/send",
      authorization: `Bearer ${CREDENTIAL}`,
      body: { v: 1, token: APNS, pairing: "pair-tag-0001", collapseId: "openmaus.th_1.42", notification: { kind: "approval", title: "Scout needs approval", botId: "bot_1", botName: "Scout", threadId: "th_1" } },
    }]);
    const raw = JSON.stringify(relay.calls);
    for (const secret of ["PRIVATE", "payroll", "sk-live", "API_KEY"]) expect(raw).not.toContain(secret);
  });

  it("wakes the phone for approvals, questions, sign-ins and finished replies only, as the phone chose", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS, kinds: ["question", "sign-in", "done"] });
    for (const [seq, kind] of ["approval", "question", "sign-in", "done", "mention", "routine-failed", "spend", "secret"].entries()) {
      push.offer({ notification: notification({ kind, threadId: `th_${kind}` }), seq }, everyone);
    }
    await push.flush();
    expect(relay.sends().map((call) => (call.body.notification as { kind: string; title: string }).title)).toEqual([
      "Scout has a question", "Scout needs you to sign in to a website", "Scout finished",
    ]);
  });

  it("names the room, and leaves a frame alone that is not a notification", async () => {
    const { push, relay } = harness({ room: () => ({ id: "grp_1", name: "Launch\nteam" }) });
    await push.register(PHONE, { platform: "apns", token: APNS });
    push.offer({ notification: notification(), seq: 1 }, everyone);
    push.offer({ notification: { kind: "approval" }, seq: 2 }, everyone);
    push.offer({ notification: "approval", seq: 3 }, everyone);
    push.offer({ notification: notification({ botId: "bad id" }), seq: 4 }, everyone);
    await push.flush();
    expect(relay.sends().map((call) => call.body.notification)).toEqual([
      { kind: "approval", title: "Scout in Launch team needs approval", botId: "bot_1", botName: "Scout", threadId: "th_1", roomId: "grp_1", roomName: "Launch team" },
    ]);
  });

  it("sends one push per kind and conversation in ten seconds, then the next", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    push.offer({ notification: notification(), seq: 2 }, everyone);
    push.offer({ notification: notification({ kind: "question" }), seq: 3 }, everyone);
    await push.flush();
    clock += PUSH_COALESCE_MS;
    push.offer({ notification: notification(), seq: 4 }, everyone);
    await push.flush();
    expect(relay.sends().map((call) => call.body.collapseId)).toEqual(["openmaus.th_1.1", "openmaus.th_1.3", "openmaus.th_1.4"]);
  });

  it("stops a looping bot buzzing a pocket", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    for (let seq = 0; seq < PUSH_DEVICE_WINDOW_MAX + 5; seq += 1) push.offer({ notification: notification({ threadId: `th_${seq}` }), seq }, everyone);
    await push.flush();
    expect(relay.sends()).toHaveLength(PUSH_DEVICE_WINDOW_MAX);
  });
});

describe("the outbox", () => {
  it("retries a push the relay could not take, newest content winning, and gives up after the last wait", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    relay.answers.push("unreachable", { status: 502, error: "push_failed" }, { status: 503 }, "unreachable");
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    expect(push.pending()).toBe(1);
    push.offer({ notification: notification(), seq: 2 }, everyone);
    await push.flush();
    for (const wait of PUSH_RETRY_MS) await advance(push, wait);
    expect(relay.sends().map((call) => call.body.collapseId)).toEqual(["openmaus.th_1.1", "openmaus.th_1.2", "openmaus.th_1.2", "openmaus.th_1.2"]);
    expect(push.pending()).toBe(0);
  });

  it("drops a waiting push once the phone connects, or once it is too old to matter", async () => {
    const { push, relay, liveKeys } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    await push.register(OTHER, { platform: "apns", token: APNS_2 });
    relay.answers.push("unreachable", "unreachable");
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    liveKeys.add(PHONE);
    clock += PUSH_MAX_AGE_MS - PUSH_RETRY_MS[0] + 1;
    await advance(push, PUSH_RETRY_MS[0]);
    expect(relay.sends()).toHaveLength(2);
    expect(push.pending()).toBe(0);
  });

  it("registers again and retries once when the relay has lost the token", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "fcm", token: FCM });
    relay.answers.push({ status: 404, error: "push_device_unknown" });
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    expect(relay.calls.slice(1).map((call) => call.path.split("/").at(-1))).toEqual(["send", "register", "send"]);
    expect(relay.calls[2]!.body).toEqual({ v: 1, platform: "fcm", token: FCM });
  });

  it("drops a token the provider calls dead", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    relay.answers.push({ status: 410, error: "push_device_unregistered" });
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    expect(push.answer(PHONE).device).toBeNull();
    expect(JSON.parse(readFileSync(join(dataDir, PHONE_PUSH_FILE), "utf8")).devices).toEqual([]);
  });

  it("leaves the relay alone for an hour when it cannot push at all, and honours Retry-After", async () => {
    const { push, relay } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    relay.answers.push({ status: 503, error: "push_unavailable" });
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    push.offer({ notification: notification({ threadId: "th_2" }), seq: 2 }, everyone);
    await advance(push, RELAY_UNAVAILABLE_PAUSE_MS - 1);
    expect(relay.sends()).toHaveLength(1);
    await advance(push, 1);
    expect(relay.sends()).toHaveLength(1);

    relay.answers.push({ status: 429, error: "rate_limited", retryAfter: 120 });
    push.offer({ notification: notification({ threadId: "th_3" }), seq: 3 }, everyone);
    await push.flush();
    push.offer({ notification: notification({ threadId: "th_4" }), seq: 4 }, everyone);
    await advance(push, 119_000);
    expect(relay.sends()).toHaveLength(2);
    await advance(push, 1_000);
    expect(relay.sends().at(-1)!.body.collapseId).toBe("openmaus.th_4.4");
  });

  it("never throws into the server", async () => {
    const { push } = harness({ live: () => { throw new Error("boom"); } });
    await push.register(PHONE, { platform: "apns", token: APNS });
    expect(() => push.offer({ notification: notification(), seq: 1 }, everyone)).not.toThrow();
  });
});

describe("the push's identifier and title", () => {
  it("is the stream notification's own identifier when it fits APNs' 64 bytes", () => {
    expect(phonePushCollapseId("th_1", 9)).toBe("openmaus.th_1.9");
    expect(phonePushCollapseId("t".repeat(60), 9)).toBeUndefined();
    expect(phonePushCollapseId("th_1", -1)).toBeUndefined();
  });

  it("is built from names alone, clipped, never from the notification's text", () => {
    expect(phonePushNotification({ kind: "done", botId: "b", botName: `  ${"N".repeat(100)}\u0007`, threadId: "t" })?.botName).toHaveLength(80);
    expect(phonePushNotification({ kind: "mention", botId: "b", botName: "Scout", threadId: "t" })).toBeNull();
  });
});

describe("where the relay credential comes from", () => {
  const tunnelFile = () => join(dataDir, "tunnel-account.json");

  it("prefers the desktop app's message, including its 'none'", () => {
    writeFileSync(tunnelFile(), JSON.stringify({ companionInstallationCredential: CREDENTIAL }));
    const source = new PhonePushAccessSource({ env: { OMB_PUSH_CREDENTIAL: CREDENTIAL }, tunnelFile: tunnelFile(), defaultControlPlane: "https://accounts.openmausbot.com" });
    expect(source.receive({ type: "something-else" })).toBe(false);
    expect(source.receive({ type: PHONE_PUSH_DESKTOP_MESSAGE, access: { controlPlane: "https://accounts.openmausbot.com/", credential: CREDENTIAL } })).toBe(true);
    expect(source.current()).toEqual({ controlPlane: "https://accounts.openmausbot.com", credential: CREDENTIAL });
    source.receive({ type: PHONE_PUSH_DESKTOP_MESSAGE, access: null });
    expect(source.current()).toBeNull();
    source.receive({ type: PHONE_PUSH_DESKTOP_MESSAGE, access: { controlPlane: "http://evil.example", credential: CREDENTIAL } });
    expect(source.current()).toBeNull();
  });

  it("then OMB_PUSH_CREDENTIAL, a fleet's credential, then `openmausbot login`'s file", () => {
    const at = (env: NodeJS.ProcessEnv) => new PhonePushAccessSource({ env, tunnelFile: tunnelFile(), defaultControlPlane: "https://accounts.openmausbot.com" }).current();
    expect(at({})).toBeNull();
    writeFileSync(tunnelFile(), JSON.stringify({ companionInstallationCredential: CREDENTIAL }));
    expect(at({})).toEqual({ controlPlane: "https://accounts.openmausbot.com", credential: CREDENTIAL });
    expect(at({ OMB_PUSH_CREDENTIAL: "not-a-credential" })).toBeNull();
    expect(at({ OMB_INSTALLATION_CREDENTIAL: CREDENTIAL, OMB_CONTROL_PLANE_URL: "http://127.0.0.1:8787" })).toEqual({ controlPlane: "http://127.0.0.1:8787", credential: CREDENTIAL });
  });
});
