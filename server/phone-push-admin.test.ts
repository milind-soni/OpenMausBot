import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PHONE_ACTIVITY_RELAY_PATH, PHONE_PUSH_RELAY_PATHS } from "../shared/phone-push.ts";
import { CLOUD_HOME_PUSH_ACTIONS, cloudHomePushAccess, cloudHomePushRequest, cloudHomePushSignature } from "./phone-push-admin.ts";
import { PhonePush, PhonePushAccessSource, RELAY_UNAVAILABLE_PAUSE_MS, type PhonePushOptions } from "./phone-push.ts";

/** The bodies and the signature vector the Admin's tests read from their own copy of this file (openmaus-cloud
 * tests/fixtures/cloud-home-push.json): both copies must hash to this. */
const FIXTURE_FILE = new URL("../cloudflare/control-plane/test/fixtures/cloud-home-push.json", import.meta.url);
const FIXTURE_SHA256 = "1cac2c96498e57fb2527813f84be74d453f77d058a4499674afab69f5c3da47d";

const ADMIN = "https://cloud.mausbot.test";
const SECRET = "home-bootstrap-secret-0123456789abcdefghijklmnopq";
const MACHINE = "cm_home_one";
const HOME = { adminOrigin: ADMIN, machineId: MACHINE, bootstrapSecret: SECRET };
const APNS = "ab".repeat(32);
const PHONE = "session:phone-1";
const CREDENTIAL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;

interface AdminCall { url: string; body: string; headers: Headers }

function fakeAdmin() {
  const calls: AdminCall[] = [];
  const answers: Array<{ status: number; error?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body), headers: new Headers(init?.headers) });
    const answer = answers.shift();
    const status = answer?.status ?? (url.endsWith("/send") ? 202 : url.endsWith("/unregister") ? 204 : 200);
    return new Response(answer?.error ? JSON.stringify({ error: answer.error }) : status === 204 ? null : "{}", { status });
  }) as typeof fetch;
  return { calls, answers, fetchImpl, sends: () => calls.filter((call) => call.url.endsWith("/send")) };
}

let dataDir: string;
let clock: number;
let timers: Array<{ run: () => void; at: number }>;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-phone-push-admin-"));
  clock = 1_700_000_000_000;
  timers = [];
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function harness(options: Partial<PhonePushOptions> = {}) {
  const admin = fakeAdmin();
  let enabled = true;
  const push = new PhonePush({
    dataDir,
    access: () => cloudHomePushAccess(HOME),
    enabled: () => enabled,
    live: () => false,
    room: () => undefined,
    fetchImpl: admin.fetchImpl,
    now: () => clock,
    log: () => {},
    timers: {
      set: (run, ms) => { const timer = { run, at: clock + ms }; timers.push(timer); return timer; },
      clear: (handle) => { timers = timers.filter((timer) => timer !== handle); },
    },
    ...options,
  });
  return { push, admin, setEnabled: (on: boolean) => { enabled = on; } };
}

async function advance(push: PhonePush, ms: number) {
  clock += ms;
  for (const timer of timers.filter((one) => one.at <= clock)) {
    timers = timers.filter((one) => one !== timer);
    timer.run();
  }
  await push.flush();
}

const notification = (threadId = "th_1") => ({ kind: "approval", botId: "bot_1", botName: "Scout", threadId, body: "PRIVATE: the message text" });
const everyone = () => true;

/** Checks a request as the Admin does: the signature over machine, action, time, nonce and body, in constant time. */
function signedByHome(call: AdminCall, action: string): boolean {
  const presented = /^v1=([A-Za-z0-9_-]{43})$/.exec(call.headers.get("x-omb-cloud-signature") ?? "")?.[1];
  if (!presented) return false;
  const expected = cloudHomePushSignature(SECRET, call.headers.get("x-omb-cloud-machine") ?? "", action, call.headers.get("x-omb-cloud-timestamp") ?? "", call.headers.get("x-omb-cloud-nonce") ?? "", call.body);
  return timingSafeEqual(Buffer.from(presented, "base64url"), Buffer.from(expected, "base64url"));
}

describe("the shared contract with the Admin", () => {
  it("is the fixture both repositories hold, byte for byte", () => {
    // As LF text, so a Windows checkout with CRLF line ends hashes the same.
    expect(createHash("sha256").update(readFileSync(FIXTURE_FILE, "utf8").replace(/\r\n/g, "\n")).digest("hex")).toBe(FIXTURE_SHA256);
  });

  it("signs exactly as the fixture's vector says the Admin checks", () => {
    const { signature } = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as { signature: Record<string, string> };
    expect(cloudHomePushSignature(signature.secret!, signature.machineId!, signature.action!, signature.timestamp!, signature.nonce!, signature.body!)).toBe(signature.expected);
  });

  it("relays every installation route, Live Activities included, and nothing else", () => {
    expect(CLOUD_HOME_PUSH_ACTIONS).toEqual({
      [PHONE_PUSH_RELAY_PATHS.register]: "register",
      [PHONE_PUSH_RELAY_PATHS.unregister]: "unregister",
      [PHONE_PUSH_RELAY_PATHS.send]: "send",
      [PHONE_ACTIVITY_RELAY_PATH]: "activity",
    });
    expect(cloudHomePushRequest(cloudHomePushAccess(HOME)!, "/v1/installations/self/relay-token", {}, clock)).toBeNull();
  });
});

