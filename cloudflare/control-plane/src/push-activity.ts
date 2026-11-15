// A bot's Live Activity on iPhone (APNs `liveactivity`) and its ongoing "working" notification on Android (an FCM data
// message), started, updated and ended by push while the phone app is closed. Names, kind and a headline only: never
// message text, never an answer link.
import { z } from "zod";

import { errorResponse } from "./http";
import { FCM_TTL } from "./push-fcm";
import { sendToRegistered, type PlannedDelivery } from "./push";

/** The phone app's Live Activity, as expo-widgets (SDK 58) registers it: its name, and its ActivityAttributes type. */
export const LIVE_ACTIVITY_NAME = "BotActivity";
export const LIVE_ACTIVITY_ATTRIBUTES = "LiveActivityAttributes";
/** How long an activity is shown as current without news; the phone app's own freshness window. */
export const ACTIVITY_STALE_SECONDS = 15 * 60;
const ACTIVITY_EXPIRATION_SECONDS = 15 * 60;

const TOKEN = /^[A-Za-z0-9_:-]{64,4096}$/;
const ID = /^[\w-]{1,120}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const BODY = /^[a-z][a-z0-9-]{0,39}$/;
/** A chat link in any of the app's schemes. */
const LINK = /^openmausbot(?:-dev|-next)?:\/\/chat\/[A-Za-z0-9%_.-]{1,360}$/;

function oneLine(max: number) {
  return z.string().min(1).max(max * 4).refine((value) => {
    if (value.trim() !== value || [...value].length > max) return false;
    return !/[\p{Cc}\u2028\u2029]/u.test(value);
  });
}

const activitySchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(TOKEN),
  event: z.enum(["start", "update", "end"]),
  /** A push-to-start only: ActivityKit starts an activity remotely only with an alert, and an alerting update or end
   * would light the screen and expand the Dynamic Island. Refused anywhere else. */
  alert: z.boolean().optional(),
  activity: z.strictObject({
    /** Content state version 1 (the phone app's `BotActivityProps`): with `ask`, `status` and `waiting`. */
    version: z.literal(1).optional(),
    ask: z.enum(["approval", "question", "signIn", "other"]).optional(),
    /** The status line in the phone's words, without the name ("Needs your approval"). */
    status: oneLine(80).optional(),
    /** How many bots wait on the person now. */
    waiting: z.number().int().min(0).max(999).optional(),
    botId: z.string().regex(ID),
    botName: oneLine(80),
    kind: z.enum(["needsYou", "working"]),
    /** "Scout needs you", in the phone's language: the phone registered the words, the server filled the name. */
    headline: oneLine(120),
    /** When the current kind began (epoch ms). */
    since: z.number().int().nonnegative().max(8.64e15),
    link: z.string().regex(LINK),
    color: z.string().regex(HEX),
    gradient: z.array(z.string().regex(HEX)).min(1).max(4),
    body: z.string().regex(BODY),
  }),
}).refine((request) => !request.alert || request.event === "start")
  .refine(({ activity }) => activity.version === undefined
    ? activity.ask === undefined && activity.status === undefined && activity.waiting === undefined
    : activity.ask !== undefined && activity.status !== undefined && activity.waiting !== undefined);
export type ActivitySendRequest = z.infer<typeof activitySchema>;

/** The phone app's `BotActivityProps` for a pushed state, version 1 or the earlier shape: no message text, no answers. */
export function activityProps(activity: ActivitySendRequest["activity"]) {
  if (activity.version === 1) {
    return {
      version: 1,
      botId: activity.botId,
      name: activity.botName,
      color: activity.color,
      body: activity.body,
      mood: activity.kind,
      kind: activity.kind,
      ask: activity.ask,
      status: activity.status,
      waiting: activity.waiting,
      since: activity.since,
      link: activity.link,
      answers: [],
    };
  }
  return {
    botId: activity.botId,
    name: activity.botName,
    color: activity.color,
    gradient: activity.gradient,
    body: activity.body,
    mood: activity.kind,
    kind: activity.kind,
    headline: activity.headline,
    line: "",
    since: activity.since,
    link: activity.link,
    answers: [],
  };
}

export function liveActivityPayload(request: ActivitySendRequest, now: number) {
  const seconds = Math.floor(now / 1_000);
  const contentState = { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(activityProps(request.activity)) };
  return {
    aps: {
      timestamp: seconds,
      event: request.event,
      "content-state": contentState,
      ...(request.event === "end" ? { "dismissal-date": seconds } : { "stale-date": seconds + ACTIVITY_STALE_SECONDS }),
      ...(request.event === "start" ? { "attributes-type": LIVE_ACTIVITY_ATTRIBUTES, attributes: { url: request.activity.link } } : {}),
      // The minimal alert ActivityKit needs to start an activity remotely: names and kind only.
      ...(request.event === "start" ? { alert: { title: request.activity.headline, body: request.activity.botName, sound: "default" } } : {}),
    },
  };
}

/** A data message the phone's own messaging service turns into its ongoing notification (`omb_kind: activity`). */
export function activityFcmPayload(request: ActivitySendRequest, now: number) {
  const { activity } = request;
  return {
    message: {
      token: request.token,
      data: {
        omb_kind: "activity",
        event: request.event,
        bot_id: activity.botId,
        bot_name: activity.botName,
        kind: activity.kind,
        headline: activity.headline,
        since: String(activity.since),
        link: activity.link,
        sent_at: String(now),
      },
      android: { priority: activity.kind === "needsYou" || request.event === "end" ? "HIGH" : "NORMAL", ttl: FCM_TTL },
    },
  };
}

export async function sendActivityPush(request: Request, env: Env, pushFetch: typeof fetch, requestId: string): Promise<Response> {
  return sendToRegistered(request, env, pushFetch, requestId, activitySchema, async (body, row, config, now): Promise<PlannedDelivery | Response> => {
    if (row.platform === "fcm") {
      if (!config.fcm) return errorResponse(503, "push_unavailable");
      return { kind: "fcm", config: config.fcm, payload: activityFcmPayload(body, now) };
    }
    // A start goes to the push-to-start token only, an update or an end to that activity's own token only.
    const wanted = body.event === "start" ? "activity-start" : "activity";
    if (row.purpose !== wanted) return errorResponse(404, "push_device_unknown");
    if (!config.apns) return errorResponse(503, "push_unavailable");
    const priority = body.event === "start" ? 10 : 5;
    return { kind: "apns", config: config.apns, pushType: "liveactivity", priority, expiresInSeconds: ACTIVITY_EXPIRATION_SECONDS, payload: liveActivityPayload(body, now) };
  });
}
