/** Closed-app phone alerts, version 1: what a paired phone sends its computer or Cloud, what that server sends the push
 * relay in the hosted control plane (cloudflare/control-plane), and what the phone receives from Apple or Google.
 *
 * A push is content-free by construction: the alert's kind, a title built from the bot's and room's names, opaque ids
 * and the phone's own tag for the computer. Never message text, a reply, a file path or a secret. The phone fetches the
 * content from its computer when it opens. */

export const PHONE_PUSH_WIRE_VERSION = 1 as const;

/** The phone's own route on its computer or Cloud: `PUT` registers or updates, `GET` reads back, `DELETE` removes. Keyed
 * by what authenticated the request (a paired session, or the device the companion vouched for), never by the body. */
export const PHONE_PUSH_ROUTE = "/api/push/device";

/** The relay's paths, under the control plane's origin. Each takes `Authorization: Bearer <omb_install_…>`. */
export const PHONE_PUSH_RELAY_PATHS = {
  register: "/v1/installations/self/push/register",
  unregister: "/v1/installations/self/push/unregister",
  send: "/v1/installations/self/push/send",
} as const;

export const PUSH_PLATFORMS = ["apns", "fcm"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];
export type ApnsEnvironment = "production" | "sandbox";

/** An APNs device token as the phone hands it over: lowercase hex. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
/** An FCM registration token. */
export const FCM_TOKEN = /^[A-Za-z0-9_:-]{64,4096}$/;
/** The phone's opaque tag for one saved computer, echoed in every push so a tap opens the right one. */
export const PAIRING_TAG = /^[A-Za-z0-9_-]{8,64}$/;
/** The notification identifier a push carries: at most 64 bytes, APNs' limit for `apns-collapse-id`. */
export const PUSH_COLLAPSE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const PUSH_ID = /^[\w-]{1,120}$/;
export const PUSH_NAME_MAX = 80;
export const PUSH_TITLE_MAX = 200;

/** The kinds a closed app is woken for: a bot waits on the person (approval, question, sign-in), or a reply is ready.
 * Everything else reaches the phone only while it is connected. */
