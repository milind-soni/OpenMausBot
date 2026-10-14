/** Harness ↔ push relay wire contract. A push carries the kind, names and opaque ids, never message text;
 * bump the version for anything a deployed relay or app could misread. */

export const PHONE_PUSH_WIRE_VERSION = 1 as const;

/** The relay's paths, under the control plane's origin. Each takes
 * `Authorization: Bearer <omb_install_…>`, the installation credential the
 * harness already holds for the hosted transport. */
export const PHONE_PUSH_RELAY_PATHS = {
  register: "/v1/installations/self/push/register",
  unregister: "/v1/installations/self/push/unregister",
  send: "/v1/installations/self/push/send",
} as const;

export type ApnsEnvironment = "production" | "sandbox";
export const APNS_ENVIRONMENTS: readonly ApnsEnvironment[] = ["production", "sandbox"];

/** Lowercase hex. APNs tokens are 32 bytes today; Apple reserves the right to grow them. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
/** Made up by the app per saved computer and echoed in every push, so a tap opens the right computer. */
export const PAIRING_TAG = /^[A-Za-z0-9_-]{8,64}$/;
export const PUSH_ID = /^[\w-]{1,120}$/;
/** A relay or app treats an unknown kind as a plain alert. */
export const PUSH_KIND = /^[a-z][a-z-]{0,39}$/;
export const PUSH_NAME_MAX = 80;
export const PUSH_TITLE_MAX = 200;

export interface PhonePushNotification {
  kind: string;
  title: string;
  botId: string;
  botName: string;
  threadId: string;
  roomId?: string;
  roomName?: string;
}

/** `PUT /api/push/device` body. */
export interface PhonePushDeviceRegistration {
  token: string;
  environment: ApnsEnvironment;
  pairing?: string;
  /** false keeps the registration and sends nothing. */
  enabled?: boolean;
}

export interface PushRelayDeviceRequest {
  v: typeof PHONE_PUSH_WIRE_VERSION;
  token: string;
  /** register only */
  environment?: ApnsEnvironment;
}

export interface PushRelaySendRequest {
  v: typeof PHONE_PUSH_WIRE_VERSION;
  token: string;
  /** Echoed to the app as `omb.pairing`. */
  pairing?: string;
  notification: PhonePushNotification;
}

/** Anything else is transient. */
export const PUSH_RELAY_ERRORS = {
  /** Register again, then retry once. */
  unknownDevice: "push_device_unknown",
  /** APNs says the token is dead; the relay already dropped it. */
  unregistered: "push_device_unregistered",
  /** The relay has no APNs key configured. */
  unavailable: "push_unavailable",
} as const;

/** The relay marks these time-sensitive. */
export const NEEDS_YOU_KINDS: ReadonlySet<string> = new Set(["approval", "question", "sign-in", "mention"]);

/** From names alone: unlike buildNotification, a sign-in leaves out the website and a spend notice its amounts. */
export function phonePushTitle(kind: string, botName: string, roomName?: string): string {
  const who = roomName ? `${botName} in ${roomName}` : botName;
  const title = (() => {
    switch (kind) {
      case "approval": return `${who} needs approval`;
      case "question": return `${who} has a question`;
      case "sign-in": return `${who} needs you to sign in`;
      case "mention": return `${who} mentioned you`;
      case "routine-failed": return `${who}'s routine failed`;
      case "routine-deferred": return `${who}'s routine is waiting`;
      case "turn-failed": return `${who} couldn't start`;
      case "incident": return `${who} hit a problem`;
      case "delegation-settled": return `${who} resumed with results`;
      case "done": return `${who} finished`;
      case "spend": return "Workspace spend notice";
      default: return `${who} needs you`;
    }
  })();
  return clip(title, PUSH_TITLE_MAX);
}

function clip(value: string, max: number): string {
  // Code points, not UTF-16 units, so a name is never cut inside an emoji.
  const points = [...value.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

/** Reads only the kind, ids and names; the notification's body never enters a push. */
export function phonePushNotification(
  notification: { kind: string; botId: string; botName: string; threadId: string },
  room?: { id: string; name: string },
): PhonePushNotification | null {
  if (!PUSH_KIND.test(notification.kind) || !PUSH_ID.test(notification.botId) || !PUSH_ID.test(notification.threadId)) return null;
  const botName = clip(notification.botName, PUSH_NAME_MAX) || "A bot";
  const roomName = room && PUSH_ID.test(room.id) ? clip(room.name, PUSH_NAME_MAX) : "";
  return {
    kind: notification.kind,
    title: phonePushTitle(notification.kind, botName, roomName || undefined),
    botId: notification.botId,
    botName,
    threadId: notification.threadId,
    ...(room && roomName ? { roomId: room.id, roomName } : {}),
  };
}
