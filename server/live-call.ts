// Live calls: OpenAI GPT-Live as the voice, the bot as the brain.
//
// The voice design doc (docs/voice-mode.md) rejected speech-to-speech models
// because "they replace the brain". GPT-Live's *client delegation* does not:
// the voice model only runs the conversation — listening while it speaks,
// taking interruptions, filling the wait — and hands every real request back
// to the application. Here that application is the harness, and the request
// becomes an ordinary turn on the bot the person called, with its own engine,
// tools, memory and approvals. Nothing about the bot changes.
//
// This file owns the one server-side step: exchanging the renderer's WebRTC
// offer for an answer. The OpenAI key never leaves the harness; the renderer
// only ever holds the SDP answer and the media connection it describes.

export const LIVE_MODEL = "gpt-live-1";
const OPENAI_BASE = "https://api.openai.com";
export const DEFAULT_LIVE_VOICE = "marin";
/** Largest SDP offer accepted from the renderer — a real offer is a few KB. */
export const MAX_SDP_BYTES = 64 * 1024;

/** The client's data channel is untrusted (it runs on a phone or in a
 * renderer). It may only hang up; the harness sends every append over the
 * sideband. Server events are limited to what captions and state need. */
export const LIVE_DATA_CHANNEL = {
  allowed_client_events: ["session.close"],
  allowed_server_events: [
    { type: "session.started" },
    { type: "session.input_transcript.delta" },
    { type: "session.output_transcript.delta" },
    { type: "session.closed" },
    { type: "error" },
    { type: "info" },
  ],
};

/** Tests and fixtures point this at server/testing/fake-openai-live.ts.
 * Only a loopback http URL is accepted, read at call time. */
export function liveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_OPENAI_LIVE_URL?.trim() ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override) ? override : OPENAI_BASE;
}

export function liveSessionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${liveBaseUrl(env)}/v1/live/sessions`;
}

export function liveAttachUrl(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${liveBaseUrl(env).replace(/^http/, "ws")}/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
}

// Startup history is capped by the API at 128 messages / 8,192 tokens; stay
// well inside it. It is only there so "and the other one?" makes sense to
// the voice — the bot's own thread remains the source of truth.
const HISTORY_MESSAGES = 8;
const HISTORY_MESSAGE_CHARS = 600;
const HISTORY_TOTAL_CHARS = 6_000;
const CREATE_TIMEOUT_MS = 20_000;

export interface LiveBot {
  name: string;
  title?: string;
  description?: string;
}

export interface LiveHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export class LiveSessionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Frontend instructions for the voice. Business rules stay with the bot;
 * this only says who is speaking, where it runs and when to hand work over.
 * Structure follows the GPT-Live prompting guide's template. `cloudHome`:
 * the harness is the person's My Cloud, in the words of the bot's own system
 * prompt (cloudHomePrompt). */
export function liveInstructions(bot: LiveBot, { cloudHome = false }: { cloudHome?: boolean } = {}): string {
  const name = oneLine(bot.name) || "the agent";
  const title = oneLine(bot.title ?? "");
  const description = oneLine(bot.description ?? "").slice(0, 400);
  const where = cloudHome
    ? "runs on the user's My Cloud, their always-on OpenMausBot in the cloud, not on their own computer"
    : "runs in OpenMausBot on the user's own computer";
  return [
    `You are ${name}${title ? `, ${title}` : ""}, an AI agent that ${where}.${description ? ` ${description}` : ""}`,
    `To the user you are one assistant, ${name}, and you speak in the first person. Your work — looking things up, using your tools, files and memory, researching, deciding, and answering anything that needs facts this conversation does not hold — happens when you delegate. Delegating is how you think and act; it is not someone else.`,
    "Never mention a backend, delegation, a voice layer, or another system or model doing the work, and never say you are only a voice. Say \"I\" about the work.",
    "Never ask the user whether you may look something up or check something. When it needs checking, delegate at once and say briefly that you are checking.",
    "Speak warmly and naturally, at an unhurried pace. Keep replies short: one or two sentences unless the user asks for more. Speak the language the user speaks.",
    "",
    "Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the user.",
    "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
    "Delegation policy:",
    "Backend tools:",
    `- ${name}: your own files, tools, memory, settings and this conversation's history. It researches, writes, changes things on the computer, and answers questions, including questions about yourself such as which AI model you run on, your settings, your tools and your memory.`,
    "Delegate to the backend when:",
    "- The user asks a question, asks for work, or gives an instruction.",
    "- The user asks something about you that this conversation does not already answer, for example which AI model you run on.",
    "- The user answers a question you asked, including yes or no to a permission request.",
    "- A correction or a new detail changes work already requested.",
    "Do not delegate to the backend when:",
    "- You can answer from this conversation or from a result that is still current.",
    "- The user only greets you, thanks you, or asks you to repeat something you already said.",
    "- The user only asks whether you are still working or stuck.",
    "- You cannot tell what they are asking for without a brief clarification.",
    "Delegate before giving an answer that depends on backend work.",
    "Do not guess the result while waiting. You may say briefly that you are on it, then wait for the update.",
    "While you work you get quiet status notes: how long you have worked, how many steps you took, and your last step. Answer questions about progress from the latest note in one short sentence. Only say you are stuck when the note shows no new step for several minutes.",
    "Never say that an action happened until the result reports it.",
    "When a permission question comes up, ask it clearly and wait for a clear yes or no. Never answer it yourself.",
  ].join("\n");
}

