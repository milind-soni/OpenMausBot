// A real server in a temporary home with the fake engines and a stand-in control plane: two paired phones register for
// closed-app alerts; a finished reply and a question reach, as content-free pushes carrying the stream's own
// identifier, only the phone that holds no live event stream; signing a phone out unregisters its token; a phone whose
// stream closes gets the next one. Phone push is on by default, yet with no phone paired that server calls the control
// plane not once, at start or after an alert. Two more servers, switched off in config.json and by OMB_PHONE_PUSH=0, keep
// nothing and call nobody.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startControlPlaneStub, type ControlPlaneStub } from "./testing/control-plane-stub.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const SECRET_REPLY = "PRIVATE-REPLY-TEXT see /Users/someone/payroll.csv token sk-live-abc123";
const APNS_A = "a1".repeat(32);
const FCM_B = `fcmPhoneB_01:APA91b${"Q".repeat(140)}`;

interface Fixture { child: ChildProcess; home: string; base: string; stderr: () => string }

let stub: ControlPlaneStub;
let offStub: ControlPlaneStub;
let on: Fixture;
let off: Fixture;
let envOff: Fixture;
const streams: SseRecorder[] = [];

async function boot(env: Record<string, string>, features: Record<string, boolean> = {}): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "omb-phone-push-"));
  const data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false, ...features },
    instances: {
      quick: { driver: "claudeAgent", displayName: "Quick fixture", environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_REPLIES: JSON.stringify(Array.from({ length: 8 }, () => SECRET_REPLY)) }, config: { cli: FAKE_CLAUDE } },
      slow: { driver: "claudeAgent", displayName: "Slow fixture", environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(home, "finish-gate") }, config: { cli: FAKE_CLAUDE } },
      curious: { driver: "grokAgent", displayName: "Curious fixture", environment: { FAKE_ACP_MODE: "question" }, config: { cli: FAKE_ACP, fullAuto: true } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  let stderr = "";
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const base = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 20_000; ;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try { if ((await fetch(`${base}/api/health`)).status === 200) break; } catch {}
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, home, base, stderr: () => stderr };
}

