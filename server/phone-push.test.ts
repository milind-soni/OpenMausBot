import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COMPANION_INSTALLATION_CREDENTIAL_FIELD } from "../electron/companion-account-service.mjs";
import type { Notification } from "../shared/notification.ts";
import {
  PHONE_PUSH_DESKTOP_MESSAGE,
  PUSH_DEVICE_WINDOW_MAX,
  PhonePush,
  PhonePushAccessSource,
  type PhonePushAccess,
} from "./phone-push.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { newInstallationCredential, startFakeControlPlane, type FakeControlPlane } from "./testing/fake-control-plane.ts";
import { TUNNEL_CREDENTIALS_FILE } from "./tunnel.ts";

const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const SECRET_BODY = "rm -rf /Users/someone/private && export API_KEY=sk-live-should-never-leave";

const approval = (overrides: Partial<Notification> = {}): Notification => ({
  kind: "approval",
  botId: "bot_scout",
  botName: "Scout",
  threadId: "th_room",
  title: "Scout needs approval",
  body: SECRET_BODY,
  avatarUrl: "/api/attachments/avatar.png",
  ...overrides,
});

let dir = "";
let relay: FakeControlPlane;
let clock = 1_000_000;
let live = new Set<string>();
let enabled = true;
let access: PhonePushAccess | null = null;
let visible = (_key: string, _notification: Notification, _adminOnly: boolean) => true;

const make = () => new PhonePush({
  file: join(dir, "push-devices.json"),
  access: () => access,
  enabled: () => enabled,
  live: (key) => live.has(key),
  audience: (key, notification, adminOnly) => visible(key, notification, adminOnly),
  room: (notification) => notification.threadId === "th_room" ? { id: "grp_launch", name: "Launch" } : undefined,
  now: () => clock,
  log: () => {},
});

const sends = () => relay.requests.filter((request) => request.path.endsWith("/push/send"));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-phone-push-"));
  relay = await startFakeControlPlane();
  access = { controlPlane: relay.url, credential: relay.credential };
  clock = 1_000_000;
  live = new Set();
  enabled = true;
  visible = () => true;
});

afterEach(async () => {
  await relay.stop();
  await removeTempDir(dir);
});

describe("registering a phone", () => {
  it("stores the token with the device and registers it at the relay for this installation", async () => {
    const push = make();
    const result = await push.register("companion:dev_1", { token: TOKEN_A, environment: "production", pairing: "pair-tag-1" });
    expect(result.relay).toBe("registered");
    expect(result.device).toMatchObject({ environment: "production", enabled: true, pairing: "pair-tag-1" });
    expect(relay.registered()).toEqual([TOKEN_A]);
    const register = await relay.waitFor((request) => request.path.endsWith("/push/register"));
    expect(register.authorization).toBe(`Bearer ${relay.credential}`);
    expect(register.body).toEqual({ v: 1, token: TOKEN_A, environment: "production" });
    // persisted, owner-only, and read back by the next process
    const file = join(dir, "push-devices.json");
    if (process.platform !== "win32") expect((await import("node:fs")).statSync(file).mode & 0o777).toBe(0o600);
    expect(make().device("companion:dev_1")).toMatchObject({ pairing: "pair-tag-1" });
  });

  it("keeps a registration made while the relay is unreachable, and registers it on the first send", async () => {
    access = null;
    const push = make();
    expect((await push.register("session:s1", { token: TOKEN_A, environment: "sandbox" })).relay).toBe("off");
    expect(relay.requests).toEqual([]);
    access = { controlPlane: relay.url, credential: relay.credential };
    expect(await push.dispatch(approval())).toEqual([{ key: "session:s1", outcome: "sent" }]);
    // send → 404 unknown → register → send
    expect(relay.requests.map((request) => `${request.path.split("/").pop()} ${request.status}`)).toEqual(["send 404", "register 200", "send 202"]);
  });

  it("gives a re-paired phone's token to its newest pairing, so it is never pushed twice", async () => {
    const push = make();
    await push.register("companion:old", { token: TOKEN_A, environment: "production" });
    await push.register("companion:new", { token: TOKEN_A, environment: "production" });
    expect(push.device("companion:old")).toBeNull();
    expect(await push.dispatch(approval())).toEqual([{ key: "companion:new", outcome: "sent" }]);
    expect(sends()).toHaveLength(1);
  });

  it("drops a revoked phone here and at the relay, unless another pairing still uses the token", async () => {
    const push = make();
    await push.register("companion:dev_1", { token: TOKEN_A, environment: "production" });
    await push.register("session:s1", { token: TOKEN_B, environment: "production" });
    push.forget("companion:dev_1");
    await relay.waitFor((request) => request.path.endsWith("/push/unregister"));
    expect(relay.registered()).toEqual([TOKEN_B]);
    expect(push.device("companion:dev_1")).toBeNull();
    expect(await push.dispatch(approval())).toEqual([{ key: "session:s1", outcome: "sent" }]);
    expect(JSON.parse(readFileSync(join(dir, "push-devices.json"), "utf8")).devices.map((device: { key: string }) => device.key)).toEqual(["session:s1"]);
  });
});

