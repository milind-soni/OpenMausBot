// /api/push/device: a paired phone registers, reads back or removes its own closed-app alert registration. The phone is
// known by what authenticated the request (a paired session, or the device the companion vouched for), never the body.
import { PHONE_ACTIVITY_ROUTE, PHONE_PUSH_ROUTE } from "../../shared/phone-push.ts";
import { activityRegistrationSchema, type PhoneActivity } from "../phone-activity.ts";
import { registrationSchema, type PhonePush } from "../phone-push.ts";
import type { RequestAuth } from "../request-auth.ts";
import { phoneKey } from "./phones.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const SELF_ONLY = "Only a paired phone can register for alerts, and only for itself.";

export interface PhonePushRouteDeps {
  push: PhonePush;
  live: (auth: RequestAuth) => boolean;
}

export function createPhonePushRoutes(deps: PhonePushRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== PHONE_PUSH_ROUTE) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    const key = phoneKey(auth);
    if (!key) return json(res, 403, { error: SELF_ONLY });
    if (method === "GET") return json(res, 200, deps.push.answer(key));
    if (method === "DELETE") {
      await deps.push.remove(key);
      return json(res, 200, deps.push.answer(key));
    }
    if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
    const parsed = registrationSchema.safeParse(await readBody(req, 16_384));
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    if (!parsed.success) return json(res, 400, { error: "Invalid push registration" });
    try {
      return json(res, 200, await deps.push.register(key, parsed.data));
    } catch (error) {
      const status = (error as { status?: unknown }).status === 409 ? 409 : 500;
      return json(res, status, { error: error instanceof Error ? error.message : "Could not save the registration" });
    }
  };
}

export interface PhoneActivityRouteDeps {
  push: PhonePush;
  activity: PhoneActivity;
  live: (auth: RequestAuth) => boolean;
}

/** /api/push/activity: the calling phone's Live Activity tokens, its words and its Android ongoing switch. */
export function createPhoneActivityRoutes(deps: PhoneActivityRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== PHONE_ACTIVITY_ROUTE) return PASS;
    res.setHeader("Cache-Control", "no-store");
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    const key = phoneKey(auth);
    if (!key) return json(res, 403, { error: SELF_ONLY });
    const answer = () => ({ push: deps.push.status(), activity: deps.activity.registration(key) });
    if (method === "GET") return json(res, 200, answer());
    if (method === "DELETE") {
      await deps.activity.remove(key);
      return json(res, 200, answer());
    }
    if (method !== "PUT") return json(res, 405, { error: "Method not allowed" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
    const parsed = activityRegistrationSchema.safeParse(await readBody(req, 32_768));
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    if (!parsed.success) return json(res, 400, { error: "Invalid activity registration" });
    try {
      await deps.activity.register(key, parsed.data);
      return json(res, 200, answer());
    } catch (error) {
      const status = (error as { status?: unknown }).status === 409 ? 409 : 500;
      return json(res, status, { error: error instanceof Error ? error.message : "Could not save the registration" });
    }
  };
}
