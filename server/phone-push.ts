// Closed-app phone alerts. A paired phone registers its APNs or FCM device token here; when an approval, a question, a
// sign-in request or a finished reply would reach a phone that holds no live event stream, this asks the push relay in
// the hosted control plane to wake it, with the installation credential this server already has. The push is
// content-free: kind, a title from names alone, opaque ids. Off unless `features.phonePush` (or OMB_PHONE_PUSH=1).
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { COMPANION_INSTALLATION_CREDENTIAL_FIELD } from "../electron/companion-account-service.mjs";
import { normalizeControlPlaneURL } from "../electron/control-plane-client.mjs";
import {
  APNS_TOKEN,
  FCM_TOKEN,
  PAIRING_TAG,
  PHONE_PUSH_RELAY_PATHS,
  PHONE_PUSH_WIRE_VERSION,
  PUSH_ID,
  PUSH_KINDS,
  PUSH_NAME_MAX,
  PUSH_RELAY_ERRORS,
  PUSH_TITLE_MAX,
  isPushKind,
  phonePushCollapseId,
  validPushToken,
  type PhonePushAnswer,
  type PhonePushNotification,
  type PhonePushRegistration,
  type PhonePushState,
  type PublicPushDevice,
  type PushKind,
} from "../shared/phone-push.ts";
import { writeFileAtomic } from "./atomic.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "./server-lines.ts";

export const PHONE_PUSH_FILE = "push-devices.json";
export const PHONE_PUSH_ENV = "OMB_PHONE_PUSH";
/** A push-only installation credential, for a server that holds no other (a Cloud home). */
export const PHONE_PUSH_CREDENTIAL_ENV = "OMB_PUSH_CREDENTIAL";
export const PHONE_PUSH_DESKTOP_MESSAGE = "openmausbot:phone-push-access";

const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
/** As routes/phones.ts `phoneKey` mints them. */
export const PUSH_DEVICE_KEY = /^(companion|session):[\w-]{1,128}$/;
export const MAX_PUSH_DEVICES = 50;

/** One push per phone, kind and conversation in this window; the newest waiting one replaces an older one. */
export const PUSH_COALESCE_MS = 10_000;
export const PUSH_DEVICE_WINDOW_MS = 10 * 60_000;
export const PUSH_DEVICE_WINDOW_MAX = 30;
/** A push still undelivered after this is dropped: the phone shows the news when it next connects. */
export const PUSH_MAX_AGE_MS = 10 * 60_000;
/** Waits before each retry of a push the relay could not take (network, 5xx). */
export const PUSH_RETRY_MS = [5_000, 30_000, 120_000] as const;
/** How long the relay is left alone after it said it cannot push at all (no keys, credential refused). */
export const RELAY_UNAVAILABLE_PAUSE_MS = 60 * 60_000;
const RELAY_TIMEOUT_MS = 10_000;

const TITLES: Record<PushKind, ServerLineKey> = {
  approval: "server.notify.approval",
  question: "server.notify.question",
  "sign-in": "server.notify.signInWebsite",
  done: "server.notify.done",
};

/** On only when switched on: OMB_PHONE_PUSH=1 or 0 wins over `features.phonePush` in config.json. */
export function phonePushEnabled(cfg: { features?: { phonePush?: boolean } }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[PHONE_PUSH_ENV] === "1") return true;
  if (env[PHONE_PUSH_ENV] === "0") return false;
  return cfg.features?.phonePush === true;
}

const kindsSchema = z.array(z.enum(PUSH_KINDS)).max(PUSH_KINDS.length);

export const registrationSchema = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("apns"), token: z.string().trim().toLowerCase().regex(APNS_TOKEN), environment: z.enum(["production", "sandbox"]).default("production"), pairing: z.string().regex(PAIRING_TAG).optional(), kinds: kindsSchema.optional() }).strict(),
  z.object({ platform: z.literal("fcm"), token: z.string().trim().regex(FCM_TOKEN), environment: z.literal("production").optional(), pairing: z.string().regex(PAIRING_TAG).optional(), kinds: kindsSchema.optional() }).strict(),
]);

