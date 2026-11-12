// The provider key is never read or written here; without one a start answers 409 `needsKey`. A phone can never send device-revoked.
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { LiveSettings, LiveSettingsPatch } from "../../shared/wire.ts";
import { qwenModelSchema, qwenRegionSchema, qwenVoiceSchema, qwenWorkspaceSchema } from "../qwen-live-config.ts";
import { azureLiveDeployment, azureOpenAiRoot, LiveSessionError, MAX_SDP_BYTES } from "../live-call.ts";
import { LiveCallBusyError, type LiveCallController } from "../live-call-controller.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface LiveRouteDeps {
  calls: Pick<LiveCallController, "start" | "end" | "current" | "deviceRevoked">;
  resolveTarget(botId: string, threadId: string | undefined): { botId: string; botName: string; threadId: string } | null;
  settings(): LiveSettings;
  saveSettings(patch: LiveSettingsPatch): Promise<LiveSettings>;
}

const id = z.string().regex(/^[\w-]{1,120}$/);
const sessionBody = z.object({
  botId: id,
  threadId: id.optional(),
  // Not trimmed: the SDP offer goes to OpenAI byte for byte.
  sdp: z.string().min(1).refine((sdp) => Buffer.byteLength(sdp) <= MAX_SDP_BYTES),
  client: z.enum(["desktop", "web", "ios", "android"]),
  transports: z.array(z.literal("ws-pcm")).max(1).optional(),
}).strict();
const endBody = z.object({ callId: z.string().min(1).max(120) }).strict();
// Strict, so `key` is refused rather than ignored: the key is saved only through the credential store or PUT /api/config.
const settingsBody = z.object({
  provider: z.enum(["openai", "azure", "qwen"]).optional(),
  qwenRegion: qwenRegionSchema.optional(),
  qwenWorkspace: qwenWorkspaceSchema.optional(),
  qwenModel: qwenModelSchema.optional(),
  qwenVoice: qwenVoiceSchema.optional(),
  // "" clears the field. Anything else must be an https Azure OpenAI host, since the key is sent there.
  azureEndpoint: z.string().trim().max(300).refine((url) => url === "" || azureOpenAiRoot(url) !== null).optional(),
  azureDeployment: z.string().trim().max(64).refine((name) => name === "" || azureLiveDeployment(name) === name).optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/).optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
}).strict();

const DEVICE_ID = /^[\w-]{1,128}$/;

/** The companion sends its own id for the phone that authenticated, never one the phone chose. */
function companionDevice(req: IncomingMessage): string | undefined {
  if (req.headers["x-openmausbot-companion"] !== "1") return undefined;
  const device = req.headers["x-openmausbot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? device : undefined;
}

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
        const device = companionDevice(req);
        const { call, sdp, transport } = await deps.calls.start({ auth, ...(device ? { device } : {}), ...target, client: parsed.data.client, sdp: parsed.data.sdp,
          ...(parsed.data.transports ? { transports: parsed.data.transports } : {}),
        });
        return json(res, 201, { call, transport: transport ?? { type: "webrtc", sdp } });
      } catch (error) {
        if (error instanceof LiveCallBusyError) return json(res, 409, { error: error.message, activeCall: error.call });
        if (error instanceof LiveSessionError) {
          return json(res, error.status, error.needsKey ? { error: error.message, needsKey: true } : { error: error.message });
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

    if (method === "POST" && path === "/api/live/device-revoked") {
      if (req.headers["x-openmausbot-companion"] !== "1") return json(res, 403, { error: "Only the phone companion can report an unpaired phone." });
      const device = companionDevice(req);
      if (!device) return json(res, 400, { error: "The unpaired phone was not named." });
      return json(res, 200, { call: deps.calls.deviceRevoked(device) });
    }

    if (method === "PATCH" && path === "/api/live/settings") {
      const parsed = settingsBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        if (field === "azureEndpoint") return json(res, 400, { error: "The Azure endpoint must be the https address of an Azure OpenAI resource, like https://my-resource.openai.azure.com." });
        if (field === "azureDeployment") return json(res, 400, { error: "The Azure deployment name may use letters, digits, '-', '_' and '.', up to 64 characters." });
        if (field === "qwenWorkspace") return json(res, 400, { error: "The Qwen business space may use lowercase letters, digits and '-', up to 63 characters. It must start and end with a letter or digit." });
        if (field === "qwenVoice") return json(res, 400, { error: "The Qwen voice must start with a letter and use letters, digits, '-', '_' and '.', up to 80 characters." });
        return json(res, 400, { error: "Those Live settings are not valid." });
      }
      if (!Object.keys(parsed.data).length) return json(res, 400, { error: "nothing to save" });
      return json(res, 200, { live: await deps.saveSettings(parsed.data) });
    }

    return PASS;
  };
}
