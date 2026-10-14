// iOS suspends a backgrounded app within seconds, so its event stream stops; this sends the alert as an APNs push instead.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { COMPANION_INSTALLATION_CREDENTIAL_FIELD } from "../electron/companion-account-service.mjs";
import { normalizeControlPlaneURL } from "../electron/control-plane-client.mjs";
import {
  APNS_TOKEN,
  PAIRING_TAG,
  PHONE_PUSH_RELAY_PATHS,
  PHONE_PUSH_WIRE_VERSION,
  PUSH_RELAY_ERRORS,
  phonePushNotification,
  type ApnsEnvironment,
  type PhonePushDeviceRegistration,
  type PhonePushNotification,
} from "../shared/phone-push.ts";
import type { Notification } from "../shared/notification.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { AppConfig } from "./config.ts";

export function phonePushEnabled(cfg: AppConfig): boolean {
  return cfg.features?.phonePush !== false;
}

export interface PhonePushAccess {
  controlPlane: string;
  credential: string;
}

export const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
export const PUSH_DEVICE_KEY = /^(companion|session):[\w-]{1,128}$/;

export const PUSH_COALESCE_MS = 10_000;
export const PUSH_DEVICE_WINDOW_MS = 10 * 60_000;
export const PUSH_DEVICE_WINDOW_MAX = 30;
export const RELAY_UNAVAILABLE_PAUSE_MS = 60 * 60_000;
export const RELAY_FAILURE_PAUSE_MS = 60_000;
const RELAY_TIMEOUT_MS = 10_000;
export const MAX_PUSH_DEVICES = 50;