describe("a Cloud home's pushes through its Admin", () => {
  it("signs each call with its bootstrap secret and sends the installation routes' bodies unchanged", async () => {
    const { push, admin } = harness();
    const answer = await push.register(PHONE, { platform: "apns", token: APNS, environment: "production", pairing: "pair-tag-0001" });
    expect(answer).toMatchObject({ push: "on", relay: "registered" });
    push.offer({ notification: notification(), seq: 7 }, everyone);
    await push.flush();

    expect(admin.calls.map((call) => call.url)).toEqual([`${ADMIN}/api/cloud/machines/push/register`, `${ADMIN}/api/cloud/machines/push/send`]);
    const [register, send] = admin.calls;
    expect(JSON.parse(register!.body)).toEqual({ v: 1, platform: "apns", token: APNS, environment: "production" });
    expect(JSON.parse(send!.body)).toEqual({ v: 1, token: APNS, pairing: "pair-tag-0001", collapseId: "openmaus.th_1.7",
      notification: { kind: "approval", title: "Scout needs approval", botId: "bot_1", botName: "Scout", threadId: "th_1" } });
    expect(signedByHome(register!, "register")).toBe(true);
    expect(signedByHome(send!, "send")).toBe(true);
    // Signed for one route, it is not valid for another; the machine id rides in a header the signature covers.
    expect(signedByHome(send!, "activity")).toBe(false);
    for (const call of admin.calls) {
      expect(call.headers.get("x-omb-cloud-machine")).toBe(MACHINE);
      expect(call.headers.get("x-omb-cloud-timestamp")).toBe(String(Math.floor(clock / 1000)));
      expect(call.headers.get("authorization")).toBeNull();
      expect(`${call.body}${JSON.stringify([...call.headers])}`).not.toContain(SECRET);
      expect(call.body).not.toContain("PRIVATE");
      expect(call.body).not.toContain(MACHINE);
    }
    expect(admin.calls[0]!.headers.get("x-omb-cloud-nonce")).not.toBe(admin.calls[1]!.headers.get("x-omb-cloud-nonce"));
  });

  it("backs off an hour when the Admin or the control plane says push is unavailable, as an installation does", async () => {
    const { push, admin } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    admin.answers.push({ status: 503, error: "push_unavailable" });
    push.offer({ notification: notification("th_1"), seq: 1 }, everyone);
    await push.flush();
    expect(admin.sends()).toHaveLength(1);
    push.offer({ notification: notification("th_2"), seq: 2 }, everyone);
    await advance(push, RELAY_UNAVAILABLE_PAUSE_MS - 1);
    expect(admin.sends()).toHaveLength(1);
    await advance(push, 1);
    push.offer({ notification: notification("th_3"), seq: 3 }, everyone);
    await push.flush();
    expect(admin.sends()).toHaveLength(2);
  });

  it("backs off the same way from an Admin with the switch off (404) or one that refuses its signature (401)", async () => {
    for (const refusal of [{ status: 404, error: "Not found." }, { status: 401, error: "unauthorized" }]) {
      const { push, admin } = harness();
      await push.register(PHONE, { platform: "apns", token: APNS });
      admin.answers.push(refusal);
      push.offer({ notification: notification("th_1"), seq: 1 }, everyone);
      await push.flush();
      push.offer({ notification: notification("th_2"), seq: 2 }, everyone);
      await advance(push, 60_000);
      expect(admin.sends()).toHaveLength(1);
      rmSync(join(dataDir, "push-devices.json"), { force: true });
    }
  });

  it("registers again and retries once when the control plane has lost the token", async () => {
    const { push, admin } = harness();
    await push.register(PHONE, { platform: "apns", token: APNS });
    admin.answers.push({ status: 404, error: "push_device_unknown" });
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    expect(admin.calls.slice(1).map((call) => call.url.split("/").at(-1))).toEqual(["send", "register", "send"]);
  });

  it("switched off, keeps nothing and asks the Admin nothing", async () => {
    const { push, admin, setEnabled } = harness();
    setEnabled(false);
    expect(await push.register(PHONE, { platform: "apns", token: APNS })).toEqual({ push: "off", device: null, relay: "off" });
    push.offer({ notification: notification(), seq: 1 }, everyone);
    await push.flush();
    expect(admin.calls).toEqual([]);
  });
});

describe("which transport a server uses", () => {
  const tunnelFile = () => join(dataDir, "tunnel-account.json");
  const source = (env: NodeJS.ProcessEnv, cloudHome: typeof HOME | null) =>
    new PhonePushAccessSource({ env, tunnelFile: tunnelFile(), defaultControlPlane: "https://accounts.openmausbot.com", cloudHome }).current();

  it("is the Admin only for a Cloud home with no installation credential", () => {
    expect(source({}, null)).toBeNull();
    expect(source({}, HOME)).toEqual({ admin: ADMIN, machineId: MACHINE, secret: SECRET });
    expect(source({}, { ...HOME, adminOrigin: `${ADMIN}/` })).toEqual({ admin: ADMIN, machineId: MACHINE, secret: SECRET });
    // An installation credential wins, from the environment or `openmausbot login`'s file.
    expect(source({ OMB_PUSH_CREDENTIAL: CREDENTIAL }, HOME)).toEqual({ controlPlane: "https://accounts.openmausbot.com", credential: CREDENTIAL });
    writeFileSync(tunnelFile(), JSON.stringify({ companionInstallationCredential: CREDENTIAL }));
    expect(source({}, HOME)).toEqual({ controlPlane: "https://accounts.openmausbot.com", credential: CREDENTIAL });
    writeFileSync(tunnelFile(), JSON.stringify({}));
    expect(source({}, HOME)).toEqual({ admin: ADMIN, machineId: MACHINE, secret: SECRET });
  });
});
