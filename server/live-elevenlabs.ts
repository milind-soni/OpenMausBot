// ElevenLabs Agents Live calls. The ElevenLabs key never leaves the harness: the harness sets up an agent with the client
// tool `delegate` on the person's account once, and for each call asks ElevenLabs for a signed URL the client opens; the
// client relays what was said as on a Fish Audio call.
import { randomBytes } from "node:crypto";
import type { LiveElevenLabsSession } from "../shared/wire.ts";
import { LiveSessionError, type LiveBot, type LiveEndpoint, type LiveHistoryMessage } from "./live-call.ts";
import type { LiveConfig } from "./live-config.ts";
import { elevenLabsProviderApi } from "./included-services.ts";
import { FISH_DELEGATE_TOOL, fishInstructions, fishKeyPrint } from "./live-fish.ts";

const REQUEST_TIMEOUT_MS = 20_000;
/** A signed URL is good for about 15 minutes; the client connects at once. */
const CONNECT_WITHIN_MS = 60_000;
const AGENT_ID = /^[\w-]{1,128}$/;
/** The agent's audio both ways: 16 kHz 16-bit PCM, as the client sends and plays it. */
const AUDIO_FORMAT = "pcm_16000";
const UNEXPECTED = "ElevenLabs returned an unexpected answer. Try the call again.";

/** `model` is the agent id, "" while no usable one is saved. The API root is the one ElevenLabs voices use (OMB_ELEVENLABS_API). */
export function elevenLabsLiveEndpoint(agentId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): LiveEndpoint {
  const id = agentId?.trim() ?? "";
  return { provider: "elevenlabs", apiBase: `${elevenLabsProviderApi(env).replace(/\/+$/, "")}/convai`, model: AGENT_ID.test(id) ? id : "" };
}

/** The saved agent, while it belongs to the account of `key`. */
export function usableElevenLabsAgent(live: LiveConfig | undefined, key: string): string | null {
  const id = live?.elevenlabsAgentId?.trim() ?? "";
  return AGENT_ID.test(id) && key.trim() !== "" && live?.elevenlabsAgentFor === fishKeyPrint(key) ? id : null;
}

async function elevenLabsRequest(fetchImpl: typeof fetch, key: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "xi-api-key": key.trim(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LiveSessionError(timedOut ? "ElevenLabs did not answer in time. Try the call again." : "Could not reach ElevenLabs. Check the internet connection.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw Object.assign(new LiveSessionError(elevenLabsErrorMessage(response.status), response.status === 429 ? 429 : 502), { elevenlabsStatus: response.status });
  }
  const answer = await response.json().catch(() => null) as unknown;
  return answer && typeof answer === "object" ? answer as Record<string, unknown> : {};
}

/** ElevenLabs API v1: the client tool `delegate`, then an English agent named for `product` that uses it and whose prompt each
 * conversation may override (the client sends the call's instructions). Returns the agent's id. */
export async function setUpElevenLabsAgent(key: string, endpoint: LiveEndpoint, product: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const tool = await elevenLabsRequest(fetchImpl, key, `${endpoint.apiBase}/tools`, {
    tool_config: {
      type: "client",
      name: FISH_DELEGATE_TOOL,
      description: "Hands the user's request to the assistant that does the work: looking things up, using apps and files, running tasks.",
      parameters: { type: "object", properties: { request: { type: "string", description: "What the user asked for, in their own words." } }, required: ["request"] },
      expects_response: true,
      response_timeout_secs: 30,
    },
  });
  const toolId = typeof tool.id === "string" ? tool.id : "";
  if (!toolId) throw new LiveSessionError(UNEXPECTED, 502);
  try {
    const agent = await elevenLabsRequest(fetchImpl, key, `${endpoint.apiBase}/agents/create`, {
      name: `${product} Live calls`.slice(0, 120),
      conversation_config: {
        agent: { first_message: "", language: "en", prompt: { prompt: `You are ${product} on a live voice call.`, tool_ids: [toolId] } },
        asr: { user_input_audio_format: AUDIO_FORMAT },
        tts: { agent_output_audio_format: AUDIO_FORMAT },
      },
      // Without this ElevenLabs refuses the prompt each conversation sends.
      platform_settings: { overrides: { conversation_config_override: { agent: { prompt: { prompt: true } } } } },
    });
    const agentId = typeof agent.agent_id === "string" && AGENT_ID.test(agent.agent_id) ? agent.agent_id : "";
    if (!agentId) throw new LiveSessionError(UNEXPECTED, 502);
    return agentId;
  } catch (error) {
    // No agent uses the tool, so it is not left on the person's account.
    await fetchImpl(`${endpoint.apiBase}/tools/${encodeURIComponent(toolId)}`, { method: "DELETE", headers: { "xi-api-key": key.trim() }, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then((response) => response.body?.cancel(), () => undefined).catch(() => undefined);
    throw error;
  }
}

export interface CreateElevenLabsSessionInput {
  key: string;
  endpoint: LiveEndpoint;
  bot: LiveBot;
  history: LiveHistoryMessage[];
  cloudHome: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** ElevenLabs API v1 `GET /v1/convai/conversation/get-signed-url`. Errors carry a status and a message fit for the user: never
 * the key, never ElevenLabs' raw body; `elevenlabsStatus` is ElevenLabs' own status. */
export async function createElevenLabsLiveSession(input: CreateElevenLabsSessionInput): Promise<LiveElevenLabsSession> {
  const key = input.key.trim();
  if (!key) throw new LiveSessionError("Add an ElevenLabs API key in Settings → API keys to use Live calls.", 409);
  const answer = await elevenLabsRequest(input.fetchImpl ?? fetch, key, `${input.endpoint.apiBase}/conversation/get-signed-url?agent_id=${encodeURIComponent(input.endpoint.model)}`);
  const url = typeof answer.signed_url === "string" ? answer.signed_url : "";
  // ElevenLabs answers with a wss URL; only a loopback override may answer with a loopback ws one.
  const loopback = input.endpoint.apiBase.startsWith("http://127.0.0.1:");
  if (!/^wss:\/\/\S+$/.test(url) && !(loopback && /^ws:\/\/127\.0\.0\.1:\d{1,5}\/\S*$/.test(url))) throw new LiveSessionError(UNEXPECTED, 502);
  return {
    session_id: `elevenlabs_${randomBytes(12).toString("hex")}`,
    signed_url: url,
    instructions: fishInstructions(input.bot, input.history, { cloudHome: input.cloudHome }),
    expires_at: new Date((input.now ?? Date.now)() + CONNECT_WITHIN_MS).toISOString(),
  };
}

export function elevenLabsErrorMessage(status: number): string {
  switch (status) {
    case 400:
    case 422: return `ElevenLabs rejected the call settings (HTTP ${status}).`;
    case 401:
    case 403: return "ElevenLabs rejected the API key, or the key may not use Agents. Check the ElevenLabs key in Settings → API keys.";
    case 404: return "ElevenLabs could not find the agent for calls.";
    case 429: return "ElevenLabs is limiting calls on this key right now. Try again in a moment.";
    default: return status >= 500 ? "ElevenLabs had a problem starting the call. Try again in a moment." : `ElevenLabs could not start the call (HTTP ${status}).`;
  }
}
