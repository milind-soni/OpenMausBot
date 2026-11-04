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

/** Who runs a Live call's GPT-Live session: OpenAI itself, or a GPT-Live deployment on the user's own Azure OpenAI / Foundry resource. */
export type LiveProvider = "openai" | "azure";

/** `live`: the key saved for Live calls only; `openai`: the OpenAI API key from Settings → API keys, used when there is no `live` key. */
export type LiveKeySource = "live" | "openai";

/** Non-secret Live settings, as GET /api/config and PATCH /api/live/settings report them. */
export interface LiveSettings {
  /** A Live call has everything it needs: a key (`keySource` says which; never the key itself) and, for Azure, a valid endpoint and deployment. */
  configured: boolean;
  keySource?: LiveKeySource;
  /** Absent means "openai". With "azure" only the `live` key is used, never the OpenAI API key. */
  provider?: LiveProvider;
  /** The Azure resource endpoint as saved, e.g. `https://my-resource.openai.azure.com`. Not a secret. */
  azureEndpoint?: string;
  /** The Azure deployment of gpt-live-1; empty means "gpt-live-1". */
  azureDeployment?: string;
  voice: string;
  readTypedReplies: boolean;
  idleMinutes: number;
}
