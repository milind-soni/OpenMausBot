// Live calls (GPT-Live as the voice, the bot as the brain). The call itself
// runs in LiveCallController; these routes start it, end it, report it and
// change its non-secret settings. The OpenAI key is never read or written
// here. All are admin-scoped by default in server/request-auth.ts; the
// companion allows the first four for the phone apps (companion/src/routes.ts).
// The fifth, device-revoked, is the companion's own notice that it unpaired a
// phone; a phone can never send it (companion/src/routes.ts COMPANION_NOTICES).
// Starting a call needs an active Pro plan (402 `needsPro`, before the key's
// 409 `needsKey`), for every client: the phones' starts come through here too.
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { LiveSettings } from "../../shared/wire.ts";
import { LiveSessionError, MAX_SDP_BYTES } from "../live-call.ts";
import { LiveCallBusyError, LiveCallNeedsProError, type LiveCallController } from "../live-call-controller.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface LiveRouteDeps {
  calls: Pick<LiveCallController, "start" | "end" | "current" | "deviceRevoked">;
  /** The bot and chat a call goes to; no threadId means the bot's current chat. Null when either is unknown. */
  resolveTarget(botId: string, threadId: string | undefined): { botId: string; botName: string; threadId: string } | null;
  settings(): LiveSettings;
  saveSettings(patch: { voice?: string; readTypedReplies?: boolean; idleMinutes?: number }): Promise<LiveSettings>;
}

const id = z.string().regex(/^[\w-]{1,120}$/);
const sessionBody = z.object({
  botId: id,
  threadId: id.optional(),
  // Not trimmed: the SDP offer goes to OpenAI byte for byte.
  sdp: z.string().min(1).refine((sdp) => Buffer.byteLength(sdp) <= MAX_SDP_BYTES),
  client: z.enum(["desktop", "web", "ios", "android"]),
}).strict();
const endBody = z.object({ callId: z.string().min(1).max(120) }).strict();
// Strict, so `key` (or anything else) is refused rather than ignored: the key
// is saved through the desktop's credential store or PUT /api/config, never here.
const settingsBody = z.object({
  voice: z.string().trim().max(40).regex(/^[a-z]*$/).optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
}).strict();

const DEVICE_ID = /^[\w-]{1,128}$/;

/** The paired phone the companion vouched for, or undefined. The companion
 * sends its own id for the phone that authenticated (never one the phone
 * chose); in the desktop app the harness has already checked the companion's
 * private token before this runs (server/request-auth.ts). */
function companionDevice(req: IncomingMessage): string | undefined {
  if (req.headers["x-openmausbot-companion"] !== "1") return undefined;
  const device = req.headers["x-openmausbot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? device : undefined;
}

/** The parsed JSON body, or undefined when it is not JSON (the schema then refuses it). */
async function bodyOf(req: IncomingMessage, readBody: RouteContext["readBody"]): Promise<unknown> {
  try {
    return await readBody(req);
  } catch {
    return undefined;
  }
}

export function createLiveRoutes(deps: LiveRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/live/")) return PASS;

    if (method === "POST" && path === "/api/live/session") {
      const parsed = sessionBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The call request was not valid." });
      const target = deps.resolveTarget(parsed.data.botId, parsed.data.threadId);
      if (!target) return json(res, 404, { error: "That bot or chat does not exist." });
      try {
        // A phone's call is bound to the phone, so unpairing it ends the call.
        const device = companionDevice(req);
        const { call, sdp } = await deps.calls.start({ auth, ...(device ? { device } : {}), ...target, client: parsed.data.client, sdp: parsed.data.sdp });
        return json(res, 201, { call, transport: { type: "webrtc", sdp } });
      } catch (error) {
        if (error instanceof LiveCallBusyError) return json(res, 409, { error: error.message, activeCall: error.call });
        // a client shows its Pro prompt, never the key form
        if (error instanceof LiveCallNeedsProError) return json(res, 402, { error: error.message, needsPro: true });
        if (error instanceof LiveSessionError) {
          // The one 409 a session refuses with is a missing key.
          return json(res, error.status, error.status === 409 ? { error: error.message, needsKey: true } : { error: error.message });
        }
        throw error;
      }
    }

    if (method === "POST" && path === "/api/live/call/end") {
      const parsed = endBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The request was not valid." });
      const call = await deps.calls.end(parsed.data.callId);
      return call ? json(res, 200, { call }) : json(res, 404, { error: "That call is not running." });
    }

    if (method === "GET" && path === "/api/live/call") return json(res, 200, { call: deps.calls.current() });

    // The companion unpaired a phone: end the call that phone holds, if any.
    if (method === "POST" && path === "/api/live/device-revoked") {
      if (req.headers["x-openmausbot-companion"] !== "1") return json(res, 403, { error: "Only the phone companion can report an unpaired phone." });
      const device = companionDevice(req);
      if (!device) return json(res, 400, { error: "The unpaired phone was not named." });
      return json(res, 200, { call: deps.calls.deviceRevoked(device) });
    }

    if (method === "PATCH" && path === "/api/live/settings") {
      const parsed = settingsBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) {
        return json(res, 400, { error: "Those Live settings are not valid." });
      }
      // as PUT /api/config: an empty patch is not saved (or broadcast)
      if (!Object.keys(parsed.data).length) return json(res, 400, { error: "nothing to save" });
      return json(res, 200, { live: await deps.saveSettings(parsed.data) });
    }

    return PASS;
  };
}
