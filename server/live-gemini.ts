// Gemini Live calls. The Gemini key never leaves the harness: the client gets only a single-use ephemeral token whose setup
// (model, instructions, the `delegate` tool) the harness locks here, and it relays what was said as a Fish Audio call does.
import { randomBytes } from "node:crypto";
import type { LiveGeminiSession } from "../shared/wire.ts";
import { LiveSessionError, type LiveBot, type LiveEndpoint, type LiveHistoryMessage } from "./live-call.ts";
import { FISH_DELEGATE_TOOL, fishInstructions } from "./live-fish.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";
const MODEL = /^[\w.-]{1,80}$/;
const CREATE_TIMEOUT_MS = 20_000;
/** How long the client has to connect, and how long the call may then run, reconnecting with session resumption. */
const CONNECT_WITHIN_MS = 60_000;
const CALL_AT_MOST_MS = 60 * 60_000;
const TOKEN = /^auth_tokens\/[\w.-]{1,512}$/;

/** Only a loopback http URL is accepted, read at call time. */
export function geminiLiveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_GEMINI_LIVE_URL?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override) ? override : GEMINI_BASE;
}

/** `model` is OMB_GEMINI_LIVE_MODEL when that is a model id, else the default Live model. */
export function geminiLiveEndpoint(env: NodeJS.ProcessEnv = process.env): LiveEndpoint {
  const model = env.OMB_GEMINI_LIVE_MODEL?.trim().replace(/^models\//, "") ?? "";
  return { provider: "gemini", apiBase: `${geminiLiveBaseUrl(env)}/${API_VERSION}`, model: MODEL.test(model) ? model : GEMINI_LIVE_MODEL };
}

/** The setup every connection of the call gets, whatever the client sends: Gemini Live API `BidiGenerateContentSetup`. */
export function geminiLiveSetup(model: string, instructions: string): Record<string, unknown> {
  return {
    model: `models/${model}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: instructions }] },
    tools: [{ functionDeclarations: [{
      name: FISH_DELEGATE_TOOL,
      description: "Hands the user's request to the assistant that does the work: looking things up, using apps and files, running tasks.",
      parameters: { type: "OBJECT", properties: { request: { type: "STRING", description: "What the user asked for, in their own words." } }, required: ["request"] },
      behavior: "NON_BLOCKING",
    }] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Audio-only sessions stop at 15 minutes without it.
    contextWindowCompression: { slidingWindow: {} },
  };
}

/** The locked fields, as @google/genai's `getFieldMasks` writes them. Session resumption is left out, so the client can
 * reconnect the call with its handle when Gemini ends a connection (about every 10 minutes). */
export function geminiFieldMask(setup: Record<string, unknown>): string {
  return Object.entries(setup).flatMap(([key, value]) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length
    ? Object.keys(value).map((inner) => `${key}.${inner}`)
    : [key]).join(",");
}

export interface CreateGeminiSessionInput {
  key: string;
  endpoint: LiveEndpoint;
  bot: LiveBot;
  history: LiveHistoryMessage[];
  cloudHome: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Gemini API `POST /v1beta/auth_tokens`. Errors carry a status and a message fit for the user: never the key, never
 * Gemini's raw body. */
export async function createGeminiLiveSession(input: CreateGeminiSessionInput): Promise<LiveGeminiSession> {
  const key = input.key.trim();
  if (!key) throw new LiveSessionError("Add a Gemini API key in Settings → API keys to use Live calls.", 409);
  const now = (input.now ?? Date.now)();
  const setup = geminiLiveSetup(input.endpoint.model, fishInstructions(input.bot, input.history, { cloudHome: input.cloudHome }));
  const expiresAt = new Date(now + CONNECT_WITHIN_MS).toISOString();
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${input.endpoint.apiBase}/auth_tokens`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + CALL_AT_MOST_MS).toISOString(),
        newSessionExpireTime: expiresAt,
        bidiGenerateContentSetup: setup,
        fieldMask: geminiFieldMask(setup),
      }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LiveSessionError(timedOut ? "Gemini did not answer in time. Try the call again." : "Could not reach Gemini. Check the internet connection.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new LiveSessionError(geminiErrorMessage(response.status), response.status === 429 ? 429 : 502);
  }
  const answer = await response.json().catch(() => null) as { name?: unknown } | null;
  if (typeof answer?.name !== "string" || !TOKEN.test(answer.name)) throw new LiveSessionError("Gemini returned an unexpected answer. Try the call again.", 502);
  const root = input.endpoint.apiBase.replace(/\/v1\w*$/, "").replace(/^http/, "ws");
  return {
    session_id: `gemini_${randomBytes(12).toString("hex")}`,
    token: answer.name,
    ws_url: `${root}/ws/google.ai.generativelanguage.${API_VERSION}.GenerativeService.BidiGenerateContentConstrained`,
    model: `models/${input.endpoint.model}`,
    expires_at: expiresAt,
  };
}

export function geminiErrorMessage(status: number): string {
  switch (status) {
    case 400: return "Gemini rejected the call settings (HTTP 400).";
    case 401:
    case 403: return "Gemini rejected the API key. Check the Gemini key in Settings → API keys.";
    case 404: return "Gemini could not find the Live model for calls.";
    case 429: return "Gemini is limiting Live sessions on this key right now. Try again in a moment.";
    default: return status >= 500 ? "Gemini had a problem starting the call. Try again in a moment." : `Gemini could not start the call (HTTP ${status}).`;
  }
}