describe("dispatching a notification", () => {
  it("sends exactly one content-free push: kind, names and ids, never the text", async () => {
    const push = make();
    await push.register("companion:dev_1", { token: TOKEN_A, environment: "production", pairing: "pair-tag-1" });
    expect(await push.dispatch(approval())).toEqual([{ key: "companion:dev_1", outcome: "sent" }]);
    expect(sends()).toHaveLength(1);
    const [send] = sends();
    expect(send!.body).toEqual({
      v: 1,
      token: TOKEN_A,
      pairing: "pair-tag-1",
      notification: {
        kind: "approval",
        title: "Scout in Launch needs approval",
        botId: "bot_scout",
        botName: "Scout",
        threadId: "th_room",
        roomId: "grp_launch",
        roomName: "Launch",
      },
    });
    expect(send!.raw).not.toContain("rm -rf");
    expect(send!.raw).not.toContain("sk-live");
    expect(send!.raw).not.toContain("/Users/");
    expect(send!.raw).not.toContain("avatar");
    expect(send!.raw).not.toContain('"body"');
  });

  it("skips a phone whose app holds a live stream, and pushes once it lets go", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production" });
    live.add("session:s1");
    expect(await push.dispatch(approval())).toEqual([{ key: "session:s1", outcome: "live" }]);
    live.clear();
    expect(await push.dispatch(approval())).toEqual([{ key: "session:s1", outcome: "sent" }]);
    expect(sends()).toHaveLength(1);
  });

  it("respects the global switch, a phone's own opt-out and what the phone may see", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production" });
    await push.register("session:s2", { token: TOKEN_B, environment: "production", enabled: false });
    enabled = false;
    expect((await push.dispatch(approval())).map((result) => result.outcome)).toEqual(["off", "off"]);
    enabled = true;
    visible = (_key, _notification, adminOnly) => !adminOnly;
    expect(await push.dispatch(approval({ kind: "spend" }), { adminOnly: true })).toEqual([
      { key: "session:s1", outcome: "not-visible" },
      { key: "session:s2", outcome: "opted-out" },
    ]);
    expect(sends()).toHaveLength(0);
  });

  it("keeps a phone's opt-out when it registers again without `enabled`", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production", enabled: false });
    // the launch-time refresh omits `enabled`
    await push.register("session:s1", { token: TOKEN_B, environment: "production", pairing: "pair-tag-1" });
    expect(push.device("session:s1")).toMatchObject({ enabled: false, pairing: "pair-tag-1" });
    expect(make().device("session:s1")).toMatchObject({ enabled: false });
    expect(await push.dispatch(approval())).toEqual([{ key: "session:s1", outcome: "opted-out" }]);
    // only an explicit value changes it
    await push.register("session:s1", { token: TOKEN_B, environment: "production", enabled: true });
    expect(push.device("session:s1")).toMatchObject({ enabled: true });
  });

  it("is a silent no-op without a control-plane account", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production" });
    access = null;
    expect(push.status()).toBe("no-account");
    expect(await push.dispatch(approval())).toEqual([{ key: "session:s1", outcome: "off" }]);
  });

  it("coalesces repeats in one conversation and caps a phone's rate", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production" });
    expect((await push.dispatch(approval()))[0]!.outcome).toBe("sent");
    expect((await push.dispatch(approval()))[0]!.outcome).toBe("coalesced");
    for (let index = 1; index < PUSH_DEVICE_WINDOW_MAX; index += 1) {
      clock += 1;
      expect((await push.dispatch(approval({ threadId: `th_${index}` })))[0]!.outcome).toBe("sent");
    }
    expect((await push.dispatch(approval({ threadId: "th_over" })))[0]!.outcome).toBe("rate-limited");
    clock += 10 * 60_000;
    expect((await push.dispatch(approval({ threadId: "th_later" })))[0]!.outcome).toBe("sent");
  });

  it("drops a token APNs reported dead", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production" });
    relay.answerNext("/v1/installations/self/push/send", 410, { error: "push_device_unregistered" });
    expect(await push.dispatch(approval())).toEqual([{ key: "session:s1", outcome: "dropped" }]);
    expect(push.device("session:s1")).toBeNull();
  });

  it("leaves a control plane without the relay routes alone for an hour", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production" });
    relay.answerNext("/v1/installations/self/push/send", 404, { error: "not_found" });
    expect((await push.dispatch(approval()))[0]!.outcome).toBe("failed");
    expect((await push.dispatch(approval({ threadId: "th_2" })))[0]!.outcome).toBe("paused");
    expect(sends()).toHaveLength(1);
  });

  it("leaves a relay without an APNs key alone for an hour", async () => {
    const push = make();
    await push.register("session:s1", { token: TOKEN_A, environment: "production" });
    relay.answerNext("/v1/installations/self/push/send", 503, { error: "push_unavailable" });
    expect((await push.dispatch(approval()))[0]!.outcome).toBe("failed");
    clock += 59 * 60_000;
    expect((await push.dispatch(approval({ threadId: "th_2" })))[0]!.outcome).toBe("paused");
    clock += 2 * 60_000;
    expect((await push.dispatch(approval({ threadId: "th_3" })))[0]!.outcome).toBe("sent");
  });
});

