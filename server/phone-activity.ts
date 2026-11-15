// A paired phone's Live Activities (iPhone) and ongoing "working" notification (Android) while its app is closed. The
// phone registers its activity tokens and its own words; when a bot it would see starts needing the person, starts or
// stops working, and the phone holds no live stream, this asks the push relay to start, update or end that bot's
// activity. Names, kind and the phone's headline only. It rides phone push's switch, store rules and relay access.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  APNS_TOKEN,
  FCM_TOKEN,
  PHONE_ACTIVITY_RELAY_PATH,
  PHONE_PUSH_RELAY_PATHS,
  PHONE_PUSH_WIRE_VERSION,
  PUSH_ID,
  PUSH_NAME_MAX,
  PUSH_RELAY_ERRORS,
  type ActivityEvent,
  type ActivityKind,
  type ActivityVisual,
  type PhoneActivityRegistration,
  type PushRelayActivityRequest,
} from "../shared/phone-push.ts";
import { writeFileAtomic } from "./atomic.ts";
import { PUSH_DEVICE_KEY, type PhonePush } from "./phone-push.ts";

export const PHONE_ACTIVITY_FILE = "push-activity.json";
export const MAX_ACTIVITY_PHONES = 50;
export const MAX_ACTIVITIES = 10;
export const MAX_VISUALS = 60;
const HEADLINE_MAX = 120;
const NEEDS_YOU_KINDS: ReadonlySet<string> = new Set(["approval", "question", "sign-in"]);

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const visualSchema = z.object({ color: hex, gradient: z.array(hex).min(1).max(4), body: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict();
const headline = z.string().min(1).max(HEADLINE_MAX).refine((value) => value.includes("{name}") && !/[\p{Cc}\u2028\u2029]/u.test(value));

export const activityRegistrationSchema = z.object({
  scheme: z.enum(["openmausbot", "openmausbot-dev", "openmausbot-next"]),
  headlines: z.object({ needsYou: headline, working: headline }).strict(),
  startToken: z.string().trim().toLowerCase().regex(APNS_TOKEN).optional(),
  activities: z.array(z.object({ botId: z.string().regex(PUSH_ID), token: z.string().trim().toLowerCase().regex(APNS_TOKEN) }).strict()).max(MAX_ACTIVITIES).optional(),
  visuals: z.record(z.string().regex(PUSH_ID), visualSchema).refine((value) => Object.keys(value).length <= MAX_VISUALS).optional(),
  fallbackVisual: visualSchema.optional(),
  ongoing: z.boolean().optional(),
  kinds: z.array(z.enum(["needsYou", "working"])).max(2).optional(),
}).strict();

const storedSchema = z.object({ version: z.literal(1), phones: z.array(z.object({ key: z.string().regex(PUSH_DEVICE_KEY), registration: activityRegistrationSchema, updatedAt: z.number() })).max(MAX_ACTIVITY_PHONES) });
type Stored = z.infer<typeof storedSchema>["phones"][number];

/** The neutral look of a pushed activity for a bot the phone never drew. */
export const FALLBACK_VISUAL: ActivityVisual = { color: "#7C5CFF", gradient: ["#B9A9FF", "#7C5CFF", "#48369A"], body: "cursor" };

interface BotState {
  kind: ActivityKind;
  since: number;
  name: string;
  threadId: string;
}

export interface PhoneActivityOptions {
  dataDir: string;
  push: PhonePush;
  /** Whether a bot has an approval, question or sign-in card waiting on the person. */
  hasOpenAsk: (botId: string) => boolean;
  /** The bot as it is now: its name, whether any of its conversations is working, and which. */
  bot: (botId: string) => { name: string; busy: boolean; threadId: string } | undefined;
  /** The bot a conversation belongs to. */
  botOfThread: (threadId: string) => string | undefined;
  now?: () => number;
  log?: (line: string) => void;
  /** Frames for one bot gather this long before its state is read again. */
  settleMs?: number;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** The runtime events that change whether a bot is working or waiting on the person. */
const STATE_EVENTS: ReadonlySet<string> = new Set(["turn.started", "turn.completed", "turn.retrying", "turn.wait_started", "turn.wait_ended", "request.opened", "request.resolved", "session.exited"]);

export type ActivityOutcome = { key: string; botId: string; event: ActivityEvent; via: "apns" | "fcm"; result: "sent" | "dropped" | "failed" };

function headlineFor(template: string, name: string): string {
  const filled = template.replace("{name}", name).replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
  const points = [...filled];
  return points.length > HEADLINE_MAX ? `${points.slice(0, HEADLINE_MAX - 1).join("")}…` : filled;
}

function clipName(name: string): string {
  const points = [...name.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()];
  return (points.length > PUSH_NAME_MAX ? `${points.slice(0, PUSH_NAME_MAX - 1).join("")}…` : points.join("")) || "MausBot";
}

export class PhoneActivity {
  private phones: Stored[] = [];
  private readonly file: string;
  private readonly options: PhoneActivityOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** What each bot is doing now, from the frames that passed. */
  private readonly bots = new Map<string, BotState>();
  /** Each bot's last known name and conversation, for an end that comes after its state is gone. */
  private readonly seen = new Map<string, { name: string; threadId: string }>();
  /** What each phone was last sent per bot, so only a change goes out. */
  private readonly shown = new Map<string, Map<string, ActivityKind>>();
  /** The bots each phone has been told about since its app last connected; any other may still show what the app drew. */
  private readonly told = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, unknown>();
  private readonly reach = new Map<string, (key: string) => boolean>();
  private readonly askThread = new Map<string, string>();

  constructor(options: PhoneActivityOptions) {
    this.options = options;
    this.file = join(options.dataDir, PHONE_ACTIVITY_FILE);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const parsed = storedSchema.safeParse(raw);
    if (parsed.success) this.phones = parsed.data.phones;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, phones: this.phones }, null, 2)}\n`, { mode: 0o600 });
  }

  /** A registration as the phone may read it back: never a token. */
  registration(key: string): { scheme: string; headlines: Record<ActivityKind, string>; ongoing: boolean; kinds: ActivityKind[]; activities: string[]; canStart: boolean } | null {
    const found = this.phones.find((phone) => phone.key === key)?.registration;
    if (!found) return null;
    return {
      scheme: found.scheme,
      headlines: found.headlines,
      ongoing: found.ongoing === true,
      kinds: found.kinds ?? ["needsYou", "working"],
      activities: (found.activities ?? []).map(({ botId }) => botId),
      canStart: Boolean(found.startToken),
    };
  }

  /** Replaces this phone's registration. Switched off, nothing is kept. Tokens it no longer lists are unregistered. */
  async register(key: string, input: z.infer<typeof activityRegistrationSchema>): Promise<"off" | "saved"> {
    if (!PUSH_DEVICE_KEY.test(key)) throw new Error("not a phone");
    if (this.options.push.status() === "off") return "off";
    const previous = this.phones.find((phone) => phone.key === key);
    const others = this.phones.filter((phone) => phone.key !== key);
    if (!previous && others.length >= MAX_ACTIVITY_PHONES) throw Object.assign(new Error("Too many phones"), { status: 409 });
    this.phones = [...others, { key, registration: input, updatedAt: this.now() }];
    this.persist();
    const environment = this.options.push.deviceOf(key)?.environment ?? "production";
    const tokens = (registration: PhoneActivityRegistration | undefined) => new Map<string, "activity" | "activity-start">([
      ...(registration?.startToken ? [[registration.startToken, "activity-start"] as const] : []),
      ...(registration?.activities ?? []).map(({ token }) => [token, "activity"] as const),
    ]);
    const before = tokens(previous?.registration);
    const after = tokens(input);
    for (const token of before.keys()) {
      if (!after.has(token)) void this.options.push.call(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token });
    }
    if (this.options.push.status() === "on") {
      for (const [token, purpose] of after) {
        if (!before.has(token)) await this.options.push.call(PHONE_PUSH_RELAY_PATHS.register, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", purpose, token, environment });
      }
    }
    // The phone said which activities it holds: anything it no longer lists is not on screen.
    const listed = new Set((input.activities ?? []).map(({ botId }) => botId));
    const shown = this.shown.get(key);
    if (shown) for (const botId of shown.keys()) if (!listed.has(botId) && !input.ongoing) shown.delete(botId);
    return "saved";
  }

  async remove(key: string): Promise<void> {
    const previous = this.phones.find((phone) => phone.key === key);
    if (!previous) return;
    this.phones = this.phones.filter((phone) => phone.key !== key);
    this.shown.delete(key);
    this.persist();
    const tokens = [previous.registration.startToken, ...(previous.registration.activities ?? []).map(({ token }) => token)].filter((token): token is string => Boolean(token));
    await Promise.all(tokens.map((token) => this.options.push.call(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token })));
  }

  forget(key: string): void {
    void this.remove(key).catch((error) => this.log(`[phone-activity] could not forget a phone: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Resolves once every change offered so far has been sent (or given up). */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * A `bot`, `notify` or `runtime` frame left the server. After its bot's frames settle, what the bot is doing is read
   * again and, for each registered phone with no live stream that would have seen the frame, the change is pushed.
   * Never throws, and does nothing while phone push is off.
   */
  offer(payload: Record<string, unknown>, reaches: (key: string) => boolean): void {
    try {
      if (!this.phones.length || this.options.push.status() !== "on") return;
      const botId = this.botOf(payload);
      if (!botId) return;
      this.reach.set(botId, reaches);
      if (this.pending.has(botId)) return;
      const timers = this.options.timers ?? { set: (run: () => void, ms: number) => setTimeout(run, ms).unref(), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
      this.pending.set(botId, timers.set(() => {
        this.pending.delete(botId);
        this.settle(botId);
      }, this.options.settleMs ?? 250));
    } catch (error) {
      this.log(`[phone-activity] could not queue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The bot a frame is about, noting the conversation an ask came from; null for a frame that changes no activity. */
  private botOf(payload: Record<string, unknown>): string | null {
    if (payload.kind === "notify") {
      const notification = payload.notification as Record<string, unknown> | undefined;
      const botId = notification?.botId, threadId = notification?.threadId, kind = notification?.kind;
      if (typeof botId !== "string" || typeof kind !== "string" || !PUSH_ID.test(botId) || !NEEDS_YOU_KINDS.has(kind)) return null;
      if (typeof threadId === "string") this.askThread.set(botId, threadId);
      return botId;
    }
    if (payload.kind === "bot") {
      const botId = (payload.bot as Record<string, unknown> | undefined)?.id;
      return typeof botId === "string" && PUSH_ID.test(botId) ? botId : null;
    }
    if (payload.kind === "runtime") {
      const event = payload.event as Record<string, unknown> | undefined;
      if (typeof event?.type !== "string" || !STATE_EVENTS.has(event.type) || typeof event.threadId !== "string") return null;
      const botId = this.options.botOfThread(event.threadId);
      return botId && PUSH_ID.test(botId) ? botId : null;
    }
    return null;
  }

  /** Reads what the bot is doing now and pushes each phone the change, if any. */
  private settle(botId: string): void {
    try {
      if (this.options.push.status() !== "on") return;
      const now = this.now();
      const bot = this.options.bot(botId);
      const previous = this.bots.get(botId);
      const kind: ActivityKind | undefined = !bot ? undefined : this.options.hasOpenAsk(botId) ? "needsYou" : bot.busy ? "working" : undefined;
      if (bot) this.remember(botId, bot.name, kind === "needsYou" ? this.askThread.get(botId) ?? bot.threadId : bot.threadId);
      if (kind && bot) this.bots.set(botId, { kind, since: previous?.kind === kind ? previous.since : now, name: bot.name, threadId: this.seen.get(botId)?.threadId ?? bot.threadId });
      else this.bots.delete(botId);
      if (kind !== "needsYou") this.askThread.delete(botId);
      const reaches = this.reach.get(botId) ?? (() => false);
      for (const phone of this.phones) {
        if (this.options.push.isLive(phone.key)) {
          // Its app draws its own activities while connected; after, the server starts from nothing.
          this.shown.delete(phone.key);
          this.told.delete(phone.key);
          continue;
        }
        if (!reaches(phone.key)) continue;
        const shown = this.shown.get(phone.key) ?? new Map<string, ActivityKind>();
        this.shown.set(phone.key, shown);
        const told = this.told.get(phone.key) ?? new Set<string>();
        this.told.set(phone.key, told);
        const firstNews = !told.has(botId);
        told.add(botId);
        const wanted = kind && (phone.registration.kinds ?? ["needsYou", "working"]).includes(kind) ? kind : undefined;
        const was = shown.get(botId);
        if (wanted === was) {
          // The app may have drawn this bot before it went quiet: end what it left, once.
          const drawn = phone.registration.ongoing === true || phone.registration.activities?.some((entry) => entry.botId === botId) === true;
          if (firstNews && !wanted && drawn) this.enqueue(phone, botId, undefined, "working");
          continue;
        }
        if (wanted) shown.set(botId, wanted);
        else shown.delete(botId);
        this.enqueue(phone, botId, wanted, was);
      }
    } catch (error) {
      this.log(`[phone-activity] could not push: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Runs every settle that is waiting now, then waits for the sends. */
  async flushNow(): Promise<void> {
    const timers = this.options.timers;
    for (const [botId, handle] of this.pending) {
      timers?.clear(handle);
      this.pending.delete(botId);
      this.settle(botId);
    }
    await this.queue;
  }

  private remember(botId: string, name: string, threadId: string): void {
    this.seen.delete(botId);
    this.seen.set(botId, { name, threadId });
    for (const oldest of this.seen.keys()) {
      if (this.seen.size <= 500) break;
      this.seen.delete(oldest);
    }
  }

  private enqueue(phone: Stored, botId: string, wanted: ActivityKind | undefined, was: ActivityKind | undefined): void {
    const state = this.bots.get(botId);
    this.queue = this.queue.then(() => this.send(phone, botId, wanted, was, state)).catch((error: unknown) => {
      this.log(`[phone-activity] could not push: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private activityBody(phone: Stored, botId: string, kind: ActivityKind, state: BotState | undefined, fallbackName: string): PushRelayActivityRequest["activity"] {
    const registration = phone.registration;
    const visual = registration.visuals?.[botId] ?? registration.fallbackVisual ?? FALLBACK_VISUAL;
    const known = state ?? this.seen.get(botId);
    const name = clipName(known?.name ?? fallbackName);
    return {
      botId,
      botName: name,
      kind,
      headline: headlineFor(registration.headlines[kind], name),
      since: state?.since ?? this.now(),
      link: `${registration.scheme}://chat/${encodeURIComponent(known?.threadId ?? botId)}`,
      ...visual,
    };
  }

  private async send(phone: Stored, botId: string, wanted: ActivityKind | undefined, was: ActivityKind | undefined, state: BotState | undefined): Promise<ActivityOutcome[]> {
    const outcomes: ActivityOutcome[] = [];
    const registration = phone.registration;
    const kind = wanted ?? was;
    if (!kind) return outcomes;
    const activity = this.activityBody(phone, botId, kind, state, botId);
    const alert = wanted === "needsYou" && was !== "needsYou";
    const event: ActivityEvent = wanted ? "update" : "end";

    const running = registration.activities?.find((entry) => entry.botId === botId);
    if (running) {
      outcomes.push(await this.post(phone.key, botId, { v: PHONE_PUSH_WIRE_VERSION, token: running.token, event, ...(alert ? { alert } : {}), activity }, "apns"));
      if (event === "end") this.dropActivity(phone.key, botId);
    } else if (wanted === "needsYou" && registration.startToken && alert) {
      // Only a bot that starts needing the person is started remotely: a working bot is news the app shows when opened.
      outcomes.push(await this.post(phone.key, botId, { v: PHONE_PUSH_WIRE_VERSION, token: registration.startToken, event: "start", alert: true, activity }, "apns"));
    }

    const device = this.options.push.deviceOf(phone.key);
    if (registration.ongoing && device?.platform === "fcm" && FCM_TOKEN.test(device.token)) {
      outcomes.push(await this.post(phone.key, botId, { v: PHONE_PUSH_WIRE_VERSION, token: device.token, event, ...(alert ? { alert } : {}), activity }, "fcm"));
    }
    return outcomes;
  }

  private async post(key: string, botId: string, body: PushRelayActivityRequest, via: "apns" | "fcm"): Promise<ActivityOutcome> {
    const answer = await this.options.push.call(PHONE_ACTIVITY_RELAY_PATH, body);
    const base = { key, botId, event: body.event, via } as const;
    if (answer && answer.status < 300) return { ...base, result: "sent" };
    if (answer && (answer.status === 410 || answer.code === PUSH_RELAY_ERRORS.unregistered || answer.code === PUSH_RELAY_ERRORS.unknownDevice)) {
      if (via === "apns") {
        if (body.event === "start") this.dropStartToken(key);
        else this.dropActivity(key, botId);
      }
      return { ...base, result: "dropped" };
    }
    return { ...base, result: "failed" };
  }

  private dropActivity(key: string, botId: string): void {
    const phone = this.phones.find((candidate) => candidate.key === key);
    const activities = phone?.registration.activities;
    if (!phone || !activities?.some((entry) => entry.botId === botId)) return;
    const removed = activities.filter((entry) => entry.botId === botId);
    phone.registration = { ...phone.registration, activities: activities.filter((entry) => entry.botId !== botId) };
    this.persist();
    for (const { token } of removed) void this.options.push.call(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token });
  }

  private dropStartToken(key: string): void {
    const phone = this.phones.find((candidate) => candidate.key === key);
    if (!phone?.registration.startToken) return;
    const { startToken: _dropped, ...rest } = phone.registration;
    phone.registration = rest;
    this.persist();
  }
}
