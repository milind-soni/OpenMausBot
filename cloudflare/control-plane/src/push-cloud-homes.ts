// Phone push for Cloud homes (README "Phone push relay", "Cloud homes"; docs/phone-push.md "Cloud homes"). A Cloud home
// has no installation credential, so the Admin that runs it relays its push calls here: the same bodies as the
// installation routes, keyed by the home's machine id (in the path, never the body), authenticated by one secret only
// the Admin and this Worker hold. The Admin checks the home's own signature and derives the machine id from it; this
// Worker trusts the Admin for that, and bounds what a leaked secret could do with a fleet-wide limit.
import { timingSafeEqual } from "node:crypto";

import { errorResponse, HTTPError } from "./http";
import {
  MACHINE_PUSH_STORE,
  registerFor,
  sendAs,
  sendSchema,
  planAlert,
  unregisterFor,
  type DeviceRow,
  type PushLimit,
  type PushSender,
} from "./push";
import { activitySchema, planActivity } from "./push-activity";

/** `POST /v1/cloud-homes/<machine id>/push/<action>`. The machine id is the Admin's (`OMB_CLOUD_MACHINE_ID` on the home). */
export const CLOUD_HOME_PUSH_ROUTE = /^\/v1\/cloud-homes\/([A-Za-z0-9][A-Za-z0-9_-]{2,127})\/push\/(register|unregister|send|activity|forget)$/;
/** The Admin's secret, and the one before it while a rotation is under way. */
export const CLOUD_HOME_PUSH_SECRET_NAMES = ["CLOUD_HOME_PUSH_SECRET", "CLOUD_HOME_PUSH_SECRET_PREVIOUS"] as const;
const SECRET_MIN_LENGTH = 32;
/** The fleet's row in machine_push_rate_limits: no machine id can be `*`. */
export const FLEET_ID = "*";
/** Across every Cloud home in an hour. A leaked Admin secret can name any machine id, so the per-machine limits alone
 * would not bound it; these do. They sit well above what the fleet sends today (each home's own limits are 600 sends
 * and 120 registrations an hour) and are the owner's to change. */
export const CLOUD_HOME_FLEET_SEND_LIMIT = 20_000;
export const CLOUD_HOME_FLEET_REGISTER_LIMIT = 6_000;

const FLEET_SENDS: PushLimit = { owner: FLEET_ID, action: "push_send", limit: CLOUD_HOME_FLEET_SEND_LIMIT };
const FLEET_REGISTERS: PushLimit = { owner: FLEET_ID, action: "push_register", limit: CLOUD_HOME_FLEET_REGISTER_LIMIT };

export function cloudHomePushSecrets(env: Env): string[] {
  const vars = env as unknown as Partial<Record<string, unknown>>;
  return CLOUD_HOME_PUSH_SECRET_NAMES
    .map((name) => vars[name])
    .filter((value): value is string => typeof value === "string" && value.trim().length >= SECRET_MIN_LENGTH)
    .map((value) => value.trim());
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** The Admin's bearer, compared in constant time with each configured secret (every one is compared). No secret set:
 * `503 push_unavailable`, so the Admin and its homes back off; a wrong one: `401 unauthorized`. */
export async function requireCloudHomeRelay(request: Request, env: Env): Promise<void> {
  const secrets = cloudHomePushSecrets(env);
  if (!secrets.length) throw new HTTPError(503, "push_unavailable");
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? "";
  const given = await digest(bearer);
  let matched = false;
  for (const secret of secrets) matched = timingSafeEqual(given, await digest(secret)) || matched;
  if (!bearer || !matched) throw new HTTPError(401, "unauthorized");
}

function sender(request: Request, env: Env, machineId: string): PushSender {
  return {
    store: MACHINE_PUSH_STORE,
    fleet: [FLEET_SENDS],
    authenticate: async (read) => {
      await requireCloudHomeRelay(request, env);
      const row = read ? await read(machineId).first<DeviceRow>() : null;
      return { ownerId: machineId, row: row ?? null };
    },
  };
}

/** Every token and window of one machine: the Admin deleted or retired that Cloud. Idempotent. */
async function forget(env: Env, machineId: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM machine_push_devices WHERE machine_id = ?").bind(machineId),
    env.DB.prepare("DELETE FROM machine_push_rate_limits WHERE machine_id = ?").bind(machineId),
  ]);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function routeCloudHomePush(
  request: Request,
  env: Env,
  pushFetch: typeof fetch,
  requestId: string,
  machineId: string,
  action: string,
): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
  if (action === "send") return sendAs(request, env, pushFetch, requestId, sendSchema, planAlert, sender(request, env, machineId));
  if (action === "activity") return sendAs(request, env, pushFetch, requestId, activitySchema, planActivity, sender(request, env, machineId));
  await requireCloudHomeRelay(request, env);
  if (action === "register") return registerFor(request, env, MACHINE_PUSH_STORE, machineId, [FLEET_REGISTERS]);
  if (action === "unregister") return unregisterFor(request, env, MACHINE_PUSH_STORE, machineId);
  return forget(env, machineId);
}
