/** A Live call as the wire carries it: its state, the record a finished call
 * leaves, and the non-secret Live settings. Types only; `wire.ts` re-exports them. */

/** Which app holds the microphone of a Live call: the desktop app (its own
 * page or a server's page in it), a web browser, or a phone. Self-declared;
 * for display and logs only. The phone apps show a value they do not know as
 * "another device". */
export type LiveClient = "desktop" | "web" | "ios" | "android";
export type LiveCallStatus = "connecting" | "live" | "ending" | "ended";
/** Why a call ended. "signed-out": the sign-in or paired phone that started
 * it was signed out, revoked or unpaired. A client that does not know a
 * reason shows the call's `error` text, or plain "Call ended.". */
export type LiveEndReason =
  | "hung-up" | "idle" | "expired" | "content" | "remote-hangup" | "connection-lost"
  | "sideband-lost" | "deleted" | "shutdown" | "signed-out" | "error";

/** The one Live call a harness runs. Never carries the key or any speech. */
export interface LiveCallState {
  callId: string;
  botId: string;
  threadId: string;
  client: LiveClient;
  voice: string;
  /** epoch ms when the session was created */
  startedAt: number;
  status: LiveCallStatus;
  endReason?: LiveEndReason;
  /** short, user-facing; present when the call ended on a problem */
  error?: string;
}

/** One finished Live call, written once when a call that went live ends. Never carries speech. */
export interface LiveCallRecord {
  callId: string;
  botId: string;
  client: LiveClient;
  /** epoch ms, = LiveCallState.startedAt */
  startedAt: number;
  /** epoch ms when the call ended */
  endedAt: number;
  /** whole seconds: OpenAI usage seconds when given, else wall clock */
  seconds: number;
  endReason: LiveEndReason;
  /** only when LLM thread titles are on and the engine can generateText */
  title?: string;
}

/** Who runs a Live call's voice session: OpenAI itself, a GPT-Live deployment on the user's own Azure OpenAI / Foundry
 * resource, or a published Fish Audio agent (Fish Audio Live 3), whose session the client joins with Fish's SDK. */
export type LiveProvider = "openai" | "azure" | "fish";

/** `live`: the key saved for Live calls only; `openai`: the OpenAI API key from Settings → API keys, used when there is no `live` key. */
export type LiveKeySource = "live" | "openai";

/** Non-secret Live settings, as GET /api/config and PATCH /api/live/settings report them. */
export interface LiveSettings {
  /** A Live call has everything it needs: a key (`keySource` says which; never the key itself), for Azure a valid endpoint and deployment, and for Fish Audio an agent id. */
  configured: boolean;
  keySource?: LiveKeySource;
  /** Absent means "openai". With "azure" or "fish" only the `live` key is used, never the OpenAI API key. */
  provider?: LiveProvider;
  /** The Azure resource endpoint as saved, e.g. `https://my-resource.openai.azure.com`. Not a secret. */
  azureEndpoint?: string;
  /** The Azure deployment of gpt-live-1; empty means "gpt-live-1". */
  azureDeployment?: string;
  /** The published Fish Audio agent a "fish" call starts. Not a secret. */
  fishAgentId?: string;
  voice: string;
  readTypedReplies: boolean;
  idleMinutes: number;
}

/** The single-use token Fish Audio returns for one agent session (Fish API v1 `LiveKitSessionToken`), passed verbatim to
 * `AgentSession.start({ sessionToken })` of `@fishaudio/agent-client` 1.x. Holds no API key. */
export interface LiveFishSessionToken {
  transport: "livekit";
  session_id: string;
  /** ISO time by which the client must join */
  expires_at: string;
  max_duration_seconds: number;
  livekit_url: string;
  token: string;
}

/** A "fish" call's transport, answered only to the client that started the call: Fish's session token, and the token
 * that client presents on POST /api/live/relay, the call's only route for what it heard and for the bot's replies. */
export interface LiveFishTransport {
  type: "fish";
  session: LiveFishSessionToken;
  relayToken: string;
}

/** What the client of a "fish" call reports on POST /api/live/relay. Times are ms since the client joined the session. */
export type LiveFishRelayEvent =
  | { type: "connected" }
  | { type: "heard"; text: string; startMs: number; endMs: number }
  | { type: "spoke"; startMs: number; endMs: number }
  | { type: "delegate"; id: string; atMs: number }
  | { type: "ended"; reason: string }
  | { type: "error"; code: string };

/** What the harness hands the client of a "fish" call: words for the agent to speak or know (`kind` as on GPT-Live), or the end of the call. */
export type LiveFishRelayCommand =
  | { type: "append"; kind: "instructions" | "thinking" | "commentary"; content: string; delegationId: string | null }
  | { type: "close" };