/** Recent thread text as startup history, newest last, inside the budget. */
export function liveInitialInput(history: LiveHistoryMessage[]) {
  const picked: LiveHistoryMessage[] = [];
  let total = 0;
  for (const message of [...history].reverse()) {
    if (picked.length >= HISTORY_MESSAGES) break;
    const text = message.text.replace(/\s+/g, " ").trim().slice(0, HISTORY_MESSAGE_CHARS);
    if (!text) continue;
    if (total + text.length > HISTORY_TOTAL_CHARS) break;
    total += text.length;
    picked.unshift({ role: message.role, text });
  }
  return picked.map((message) => message.role === "user"
    ? { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: message.text }] }
    : { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text: message.text }] });
}

/** The configured voice name, or the default. OpenAI validates the name and
 * rejects an unknown one with a clear 400 (see liveErrorMessage). */
export function liveVoice(voice: string | undefined): string {
  const name = voice?.trim().toLowerCase() ?? "";
  return /^[a-z]{2,40}$/.test(name) ? name : DEFAULT_LIVE_VOICE;
}

export interface CreateLiveSessionInput {
  key: string;
  sdp: string;
  bot: LiveBot;
  history: LiveHistoryMessage[];
  /** This harness is a Cloud home (the person's My Cloud). Required, so
   * the one caller cannot leave the voice saying it runs on their computer. */
  cloudHome: boolean;
  voice?: string;
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
}

/** POST /v1/live/sessions with client delegation. Returns the session id
 * and the SDP answer. Errors carry a status and a message fit for the user —
 * never the key, never OpenAI's raw body. */
export async function createLiveSession(input: CreateLiveSessionInput): Promise<{ sessionId: string; sdp: string }> {
  const key = input.key.trim();
  if (!key) throw new LiveSessionError("Add an OpenAI API key to use Live calls.", 409);
  if (!input.sdp.trim() || Buffer.byteLength(input.sdp) > MAX_SDP_BYTES) {
    throw new LiveSessionError("The call could not start: the connection offer was invalid.", 400);
  }
  const initialInput = liveInitialInput(input.history);
  const body = {
    session: {
      model: LIVE_MODEL,
      instructions: liveInstructions(input.bot, { cloudHome: input.cloudHome }),
      // client delegation: every request comes back to the harness, which
      // runs it as a normal turn on the bot
      delegation: { type: "client" },
      audio: { output: { voice: liveVoice(input.voice) } },
      client: { data_channel: LIVE_DATA_CHANNEL },
      ...(initialInput.length ? { input: initialInput } : {}),
    },
    transport: { type: "webrtc", sdp: input.sdp },
  };
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.url ?? liveSessionsUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LiveSessionError(
      timedOut ? "OpenAI did not answer in time. Try the call again." : "Could not reach OpenAI. Check the internet connection.",
      502,
    );
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: { param?: unknown } } | null;
    const param = typeof failure?.error?.param === "string" ? failure.error.param : undefined;
    throw new LiveSessionError(liveErrorMessage(response.status, param), response.status === 429 ? 429 : 502);
  }
  const payload = await response.json().catch(() => null) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
  const sessionId = payload?.session?.id;
  const sdp = payload?.transport?.sdp;
  if (typeof sessionId !== "string" || typeof sdp !== "string" || !sdp.trim()) {
    throw new LiveSessionError("OpenAI returned an unexpected answer. Try the call again.", 502);
  }
  return { sessionId, sdp };
}

export function liveErrorMessage(status: number, param?: string): string {
  if (status === 400) {
    return param && /voice/i.test(param)
      ? "OpenAI rejected the voice for this call. Choose another voice."
      : `OpenAI rejected the call settings (HTTP 400${param ? `, ${param.replace(/[^\w.]/g, "").slice(0, 60)}` : ""}).`;
  }
  if (status === 401) return "OpenAI rejected the API key. Check the key for Live calls.";
  if (status === 403) return "This OpenAI project has no access to GPT-Live. Check the project's model access and billing.";
  if (status === 404) return "GPT-Live is not available for this OpenAI project.";
  if (status === 429) return "OpenAI is limiting Live sessions right now (rate limit or quota). Try again in a moment.";
  if (status >= 500) return "OpenAI had a problem starting the call. Try again in a moment.";
  return `OpenAI could not start the call (HTTP ${status}).`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** One server.log line per finished Live call, from the call's counters
 * (LiveCallController). Numbers and short codes only — never what anyone
 * said. */
export function liveCallSummaryLine(body: Record<string, unknown>): string {
  const count = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1_000_000) : 0;
  };
  const code = (value: unknown) => typeof value === "string" ? value.replace(/[^\w.-]/g, "").slice(0, 40) : "";
  const errors = Array.isArray(body.errors) ? body.errors.slice(0, 5).map(code).filter(Boolean) : [];
  return [
    "[live] call ended",
    `bot=${code(body.botId) || "?"}`,
    `voice=${code(body.voice) || DEFAULT_LIVE_VOICE}`,
    `client=${code(body.client) || "?"}`,
    `seconds=${count(body.seconds)}`,
    `delegations=${count(body.delegations)}`,
    `sentToBot=${count(body.sentToBot)}`,
    `answers=${count(body.answers)}`,
    `approvals=${count(body.approvals)}`,
    `notHeard=${count(body.notHeard)}`,
    `replies=${count(body.replies)}`,
    `end=${code(body.end) || "unknown"}`,
    `errors=${errors.length ? errors.join(",") : "none"}`,
  ].join(" ");
}