export const PUSH_KINDS = ["approval", "question", "sign-in", "done"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** `PUT /api/push/device`, from the phone. */
export interface PhonePushRegistration {
  platform: PushPlatform;
  token: string;
  /** APNs only: `sandbox` for a development build. */
  environment?: ApnsEnvironment;
  pairing?: string;
  /** The kinds this phone wants pushed, from its own notification switches. Absent: all of `PUSH_KINDS`. Empty: none,
   * the registration is kept. */
  kinds?: PushKind[];
}

/** Whether pushes can leave this server at all: `off` until the owner switches phone push on, `no-account` while it
 * holds no installation credential to reach the relay with. */
export type PhonePushState = "on" | "off" | "no-account";

/** A registration as the phone may read it back: never the token, never another phone's. */
export interface PublicPushDevice {
  platform: PushPlatform;
  environment: ApnsEnvironment;
  pairing?: string;
  kinds: PushKind[];
  updatedAt: number;
}

/** What every `/api/push/device` answer carries. */
export interface PhonePushAnswer {
  push: PhonePushState;
  device: PublicPushDevice | null;
}

/** What the push carries beside its title. */
export interface PhonePushNotification {
  kind: string;
  title: string;
  botId: string;
  botName: string;
  threadId: string;
  roomId?: string;
  roomName?: string;
}

export interface PushRelaySendRequest {
  v: typeof PHONE_PUSH_WIRE_VERSION;
  token: string;
  pairing?: string;
  collapseId?: string;
  notification: PhonePushNotification;
}

/** The data the phone app reads from a push: `body` on both platforms (APNs custom key, FCM data as JSON). */
export interface PhonePushData {
  v: typeof PHONE_PUSH_WIRE_VERSION;
  kind: string;
  botId: string;
  botName: string;
  threadId: string;
  roomId?: string;
  roomName?: string;
  pairing?: string;
}

/** The relay's error codes a server acts on. Anything else is transient. */
export const PUSH_RELAY_ERRORS = {
  unknownDevice: "push_device_unknown",
  unregistered: "push_device_unregistered",
  unavailable: "push_unavailable",
} as const;

/** `openmaus.<threadId>.<seq>`, the identifier the phone gives the notification the live stream would post for the
 * same frame, so a push and that notification replace each other. Undefined when it would not fit. */
export function phonePushCollapseId(threadId: string, seq: number): string | undefined {
  const id = `openmaus.${threadId}.${seq}`;
  return Number.isSafeInteger(seq) && seq >= 0 && PUSH_COLLAPSE_ID.test(id) ? id : undefined;
}

export function isPushKind(kind: string): kind is PushKind {
  return (PUSH_KINDS as readonly string[]).includes(kind);
}

export function validPushToken(platform: PushPlatform, token: string): boolean {
  return platform === "apns" ? APNS_TOKEN.test(token) : FCM_TOKEN.test(token);
}

/** The phone's Live Activity and ongoing-notification registration on its computer or Cloud: `PUT` replaces it whole,
 * `GET` reads it back, `DELETE` removes it. Keyed like `PHONE_PUSH_ROUTE`. */
export const PHONE_ACTIVITY_ROUTE = "/api/push/activity";
export const PHONE_ACTIVITY_RELAY_PATH = "/v1/installations/self/push/activity";

/** What a bot's activity shows: it needs the person, or it is working. */
export type ActivityKind = "needsYou" | "working";
/** What a bot that needs the person waits for, as the phone's content state version 1 names it. */
export type ActivityAsk = "approval" | "question" | "signIn" | "other";
export const ACTIVITY_ASKS: readonly ActivityAsk[] = ["approval", "question", "signIn", "other"];

/** The phone's words for an activity's status line in content state version 1 ("Working", "Needs your approval"):
 * no name, it sits under the bot's name. */
export interface ActivityStatuses {
  working: string;
  needsYou: Record<ActivityAsk, string>;
}
export type ActivityEvent = "start" | "update" | "end";

/** How the phone draws a bot: its colour, body gradient and mascot body, as its own widgets do. */
export interface ActivityVisual {
  color: string;
  gradient: string[];
  body: string;
}

/** `PUT /api/push/activity`, from the phone. */
export interface PhoneActivityRegistration {
  /** The app's URL scheme, for the chat link a pushed activity opens. */
  scheme: "openmausbot" | "openmausbot-dev" | "openmausbot-next";
  /** The phone's own words, with `{name}` where the bot's name goes: "{name} needs you", "{name} is working". */
  headlines: Record<ActivityKind, string>;
  /** iOS: the app's Live Activity push-to-start token (hex). */
  startToken?: string;
  /** iOS: each running Live Activity's own update token (hex), by bot. */
  activities?: Array<{ botId: string; token: string }>;
  /** iOS: how each bot the phone knows is drawn, so a pushed activity looks like the app's own. */
  visuals?: Record<string, ActivityVisual>;
  fallbackVisual?: ActivityVisual;
  /** Android: send the device's FCM token the ongoing "working" notification's data messages. */
  ongoing?: boolean;
  /** Which kinds the phone wants, from its Settings switches. Absent: both. */
  kinds?: ActivityKind[];
  /** The status words for content state version 1. A phone that registers them draws version 1, and a pushed
   * activity is sent in it; without them the earlier shape (`headline`) is sent. */
  statuses?: ActivityStatuses;
}

/** What the server sends the relay for one activity change. */
export interface PushRelayActivityRequest {
  v: typeof PHONE_PUSH_WIRE_VERSION;
  token: string;
  event: ActivityEvent;
  /** A push-to-start `start` only, where ActivityKit requires one. An update or an end never alerts: an alerting
   * update lights the screen and expands the Dynamic Island. */
  alert?: boolean;
  activity: {
    botId: string;
    botName: string;
    kind: ActivityKind;
    headline: string;
    since: number;
    link: string;
    /** Content state version 1, for a phone that registered `statuses`: all four, or none. */
    version?: 1;
    ask?: ActivityAsk;
    status?: string;
    waiting?: number;
  } & ActivityVisual;
}