const storedDevice = z.object({
  key: z.string().regex(PUSH_DEVICE_KEY),
  token: z.string().regex(APNS_TOKEN),
  environment: z.enum(["production", "sandbox"]),
  pairing: z.string().regex(PAIRING_TAG).optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const storedFile = z.object({ version: z.literal(1), devices: z.array(storedDevice) });
type StoredDevice = z.infer<typeof storedDevice>;

export interface PublicPushDevice {
  environment: ApnsEnvironment;
  enabled: boolean;
  pairing?: string;
  updatedAt: number;
}

export const registrationSchema = z.object({
  token: z.string().trim().toLowerCase().regex(APNS_TOKEN),
  environment: z.enum(["production", "sandbox"]),
  pairing: z.string().regex(PAIRING_TAG).optional(),
  enabled: z.boolean().optional(),
}).strict();

export type PushOutcome =
  | "sent"
  | "off"
  | "opted-out"
  | "not-visible"
  | "live"
  | "coalesced"
  | "rate-limited"
  | "paused"
  | "dropped"
  | "failed";

export interface PhonePushOptions {
  file: string;
  access: () => PhonePushAccess | null;
  enabled: () => boolean;
  live: (key: string) => boolean;
  audience: (key: string, notification: Notification, adminOnly: boolean) => boolean;
  room: (notification: Notification) => { id: string; name: string } | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

interface RelayAnswer {
  status: number;
  code?: string;
  retryAfterMs?: number;
}

export class PhonePush {
  private devices: StoredDevice[] = [];
  private readonly options: PhonePushOptions;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly sent = new Map<string, number[]>();
  private readonly lastByThread = new Map<string, number>();
  private pausedUntil = 0;

  constructor(options: PhonePushOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
    this.load();
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.options.file, "utf8"));
    } catch {
      return;
    }
    const parsed = storedFile.safeParse(raw);
    if (parsed.success) this.devices = parsed.data.devices;
  }

  private persist(): void {
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
  }

  device(key: string): PublicPushDevice | null {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return null;
    return {
      environment: device.environment,
      enabled: device.enabled,
      ...(device.pairing ? { pairing: device.pairing } : {}),
      updatedAt: device.updatedAt,
    };
  }

  status(): "on" | "off" | "no-account" {
    if (!this.options.enabled()) return "off";
    return this.options.access() ? "on" : "no-account";
  }

  /** A token belongs to one app on one phone: the newest key to register it owns it. */
  async register(key: string, input: PhonePushDeviceRegistration): Promise<{ device: PublicPushDevice; relay: "registered" | "pending" | "off" }> {
    if (!PUSH_DEVICE_KEY.test(key)) throw new Error("not a phone");
    const now = this.now();
    const previous = this.devices.find((device) => device.key === key);
    const others = this.devices.filter((device) => device.key !== key && device.token !== input.token);
    if (!previous && others.length >= MAX_PUSH_DEVICES) {
      throw Object.assign(new Error(`At most ${MAX_PUSH_DEVICES} phones can receive alerts from this computer.`), { status: 409 });
    }
    const next: StoredDevice = {
      key,
      token: input.token,
      environment: input.environment,
      ...(input.pairing ? { pairing: input.pairing } : {}),
      enabled: input.enabled ?? previous?.enabled ?? true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.devices = [...others, next];
    this.persist();
    if (previous && previous.token !== next.token && !this.tokenInUse(previous.token)) {
      void this.relay(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, token: previous.token });
    }
    if (this.status() !== "on") return { device: this.device(key)!, relay: "off" };
    const answer = await this.relay(PHONE_PUSH_RELAY_PATHS.register, {
      v: PHONE_PUSH_WIRE_VERSION,
      token: next.token,
      environment: next.environment,
    });
    return { device: this.device(key)!, relay: answer && answer.status < 300 ? "registered" : "pending" };
  }

  async remove(key: string): Promise<boolean> {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return false;
    this.devices = this.devices.filter((candidate) => candidate.key !== key);
    this.persist();
    if (!this.tokenInUse(device.token)) {
      await this.relay(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, token: device.token });
    }
    return true;
  }

  forget(key: string): void {
    void this.remove(key).catch((error) => this.log(`[phone-push] could not forget a phone: ${error instanceof Error ? error.message : String(error)}`));
  }

  private tokenInUse(token: string): boolean {
    return this.devices.some((device) => device.token === token);
  }

  /** Never rejects. */
  async dispatch(notification: Notification, options: { adminOnly?: boolean } = {}): Promise<Array<{ key: string; outcome: PushOutcome }>> {
    try {
      if (!this.devices.length) return [];
      if (this.status() !== "on") return this.devices.map((device) => ({ key: device.key, outcome: "off" as const }));
      const push = phonePushNotification(notification, this.options.room(notification));
      if (!push) return [];
      const now = this.now();
      return await Promise.all(this.devices.map(async (device) => {
        let outcome: PushOutcome;
        try {
          outcome = await this.deliver(device, push, notification, options.adminOnly === true, now);
        } catch (error) {
          this.log(`[phone-push] could not push: ${error instanceof Error ? error.message : String(error)}`);
          outcome = "failed";
        }
        return { key: device.key, outcome };
      }));
    } catch (error) {
      this.log(`[phone-push] could not push: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async deliver(device: StoredDevice, push: PhonePushNotification, notification: Notification, adminOnly: boolean, now: number): Promise<PushOutcome> {
    if (!device.enabled) return "opted-out";
    if (!this.options.audience(device.key, notification, adminOnly)) return "not-visible";
    if (this.options.live(device.key)) return "live";
    if (now < this.pausedUntil) return "paused";
    const threadKey = `${device.key}|${push.kind}|${push.threadId}`;
    if (now - (this.lastByThread.get(threadKey) ?? -Infinity) < PUSH_COALESCE_MS) return "coalesced";
    const recent = (this.sent.get(device.key) ?? []).filter((at) => now - at < PUSH_DEVICE_WINDOW_MS);
    if (recent.length >= PUSH_DEVICE_WINDOW_MAX) return "rate-limited";
    this.sent.set(device.key, [...recent, now]);
    this.lastByThread.set(threadKey, now);
    if (this.lastByThread.size > 2_000) this.lastByThread.clear();
    return this.send(device, push);
  }

  private async send(device: StoredDevice, notification: PhonePushNotification): Promise<PushOutcome> {
    const body = {
      v: PHONE_PUSH_WIRE_VERSION,
      token: device.token,
      ...(device.pairing ? { pairing: device.pairing } : {}),
      notification,
    };
    let answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    if (answer?.status === 404 && answer.code === PUSH_RELAY_ERRORS.unknownDevice) {
      const registered = await this.relay(PHONE_PUSH_RELAY_PATHS.register, {
        v: PHONE_PUSH_WIRE_VERSION,
        token: device.token,
        environment: device.environment,
      });
      if (registered && registered.status < 300) answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    }
    if (!answer) return this.pause(RELAY_FAILURE_PAUSE_MS, "failed");
    if (answer.status < 300) return "sent";
    if (answer.status === 410 || answer.code === PUSH_RELAY_ERRORS.unregistered) {
      this.devices = this.devices.filter((candidate) => candidate.token !== device.token);
      this.persist();
      return "dropped";
    }
    if (answer.code === PUSH_RELAY_ERRORS.unavailable) return this.pause(RELAY_UNAVAILABLE_PAUSE_MS, "failed");
    if (answer.status === 429) return this.pause(answer.retryAfterMs ?? RELAY_FAILURE_PAUSE_MS, "rate-limited");
    if (answer.status === 401) return this.pause(RELAY_UNAVAILABLE_PAUSE_MS, "failed");
    if (answer.status === 404 && answer.code !== PUSH_RELAY_ERRORS.unknownDevice) return this.pause(RELAY_UNAVAILABLE_PAUSE_MS, "failed");
    if (answer.status >= 500) return this.pause(RELAY_FAILURE_PAUSE_MS, "failed");
    return "failed";
  }

  private pause(ms: number, outcome: PushOutcome): PushOutcome {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(Math.max(ms, 1_000), 6 * 60 * 60_000));
    return outcome;
  }

  /** The credential travels only in the Authorization header, to the control plane's own origin, and is never logged. */
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

export const PHONE_PUSH_DESKTOP_MESSAGE = "openmausbot:phone-push-relay";

export function phonePushAccess(controlPlane: unknown, credential: unknown): PhonePushAccess | null {
  const origin = typeof controlPlane === "string" ? normalizeControlPlaneURL(controlPlane) : "";
  if (!origin || typeof credential !== "string" || !INSTALLATION_CREDENTIAL.test(credential)) return null;
  return { controlPlane: origin, credential };
}

export class PhonePushAccessSource {
  private desktop: PhonePushAccess | null | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tunnelFile: string;
  private readonly defaultControlPlane: string;

  constructor(options: { env?: NodeJS.ProcessEnv; tunnelFile: string; defaultControlPlane: string }) {
    this.env = options.env ?? process.env;
    this.tunnelFile = options.tunnelFile;
    this.defaultControlPlane = options.defaultControlPlane;
  }

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
    return this.defaultControlPlane;
  }

  current(): PhonePushAccess | null {
    // The desktop app is authoritative once it has spoken, including "none".
    if (this.desktop !== undefined) return this.desktop;
    const fleet = this.env.OMB_INSTALLATION_CREDENTIAL?.trim();
    if (fleet) return phonePushAccess(this.controlPlane(), fleet);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.tunnelFile, "utf8"));
    } catch {
      return null;
    }
    const credential = document && typeof document === "object" ? (document as Record<string, unknown>)[COMPANION_INSTALLATION_CREDENTIAL_FIELD] : undefined;
    return phonePushAccess(this.controlPlane(), credential);
  }
}