const storedDevice = z.object({
  key: z.string().regex(PUSH_DEVICE_KEY),
  platform: z.enum(["apns", "fcm"]),
  token: z.string(),
  environment: z.enum(["production", "sandbox"]),
  pairing: z.string().regex(PAIRING_TAG).optional(),
  kinds: kindsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}).refine((device) => validPushToken(device.platform, device.token));
const storedFile = z.object({ version: z.literal(1), devices: z.array(storedDevice).max(MAX_PUSH_DEVICES) });
type StoredDevice = z.infer<typeof storedDevice>;

export interface PhonePushAccess {
  controlPlane: string;
  credential: string;
}

export type PushOutcome = "sent" | "dropped" | "stale" | "live" | "gone" | "failed" | "retry" | "paused";

export interface PhonePushOptions {
  dataDir: string;
  access: () => PhonePushAccess | null;
  enabled: () => boolean;
  /** Whether this phone holds a live event stream right now. */
  live: (key: string) => boolean;
  /** The room a notification came out of, for its name. */
  room: (notification: PushableNotification) => { id: string; name: string } | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** The fields a push reads from a `notify` frame's notification: never its `body`. */
export interface PushableNotification {
  kind: string;
  botId: string;
  botName: string;
  threadId: string;
  groupId?: string;
}

interface Job {
  key: string;
  slot: string;
  push: PhonePushNotification;
  collapseId?: string;
  queuedAt: number;
  notBefore: number;
  attempts: number;
}

export interface RelayAnswer {
  status: number;
  code?: string;
  retryAfterMs?: number;
}

function clip(value: string, max: number): string {
  const points = [...value.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

function pushableOf(value: unknown): PushableNotification | null {
  if (!value || typeof value !== "object") return null;
  const { kind, botId, botName, threadId, groupId } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof botId !== "string" || typeof botName !== "string" || typeof threadId !== "string") return null;
  return { kind, botId, botName, threadId, ...(typeof groupId === "string" ? { groupId } : {}) };
}

/** The push for one notification, or null when it is not a kind a closed app is woken for or an id is not one the
 * relay takes. Reads the kind, the ids and the names; the title is the server's own line for that kind, from names. */
export function phonePushNotification(notification: PushableNotification, room?: { id: string; name: string }): PhonePushNotification | null {
  if (!isPushKind(notification.kind) || !PUSH_ID.test(notification.botId) || !PUSH_ID.test(notification.threadId)) return null;
  const botName = clip(notification.botName, PUSH_NAME_MAX) || "MausBot";
  const roomName = room && PUSH_ID.test(room.id) ? clip(room.name, PUSH_NAME_MAX) : "";
  const language = conversationLanguage(notification.threadId);
  const who = roomName ? serverLine(language, "server.notify.inRoom", { bot: botName, room: roomName }) : botName;
  return {
    kind: notification.kind,
    title: clip(serverLine(language, TITLES[notification.kind], { who }), PUSH_TITLE_MAX),
    botId: notification.botId,
    botName,
    threadId: notification.threadId,
    ...(room && roomName ? { roomId: room.id, roomName } : {}),
  };
}

export class PhonePush {
  private devices: StoredDevice[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly timers: NonNullable<PhonePushOptions["timers"]>;
  private readonly sent = new Map<string, number[]>();
  private readonly lastBySlot = new Map<string, number>();
  private readonly outbox = new Map<string, Job>();
  private pausedUntil = 0;
  private timer: unknown = null;
  private draining: Promise<void> | null = null;
  private readonly options: PhonePushOptions;

  constructor(options: PhonePushOptions) {
    this.options = options;
    this.file = join(options.dataDir, PHONE_PUSH_FILE);
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
    this.timers = options.timers ?? {
      set: (run, ms) => setTimeout(run, ms).unref(),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    const parsed = storedFile.safeParse(raw);
    if (parsed.success) this.devices = parsed.data.devices;
    else this.log("[phone-push] the saved phone registrations could not be read; phones register again when they connect");
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
  }

  status(): PhonePushState {
    if (!this.options.enabled()) return "off";
    return this.options.access() ? "on" : "no-account";
  }

  private publicDevice(key: string): PublicPushDevice | null {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return null;
    return { platform: device.platform, environment: device.environment, ...(device.pairing ? { pairing: device.pairing } : {}), kinds: [...device.kinds], updatedAt: device.updatedAt };
  }

  /** The device token a phone registered, for the Live Activity and ongoing-notification pushes that share its relay. */
  deviceOf(key: string): { platform: "apns" | "fcm"; token: string; environment: "production" | "sandbox" } | undefined {
    const device = this.devices.find((candidate) => candidate.key === key);
    return device ? { platform: device.platform, token: device.token, environment: device.environment } : undefined;
  }

  isLive(key: string): boolean {
    return this.options.live(key);
  }

  /** One relay call, as this server's installation; null when the relay could not be reached or there is no account. */
  call(path: string, body: unknown): Promise<RelayAnswer | null> {
    return this.relay(path, body);
  }

  answer(key: string): PhonePushAnswer {
    return { push: this.status(), device: this.publicDevice(key) };
  }

  /** The phone behind `key` registers or updates its token. Switched off, nothing is kept. A token belongs to one app on
   * one phone, so the same token under another key (a phone that paired again) moves to this key. */
  async register(key: string, input: PhonePushRegistration): Promise<PhonePushAnswer & { relay: "registered" | "pending" | "off" }> {
    if (!PUSH_DEVICE_KEY.test(key)) throw new Error("not a phone");
    if (!this.options.enabled()) return { ...this.answer(key), relay: "off" };
    const now = this.now();
    const previous = this.devices.find((device) => device.key === key);
    const others = this.devices.filter((device) => device.key !== key && device.token !== input.token);
    if (!previous && others.length >= MAX_PUSH_DEVICES) {
      throw Object.assign(new Error(`At most ${MAX_PUSH_DEVICES} phones can get alerts from this computer.`), { status: 409 });
    }
    const next: StoredDevice = {
      key,
      platform: input.platform,
      token: input.token,
      environment: input.platform === "apns" ? input.environment ?? "production" : "production",
      ...(input.pairing ? { pairing: input.pairing } : {}),
      kinds: [...new Set(input.kinds ?? PUSH_KINDS)],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.devices = [...others, next];
    this.persist();
    if (previous && previous.token !== next.token) this.dropFromRelay(previous);
    if (this.status() !== "on") return { ...this.answer(key), relay: "off" };
    const answer = await this.relay(PHONE_PUSH_RELAY_PATHS.register, this.registerBody(next));
    return { ...this.answer(key), relay: answer && answer.status < 300 ? "registered" : "pending" };
  }

  /** The phone asked to stop, or was unpaired: drop it here and at the relay. */
  async remove(key: string): Promise<boolean> {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return false;
    this.devices = this.devices.filter((candidate) => candidate.key !== key);
    this.persist();
    for (const [slot, job] of this.outbox) if (job.key === key) this.outbox.delete(slot);
    await this.dropFromRelay(device);
    return true;
  }

  /** A paired phone was revoked or its session expired. */
  forget(key: string): void {
    void this.remove(key).catch((error) => this.log(`[phone-push] could not forget a phone: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async dropFromRelay(device: StoredDevice): Promise<void> {
    if (this.devices.some((other) => other.token === device.token)) return;
    await this.relay(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, platform: device.platform, token: device.token });
  }

  private registerBody(device: StoredDevice) {
    return device.platform === "apns"
      ? { v: PHONE_PUSH_WIRE_VERSION, platform: "apns", token: device.token, environment: device.environment }
      : { v: PHONE_PUSH_WIRE_VERSION, platform: "fcm", token: device.token };
  }

  /**
   * A `notify` frame left this server as frame `seq`. Each registered phone that holds no live stream, wants this kind
   * and would have been shown the frame (`reaches`, the event stream's own audience rule) gets a push queued. Never
   * throws, and does nothing at all while switched off.
   */
  offer(frame: { notification: unknown; seq: number }, reaches: (key: string) => boolean): void {
    try {
      if (!this.devices.length || !this.options.enabled()) return;
      const notification = pushableOf(frame.notification);
      if (!notification || !isPushKind(notification.kind)) return;
      const push = phonePushNotification(notification, this.options.room(notification));
      if (!push) return;
      const collapseId = phonePushCollapseId(push.threadId, frame.seq);
      const now = this.now();
      for (const device of this.devices) {
        if (!device.kinds.includes(notification.kind) || this.options.live(device.key) || !reaches(device.key)) continue;
        const slot = `${device.key}|${push.kind}|${push.threadId}`;
        const waiting = this.outbox.get(slot);
        if (!waiting && now - (this.lastBySlot.get(slot) ?? -Infinity) < PUSH_COALESCE_MS) continue;
        this.outbox.set(slot, { key: device.key, slot, push, ...(collapseId ? { collapseId } : {}), queuedAt: now, notBefore: waiting?.notBefore ?? now, attempts: waiting?.attempts ?? 0 });
      }
      this.kick();
    } catch (error) {
      this.log(`[phone-push] could not queue a push: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Resolves once every push that is due has been tried. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Pushes waiting for a retry or the relay's pause. */
  pending(): number {
    return this.outbox.size;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (!this.outbox.size) return;
    const due = Math.max(this.pausedUntil, Math.min(...[...this.outbox.values()].map((job) => job.notBefore)));
    if (due <= this.now()) {
      this.kick();
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.kick();
    }, Math.max(due - this.now(), 0));
  }

  private async drain(): Promise<void> {
    for (;;) {
      const now = this.now();
      if (now < this.pausedUntil) return;
      const job = [...this.outbox.values()].find((candidate) => candidate.notBefore <= now);
      if (!job) return;
      this.outbox.delete(job.slot);
      const outcome = await this.attempt(job, now).catch((error: unknown) => {
        this.log(`[phone-push] could not push: ${error instanceof Error ? error.message : String(error)}`);
        return "failed" as const;
      });
      if (outcome === "retry") {
        const wait = PUSH_RETRY_MS[job.attempts];
        if (wait !== undefined && !this.outbox.has(job.slot)) this.outbox.set(job.slot, { ...job, attempts: job.attempts + 1, notBefore: this.now() + wait });
      }
      if (outcome === "paused") this.outbox.clear();
    }
  }

  private async attempt(job: Job, now: number): Promise<PushOutcome> {
    const device = this.devices.find((candidate) => candidate.key === job.key);
    if (!device || !this.options.enabled()) return "gone";
    if (now - job.queuedAt > PUSH_MAX_AGE_MS) return "stale";
    // The phone connected while this waited: its stream delivers the frame itself.
    if (this.options.live(job.key)) return "live";
    const recent = (this.sent.get(job.key) ?? []).filter((at) => now - at < PUSH_DEVICE_WINDOW_MS);
    if (recent.length >= PUSH_DEVICE_WINDOW_MAX) return "dropped";
    const body = { v: PHONE_PUSH_WIRE_VERSION, token: device.token, ...(device.pairing ? { pairing: device.pairing } : {}), ...(job.collapseId ? { collapseId: job.collapseId } : {}), notification: job.push };
    let answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    if (answer?.status === 404 && answer.code === PUSH_RELAY_ERRORS.unknownDevice) {
      const registered = await this.relay(PHONE_PUSH_RELAY_PATHS.register, this.registerBody(device));
      if (registered && registered.status < 300) answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    }
    if (!answer) return "retry";
    if (answer.status < 300) {
      this.sent.set(job.key, [...recent, now]);
      this.lastBySlot.set(job.slot, now);
      if (this.lastBySlot.size > 2_000) this.lastBySlot.clear();
      return "sent";
    }
    if (answer.status === 410 || answer.code === PUSH_RELAY_ERRORS.unregistered) {
      this.devices = this.devices.filter((candidate) => candidate.token !== device.token);
      this.persist();
      return "gone";
    }
    if (answer.code === PUSH_RELAY_ERRORS.unavailable || answer.status === 401 || answer.status === 404) return this.pause(RELAY_UNAVAILABLE_PAUSE_MS);
    if (answer.status === 429) return this.pause(answer.retryAfterMs ?? 60_000);
    if (answer.status >= 500) return "retry";
    return "failed";
  }

  private pause(ms: number): PushOutcome {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(Math.max(ms, 1_000), 6 * 60 * 60_000));
    return "paused";
  }

  /** One POST to the relay; null when it could not be reached. The credential travels only in the Authorization header,
   * to the control plane's own origin, and is never logged. */
  private async relay(path: string, body: unknown): Promise<RelayAnswer | null> {
    const access = this.options.access();
    if (!access) return null;
    try {
      const response = await this.fetchImpl(`${access.controlPlane}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${access.credential}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        status: response.status,
        ...(typeof payload?.error === "string" ? { code: payload.error } : {}),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
      };
    } catch (error) {
      this.log(`[phone-push] the relay could not be reached: ${error instanceof Error ? error.name : "error"}`);
      return null;
    }
  }
}

/** A validated access pair, or null. */
export function phonePushAccess(controlPlane: unknown, credential: unknown): PhonePushAccess | null {
  const origin = typeof controlPlane === "string" ? normalizeControlPlaneURL(controlPlane) : "";
  if (!origin || typeof credential !== "string" || !INSTALLATION_CREDENTIAL.test(credential)) return null;
  return { controlPlane: origin, credential };
}

/** Where this server's control-plane access comes from, first match wins: the desktop app's private message (its
 * credential lives in the OS store this process cannot read), OMB_PUSH_CREDENTIAL, a fleet's
 * OMB_INSTALLATION_CREDENTIAL, `openmausbot login`'s tunnel-account.json. OMB_CONTROL_PLANE_URL overrides the origin. */
export class PhonePushAccessSource {
  private desktop: PhonePushAccess | null | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly options: { tunnelFile: string; defaultControlPlane: string };

  constructor(options: { env?: NodeJS.ProcessEnv; tunnelFile: string; defaultControlPlane: string }) {
    this.env = options.env ?? process.env;
    this.options = options;
  }

  /** The desktop app's message: true when it was one. */
  receive(message: unknown): boolean {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== PHONE_PUSH_DESKTOP_MESSAGE) return false;
    const access = (message as { access?: unknown }).access;
    this.desktop = access && typeof access === "object"
      ? phonePushAccess((access as { controlPlane?: unknown }).controlPlane, (access as { credential?: unknown }).credential)
      : null;
    return true;
  }

  private controlPlane(): string {
    if (Object.hasOwn(this.env, "OMB_CONTROL_PLANE_URL")) return normalizeControlPlaneURL(this.env.OMB_CONTROL_PLANE_URL ?? "");
    return this.options.defaultControlPlane;
  }

  current(): PhonePushAccess | null {
    if (this.desktop !== undefined) return this.desktop;
    const fromEnv = this.env[PHONE_PUSH_CREDENTIAL_ENV]?.trim() || this.env.OMB_INSTALLATION_CREDENTIAL?.trim();
    if (fromEnv) return phonePushAccess(this.controlPlane(), fromEnv);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.options.tunnelFile, "utf8"));
    } catch {
      return null;
    }
    const credential = document && typeof document === "object" ? (document as Record<string, unknown>)[COMPANION_INSTALLATION_CREDENTIAL_FIELD] : undefined;
    return phonePushAccess(this.controlPlane(), credential);
  }
}