const api = async (fixture: Fixture, method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(fixture.base + path, {
    method,
    headers: { origin: fixture.base, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};

const pair = async (fixture: Fixture, label: string) => {
  const opened = await api(fixture, "POST", "/api/auth/pairing", { label, scopes: ["admin", "client"] });
  expect(opened.status).toBe(200);
  const paired = await api(fixture, "POST", "/api/auth/pair", { code: opened.body.code });
  expect(paired.body.token).toMatch(/^omb_sess_/u);
  return paired.body as { token: string; session: { id: string } };
};

const createBot = async (fixture: Fixture, name: string, instanceId: string, model: string) => {
  const created = (await api(fixture, "POST", "/api/bots", {})).body.bot;
  const patched = await api(fixture, "PATCH", `/api/bots/${created.id}`, { name, notifications: true, modelSelection: { instanceId, model } });
  expect(patched.status).toBe(200);
  return patched.body.bot as { id: string; threadId: string };
};

const sends = () => stub.pushes.filter((push) => push.path.endsWith("/send"));

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  [stub, offStub] = await Promise.all([startControlPlaneStub(), startControlPlaneStub()]);
  const credential = stub.seedInstallation("phone push fixture");
  const offCredential = offStub.seedInstallation("phone push off fixture");
  // `on` has no switch at all: phone push is on by default.
  [on, off, envOff] = await Promise.all([
    boot({ OMB_CONTROL_PLANE_URL: stub.url, OMB_PUSH_CREDENTIAL: credential }),
    boot({ OMB_CONTROL_PLANE_URL: offStub.url, OMB_PUSH_CREDENTIAL: offCredential }, { phonePush: false }),
    boot({ OMB_PHONE_PUSH: "0", OMB_CONTROL_PLANE_URL: offStub.url, OMB_PUSH_CREDENTIAL: offCredential }),
  ]);
}, 60_000);

afterAll(async () => {
  for (const stream of streams) stream.close();
  for (const fixture of [on, off, envOff]) {
    if (!fixture) continue;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    await removeTempDir(fixture.home);
  }
  await stub?.close();
  await offStub?.close();
});

describe("phone push on by default, with no phone paired", () => {
  it("calls the control plane not once, at start or after a finished reply", async () => {
    expect(stub.calls).toEqual([]);
    const watcher = await openSse(`${on.base}/api/events`, { origin: on.base });
    streams.push(watcher);
    await watcher.until((frame) => frame.kind === "hello", 10_000);
    const echo = await createBot(on, "Echo", "quick", "claude-sonnet-5");
    expect((await api(on, "POST", `/api/bots/${echo.id}/messages`, { text: "anyone there?" })).status).toBe(202);
    await watcher.until((frame) => frame.kind === "notify" && frame.notification?.kind === "done" && frame.notification?.botId === echo.id, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(stub.calls).toEqual([]);
    watcher.close();
  }, 60_000);
});

describe("phone push switched off", () => {
  it("in config.json or by OMB_PHONE_PUSH=0: answers off, keeps nothing and calls no relay", async () => {
    for (const fixture of [off, envOff]) {
      const phone = await pair(fixture, "Off phone");
      expect(await api(fixture, "PUT", "/api/push/device", { platform: "apns", token: APNS_A }, phone.token)).toEqual({ status: 200, body: { push: "off", relay: "off", device: null } });
      expect(await api(fixture, "GET", "/api/push/device", undefined, phone.token)).toEqual({ status: 200, body: { push: "off", device: null } });
    }
    expect(offStub.calls).toEqual([]);
  });
});

describe("phone push on by default, with phones paired", () => {
  it("wakes only the phone that is not connected, without the reply's text, and stops when it signs out", async () => {
    const phoneA = await pair(on, "Phone A");
    const phoneB = await pair(on, "Phone B");
    expect((await api(on, "PUT", "/api/push/device", { platform: "apns", token: APNS_A, environment: "sandbox", pairing: "pair-tag-aaaa" }, phoneA.token)).body)
      .toMatchObject({ push: "on", relay: "registered", device: { platform: "apns", environment: "sandbox", pairing: "pair-tag-aaaa" } });
    expect((await api(on, "PUT", "/api/push/device", { platform: "fcm", token: FCM_B, pairing: "pair-tag-bbbb" }, phoneB.token)).body)
      .toMatchObject({ push: "on", relay: "registered", device: { platform: "fcm", environment: "production" } });
    expect(stub.pushes.map((push) => push.body)).toEqual([
      { v: 1, platform: "apns", token: APNS_A, environment: "sandbox" },
      { v: 1, platform: "fcm", token: FCM_B },
    ]);

    const streamA = await openSse(`${on.base}/api/events`, { authorization: `Bearer ${phoneA.token}`, origin: on.base });
    streams.push(streamA);
    await streamA.until((frame) => frame.kind === "hello", 10_000);
    const herald = await createBot(on, "Herald", "quick", "claude-sonnet-5");
    expect((await api(on, "POST", `/api/bots/${herald.id}/messages`, { text: "how did it go?" })).status).toBe(202);
    const done = await streamA.until((frame) => frame.kind === "notify" && frame.notification?.kind === "done" && frame.notification?.botId === herald.id, 30_000);
    expect(done.notification.body).toContain("PRIVATE-REPLY-TEXT");

    await expect.poll(() => sends().length, { timeout: 15_000 }).toBe(1);
    expect(sends()[0]!.body).toEqual({
      v: 1,
      token: FCM_B,
      pairing: "pair-tag-bbbb",
      collapseId: `openmaus.${herald.threadId}.${done.seq}`,
      notification: { kind: "done", title: "Herald finished", botId: herald.id, botName: "Herald", threadId: herald.threadId },
    });
    const raw = JSON.stringify(stub.pushes);
    for (const secret of ["PRIVATE-REPLY-TEXT", "payroll", "sk-live", "/Users/"]) expect(raw).not.toContain(secret);

    const sage = await createBot(on, "Sage", "curious", "fake-model");
    expect((await api(on, "PATCH", `/api/bots/${sage.id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
    expect((await api(on, "POST", `/api/bots/${sage.id}/messages`, { text: "pick a colour for the banner" })).status).toBe(202);
    const question = await streamA.until((frame) => frame.kind === "notify" && frame.notification?.kind === "question" && frame.notification?.botId === sage.id, 30_000);
    await expect.poll(() => sends().length, { timeout: 15_000 }).toBe(2);
    expect(sends()[1]!.body).toMatchObject({ token: FCM_B, collapseId: `openmaus.${question.notification.threadId}.${question.seq}`, notification: { kind: "question", title: "Sage has a question" } });
    await api(on, "POST", `/api/bots/${sage.id}/interrupt`, {}).catch(() => undefined);

    expect((await api(on, "POST", "/api/auth/logout", {}, phoneB.token)).status).toBe(200);
    await expect.poll(() => stub.pushes.at(-1), { timeout: 10_000 }).toEqual({ path: "/v1/installations/self/push/unregister", body: { v: 1, platform: "fcm", token: FCM_B } });

    streamA.close();
    await expect.poll(async () => (await api(on, "GET", "/api/push/device", undefined, phoneA.token)).body.device?.platform, { timeout: 5_000 }).toBe("apns");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await api(on, "POST", `/api/bots/${herald.id}/messages`, { text: "and now?" })).status).toBe(202);
    await expect.poll(() => sends().length, { timeout: 30_000 }).toBe(3);
    expect(sends()[2]!.body).toMatchObject({ token: APNS_A, pairing: "pair-tag-aaaa", notification: { kind: "done", title: "Herald finished" } });
    expect(on.stderr()).not.toContain(FCM_B);
  }, 120_000);
});

describe("Live Activities by push", () => {
  it("updates and ends a closed phone's activity for a bot as it works, with the phone's own words and no reply text", async () => {
    const ACTIVITY = "ac".repeat(40);
    const phone = await pair(on, "Phone C");
    const pip = await createBot(on, "Pip", "slow", "claude-sonnet-5");
    expect((await api(on, "PUT", "/api/push/device", { platform: "apns", token: "c3".repeat(32) }, phone.token)).status).toBe(200);
    const registered = await api(on, "PUT", "/api/push/activity", {
      scheme: "openmausbot",
      headlines: { needsYou: "{name} braucht dich", working: "{name} arbeitet" },
      statuses: { working: "Arbeitet", needsYou: { approval: "Braucht deine Freigabe", question: "Hat eine Frage", signIn: "Braucht deine Anmeldung", other: "Braucht dich" } },
      activities: [{ botId: pip.id, token: ACTIVITY }],
      visuals: { [pip.id]: { color: "#7C5CFF", gradient: ["#B9A9FF", "#7C5CFF"], body: "round" } },
    }, phone.token);
    expect(registered.body).toMatchObject({ push: "on", activity: { activities: [pip.id], canStart: false } });
    expect(JSON.stringify(registered.body)).not.toContain(ACTIVITY);
    expect(stub.pushes.at(-1)!.body).toEqual({ v: 1, platform: "apns", purpose: "activity", token: ACTIVITY, environment: "production" });

    const activityPushes = () => stub.pushes.filter((push) => push.path.endsWith("/push/activity")).map((push) => push.body);
    expect((await api(on, "POST", `/api/bots/${pip.id}/messages`, { text: "go" })).status).toBe(202);
    await expect.poll(() => activityPushes().map((body) => body.event), { timeout: 30_000 }).toEqual(["update"]);
    writeFileSync(join(on.home, "finish-gate"), "");
    await expect.poll(() => activityPushes().map((body) => body.event), { timeout: 30_000 }).toEqual(["update", "end"]);
    expect(activityPushes()[0]).toEqual({
      v: 1,
      token: ACTIVITY,
      event: "update",
      activity: {
        botId: pip.id, botName: "Pip", kind: "working", headline: "Pip arbeitet", since: expect.any(Number), link: `openmausbot://chat/${pip.threadId}`, color: "#7C5CFF", gradient: ["#B9A9FF", "#7C5CFF"], body: "round",
        version: 1, ask: "other", status: "Arbeitet", waiting: 0,
      },
    });
    for (const body of activityPushes()) expect(body).not.toHaveProperty("alert");
    expect(JSON.stringify(activityPushes())).not.toContain("PRIVATE-REPLY-TEXT");
    await expect.poll(() => stub.pushes.at(-1), { timeout: 10_000 }).toEqual({ path: "/v1/installations/self/push/unregister", body: { v: 1, platform: "apns", token: ACTIVITY } });
  }, 90_000);
});