describe("where the relay credential comes from", () => {
  it("reads serve --tunnel's account file, a fleet's env, and the desktop app's message", () => {
    const credential = newInstallationCredential();
    const tunnelFile = join(dir, TUNNEL_CREDENTIALS_FILE);
    const source = (env: NodeJS.ProcessEnv = {}) => new PhonePushAccessSource({ env, tunnelFile, defaultControlPlane: "https://control.example.test" });
    expect(source().current()).toBeNull();

    writeFileSync(tunnelFile, JSON.stringify({ [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: credential }));
    expect(source().current()).toEqual({ controlPlane: "https://control.example.test", credential });
    // the operator's override, as `serve --tunnel` honours it; never a non-loopback http
    expect(source({ OMB_CONTROL_PLANE_URL: "http://127.0.0.1:4321" }).current()?.controlPlane).toBe("http://127.0.0.1:4321");
    expect(source({ OMB_CONTROL_PLANE_URL: "http://relay.example.test" }).current()).toBeNull();

    const fleet = newInstallationCredential();
    expect(source({ OMB_INSTALLATION_CREDENTIAL: fleet }).current()?.credential).toBe(fleet);

    const desktop = source();
    expect(desktop.receive({ type: "openmausbot:pro-plan", pro: true })).toBe(false);
    expect(desktop.receive({ type: PHONE_PUSH_DESKTOP_MESSAGE, access: { controlPlane: "https://control.example.test", credential: fleet } })).toBe(true);
    expect(desktop.current()?.credential).toBe(fleet);
    // the desktop app signing out wins over a stale file on disk
    expect(desktop.receive({ type: PHONE_PUSH_DESKTOP_MESSAGE, access: null })).toBe(true);
    expect(desktop.current()).toBeNull();
    expect(desktop.receive({ type: PHONE_PUSH_DESKTOP_MESSAGE, access: { controlPlane: "https://control.example.test", credential: "omb_sess_wrong" } })).toBe(true);
    expect(desktop.current()).toBeNull();
  });
});
