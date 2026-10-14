import type { IncomingMessage } from "node:http";

import type { PhonePush } from "../phone-push.ts";
import { registrationSchema } from "../phone-push.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const DEVICE_ID = /^[\w-]{1,128}$/;

/** Keyed by the identity that authenticated the request, never by anything in the body. */
export function phonePushIdentity(req: IncomingMessage, auth: RequestAuth): string | null {
  if (auth.kind === "session") return auth.session.cookieOnly ? null : `session:${auth.session.id}`;
  if (req.headers["x-openmausbot-companion"] !== "1") return null;
  const device = req.headers["x-openmausbot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? `companion:${device}` : null;
}

export interface PhonePushRouteDeps {
  push: Pick<PhonePush, "device" | "register" | "remove" | "status">;
}

export function createPhonePushRoutes(deps: PhonePushRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/push/device") return PASS;
    const key = phonePushIdentity(req, auth);
    if (!key) return json(res, 403, { error: "Only a paired phone can register for alerts, and only for itself." });

    if (method === "GET") {
      return json(res, 200, { push: deps.push.status(), device: deps.push.device(key) });
    }
    if (method === "PUT") {
      let body: unknown;
      try {
        body = await readBody(req, 4_096);
      } catch {
        body = undefined;
      }
      const parsed = registrationSchema.safeParse(body);
      if (!parsed.success) {
        return json(res, 400, {
          error: 'Send the APNs device token as lowercase hex and its environment, for example {"token":"<64 hex characters>","environment":"production","pairing":"<8-64 characters you chose for this computer>"}.',
        });
      }
      try {
        const { device, relay } = await deps.push.register(key, parsed.data);
        return json(res, 200, { push: deps.push.status(), device, relay });
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 409) return json(res, 409, { error: (error as Error).message });
        throw error;
      }
    }
    if (method === "DELETE") {
      const removed = await deps.push.remove(key);
      return json(res, 200, { removed });
    }
    return json(res, 405, { error: "method not allowed" });
  };
}
