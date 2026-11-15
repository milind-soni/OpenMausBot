import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityRegistrationSchema, FALLBACK_VISUAL, PhoneActivity } from "./phone-activity.ts";
import { PhonePush } from "./phone-push.ts";

const CREDENTIAL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const START = "5a".repeat(40);
const ACT = "ac".repeat(40);
const FCM = `fcmInstance_1:APA91b${"x".repeat(140)}`;
const IPHONE = "session:iphone";
const ANDROID = "companion:android";
const VISUAL = { color: "#7C5CFF", gradient: ["#B9A9FF", "#7C5CFF", "#48369A"], body: "round" };
const HEADLINES = { needsYou: "{name} needs you", working: "{name} is working" };

interface Call { path: string; body: Record<string, unknown> }

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-phone-activity-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function harness(options: { enabled?: boolean; live?: Set<string>; openAsks?: Set<string>; answers?: Array<{ status: number; error?: string }> } = {}) {
  const calls: Call[] = [];
  const answers = [...(options.answers ?? [])];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    const answer = path.endsWith("/activity") ? answers.shift() : undefined;
    const status = answer?.status ?? (path.endsWith("/unregister") ? 204 : path.endsWith("/register") ? 200 : 202);
    return new Response(answer?.error ? JSON.stringify({ error: answer.error }) : status === 204 ? null : "{}", { status });
  }) as typeof fetch;
  const live = options.live ?? new Set<string>();
  const push = new PhonePush({
    dataDir,
    access: () => ({ controlPlane: "https://accounts.openmausbot.test", credential: CREDENTIAL }),
    enabled: () => options.enabled ?? true,
    live: (key) => live.has(key),
    room: () => undefined,
    fetchImpl,
    log: () => {},
  });
  const openAsks = options.openAsks ?? new Set<string>();
  const bots = new Map<string, { name: string; busy: boolean; threadId: string }>([["bot_1", { name: "Scout", busy: false, threadId: "th_1" }]]);
  let clock = 1_000_000;
  const activity = new PhoneActivity({
    dataDir, push, hasOpenAsk: (botId) => openAsks.has(botId), bot: (botId) => bots.get(botId), botOfThread: (threadId) => (threadId.startsWith("th_") ? "bot_1" : undefined),
    now: () => clock, log: () => {}, timers: { set: () => ({}), clear: () => {} },
  });
  const activityCalls = () => calls.filter((call) => call.path.endsWith("/push/activity")).map((call) => call.body);
  /** The bot works (or stops), a frame says so, and its frames settle. */
  const step = async (change: { busy?: boolean; ask?: boolean; name?: string }, payload: Record<string, unknown> = { kind: "bot", bot: { id: "bot_1" } }, reaches: (key: string) => boolean = () => true) => {
    const bot = bots.get("bot_1")!;
    bots.set("bot_1", { ...bot, ...(change.busy === undefined ? {} : { busy: change.busy }), ...(change.name ? { name: change.name } : {}) });
    if (change.ask === true) openAsks.add("bot_1");
    if (change.ask === false) openAsks.delete("bot_1");
    activity.offer(payload, reaches);
    await activity.flushNow();
  };
  return { push, activity, calls, activityCalls, live, openAsks, step, tick: (ms: number) => { clock += ms; } };
}

const registration = (extra: Record<string, unknown> = {}) => activityRegistrationSchema.parse({ scheme: "openmausbot", headlines: HEADLINES, ...extra });
const notify = (kind: string) => ({ kind: "notify", notification: { kind, botId: "bot_1", botName: "Scout", threadId: "th_ask", title: "Scout needs approval", body: "PRIVATE run cat ~/payroll.csv" } });
const runtime = (type: string) => ({ kind: "runtime", event: { type, threadId: "th_1", eventId: "e1", provider: "claudeAgent", createdAt: "" } });
const everyone = () => true;

describe("registering a phone's activities", () => {
  it("keeps nothing while phone push is off", async () => {
    const { activity, calls, step } = harness({ enabled: false });
    expect(await activity.register(IPHONE, registration({ startToken: START }))).toBe("off");
    expect(activity.registration(IPHONE)).toBeNull();
    await step({ busy: true });
    expect(calls).toEqual([]);
  });

  it("registers the push-to-start and activity tokens with their purpose, never echoes them, and drops replaced ones", async () => {
    const { activity, calls } = harness();
    await activity.register(IPHONE, registration({ startToken: START, activities: [{ botId: "bot_1", token: ACT }], visuals: { bot_1: VISUAL } }));
    expect(calls.map((call) => call.body)).toEqual([
      { v: 1, platform: "apns", purpose: "activity-start", token: START, environment: "production" },
      { v: 1, platform: "apns", purpose: "activity", token: ACT, environment: "production" },
    ]);
    expect(activity.registration(IPHONE)).toEqual({ scheme: "openmausbot", headlines: HEADLINES, ongoing: false, kinds: ["needsYou", "working"], activities: ["bot_1"], canStart: true });
    expect(JSON.stringify(activity.registration(IPHONE))).not.toContain(ACT);
    await activity.register(IPHONE, registration({ startToken: START }));
    expect(calls.at(-1)).toEqual({ path: "/v1/installations/self/push/unregister", body: { v: 1, platform: "apns", token: ACT } });
  });

  it("takes only its own words with a place for the name, and well-formed tokens and colours", () => {
    for (const bad of [
      { headlines: { needsYou: "needs you", working: "{name} is working" } },
      { headlines: { needsYou: "{name}\nneeds you", working: "{name} is working" } },
      { startToken: FCM },
      { visuals: { bot_1: { ...VISUAL, color: "purple" } } },
      { scheme: "https" },
      { activities: Array.from({ length: 11 }, (_, index) => ({ botId: `b${index}`, token: ACT })) },
      { line: "text" },
    ]) expect(activityRegistrationSchema.safeParse({ scheme: "openmausbot", headlines: HEADLINES, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("pushing a bot's activity while the app is closed", () => {
  it("updates a running activity as the bot starts and stops working, once per change, then forgets its token", async () => {
    const { activity, activityCalls, calls, step } = harness();
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }], visuals: { bot_1: VISUAL } }));
    await step({ busy: true }, runtime("turn.started"));
    await step({}, runtime("turn.started"));
    await step({ busy: false }, runtime("turn.completed"));
    expect(activityCalls()).toEqual([
      { v: 1, token: ACT, event: "update", activity: { botId: "bot_1", botName: "Scout", kind: "working", headline: "Scout is working", since: 1_000_000, link: "openmausbot://chat/th_1", ...VISUAL } },
      { v: 1, token: ACT, event: "end", activity: { botId: "bot_1", botName: "Scout", kind: "working", headline: "Scout is working", since: 1_000_000, link: "openmausbot://chat/th_1", ...VISUAL } },
    ]);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/installations/self/push/unregister", body: { token: ACT } });
    expect(activity.registration(IPHONE)?.activities).toEqual([]);
  });

  it("rings when a bot starts needing the person, and starts an activity remotely only then", async () => {
    const { activity, activityCalls, step } = harness();
    await activity.register(IPHONE, registration({ startToken: START }));
    await step({ busy: true });
    await step({ ask: true }, notify("approval"));
    await step({}, notify("done"));
    expect(activityCalls()).toEqual([
      { v: 1, token: START, event: "start", alert: true, activity: { botId: "bot_1", botName: "Scout", kind: "needsYou", headline: "Scout needs you", since: 1_000_000, link: "openmausbot://chat/th_ask", ...FALLBACK_VISUAL } },
    ]);
    expect(JSON.stringify(activityCalls())).not.toContain("payroll");
  });

  it("drives Android's ongoing notification through the phone's FCM token", async () => {
    const { push, activity, activityCalls, step } = harness();
    await push.register(ANDROID, { platform: "fcm", token: FCM });
    await activity.register(ANDROID, registration({ ongoing: true }));
    await step({ busy: true });
    await step({ ask: true }, runtime("request.opened"));
    await step({ ask: false, busy: false }, runtime("turn.completed"));
    expect(activityCalls().map((body) => [body.token === FCM, body.event, (body.activity as { kind: string }).kind, body.alert ?? false])).toEqual([
      [true, "update", "working", false],
      [true, "update", "needsYou", true],
      [true, "end", "needsYou", false],
    ]);
  });

  it("leaves a connected phone to its own app, and a phone that may not see the bot alone", async () => {
    const { activity, activityCalls, live, step } = harness();
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }] }));
    live.add(IPHONE);
    await step({ busy: true });
    live.delete(IPHONE);
    await step({}, undefined, () => false);
    expect(activityCalls()).toEqual([]);
    await step({});
    expect(activityCalls()).toHaveLength(1);
    await step({}, { kind: "runtime", event: { type: "content.delta", threadId: "th_1" } });
    await step({}, { kind: "message", threadId: "th_1" });
    expect(activityCalls()).toHaveLength(1);
  });

  it("honours the kinds the phone asked for", async () => {
    const { activity, activityCalls, step } = harness();
    await activity.register(IPHONE, registration({ kinds: ["needsYou"], activities: [{ botId: "bot_1", token: ACT }] }));
    await step({ busy: true });
    await step({ busy: true }, runtime("turn.started"));
    // Never an update for a kind the phone did not ask for; only the one end for what its app may have drawn.
    expect(activityCalls().map((body) => body.event)).toEqual(["end"]);
  });

  it("drops an activity token the provider calls dead", async () => {
    const { activity, step } = harness({ answers: [{ status: 410, error: "push_device_unregistered" }] });
    await activity.register(IPHONE, registration({ activities: [{ botId: "bot_1", token: ACT }] }));
    await step({ busy: true });
    expect(activity.registration(IPHONE)?.activities).toEqual([]);
  });

  it("forgets a phone and its tokens when it is unpaired", async () => {
    const { activity, calls } = harness();
    await activity.register(IPHONE, registration({ startToken: START, activities: [{ botId: "bot_1", token: ACT }] }));
    await activity.remove(IPHONE);
    expect(calls.filter((call) => call.path.endsWith("/unregister")).map((call) => call.body.token)).toEqual([START, ACT]);
    expect(activity.registration(IPHONE)).toBeNull();
  });

  it("never throws into the server", () => {
    const { activity } = harness();
    expect(() => activity.offer({ kind: "bot", bot: null }, everyone)).not.toThrow();
    expect(() => activity.offer({ kind: "notify", notification: "x" }, everyone)).not.toThrow();
  });

  it("ends what the app drew for a bot that went quiet after the phone's stream closed, once", async () => {
    const { push, activity, activityCalls, live, step } = harness();
    await push.register(ANDROID, { platform: "fcm", token: FCM });
    await activity.register(ANDROID, registration({ ongoing: true }));
    await activity.register(IPHONE, registration({}));
    live.add(ANDROID);
    await step({ busy: true });
    live.delete(ANDROID);
    await step({ busy: false });
    await step({ busy: false });
    expect(activityCalls().map((body) => [body.token === FCM, body.event])).toEqual([[true, "end"]]);
  });
});
