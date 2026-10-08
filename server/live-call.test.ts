import { describe, expect, it, vi } from "vitest";

import {
  createLiveSession,
  DEFAULT_LIVE_VOICE,
  LIVE_MODEL,
  liveAttachUrl,
  liveBaseUrl,
  liveErrorMessage,
  liveHistoryFrom,
  LiveSessionError,
  liveInitialInput,
  liveInstructions,
  liveSessionsUrl,
  MAX_SDP_BYTES,
} from "./live-call.ts";
import { CLOUD_HOME_PLACE } from "./system-prompt.ts";

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
const BOT = { name: "Ada", title: "Tech Lead", description: "Leads the engineering team." };

function okFetch(answer = { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(answer), { status: 201 }));
}

describe("createLiveSession", () => {
  it("creates a client-delegation session and returns only the answer", async () => {
    const fetchImpl = okFetch();
    const result = await createLiveSession({
      key: " sk-live-secret ",
      sdp: OFFER,
      bot: BOT,
      history: [{ role: "user", text: "Check the release notes" }, { role: "assistant", text: "Done: two fixes." }],
      voice: "cedar",
      cloudHome: false,
      fetchImpl,
    });
    expect(result).toEqual({ sessionId: "live_123", sdp: "v=0 answer" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(init).toBeDefined();
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-live-secret");
    const body = JSON.parse(String(init?.body));
    expect(body.transport).toEqual({ type: "webrtc", sdp: OFFER });
    expect(body.session.model).toBe(LIVE_MODEL);
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.session.audio).toEqual({ output: { voice: "cedar" } });
    expect(body.session.instructions).toContain("You are Ada, Tech Lead");
    expect(body.session.instructions).toContain("Delegation policy:");
    expect(body.session.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Check the release notes" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done: two fixes." }] },
    ]);
    // the key is a header, never part of the session body
    expect(String(init?.body)).not.toContain("sk-live-secret");
  });

  it("tells the voice where it runs: the user's own computer, or their My Cloud", async () => {
    const fetchImpl = okFetch();
    await createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: true, fetchImpl });
    await createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl });
    const [cloud, computer] = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).session.instructions as string);
    expect(cloud).toContain("runs on the user's My Cloud, their always-on OpenMausBot in the cloud, not on their own computer.");
    expect(computer).toContain("runs in OpenMausBot on the user's own computer.");
    expect(computer).not.toContain("My Cloud");
  });

  it("falls back to the default voice and omits empty history", async () => {
    const fetchImpl = okFetch();
    await createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, voice: "not a voice!", fetchImpl });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.session.audio.output.voice).toBe(DEFAULT_LIVE_VOICE);
    expect(body.session).not.toHaveProperty("input");
  });

  it("passes an unlisted but well-formed voice name through for OpenAI to judge", async () => {
    const fetchImpl = okFetch();
    await createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, voice: " Sol ", fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).session.audio.output.voice).toBe("sol");
  });

  it("refuses without a key or with a bad offer before calling OpenAI", async () => {
    const fetchImpl = okFetch();
    await expect(createLiveSession({ key: " ", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl })).rejects.toMatchObject({ status: 409 });
    await expect(createLiveSession({ key: "k", sdp: " ", bot: BOT, history: [], cloudHome: false, fetchImpl })).rejects.toMatchObject({ status: 400 });
    await expect(createLiveSession({ key: "k", sdp: "x".repeat(MAX_SDP_BYTES + 1), bot: BOT, history: [], cloudHome: false, fetchImpl })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns OpenAI refusals into plain messages without echoing the body", async () => {
    const refuse = (status: number) => vi.fn(async () => new Response(JSON.stringify({ error: { message: "sk-live-secret is invalid" } }), { status }));
    for (const [status, text, returned] of [[400, "rejected the call settings", 502], [401, "rejected the API key", 502], [403, "no access to GPT-Live", 502], [429, "limiting Live sessions", 429], [500, "had a problem", 502]] as const) {
      const error = await createLiveSession({ key: "sk-live-secret", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: refuse(status) }).catch((e) => e);
      expect(error).toBeInstanceOf(LiveSessionError);
      expect(error.status).toBe(returned);
      expect(error.message).toContain(text);
      expect(error.message).not.toContain("sk-live-secret");
    }
  });

  it("reports network failures and malformed answers", async () => {
    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: offline })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Could not reach OpenAI") });
    const odd = vi.fn(async () => new Response(JSON.stringify({ session: {} }), { status: 201 }));
    await expect(createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: odd })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("unexpected answer") });
  });
});

describe("live startup context", () => {
  it("keeps the newest messages inside the history budget", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: `message ${index} ${"x".repeat(900)}` }));
    const input = liveInitialInput(history);
    expect(input.length).toBeLessThanOrEqual(8);
    expect(input.at(-1)?.content[0].text.startsWith("message 29")).toBe(true);
    const total = input.reduce((sum, item) => sum + item.content[0].text.length, 0);
    expect(total).toBeLessThanOrEqual(6_000);
    for (const item of input) expect(item.content[0].text.length).toBeLessThanOrEqual(600);
  });

  it("takes the chat's text lines as history, and never a finished call's row", () => {
    expect(liveHistoryFrom([
      { role: "user", kind: "text", text: "what is six times seven" },
      { role: "bot", kind: "activity" },
      { role: "bot", kind: "text", text: "Six times seven is 42." },
      { role: "bot", kind: "call", text: "Call with Ada · 0:42" },
      { role: "bot", kind: "options", text: "Approve?" },
    ])).toEqual([
      { role: "user", text: "what is six times seven" },
      { role: "assistant", text: "Six times seven is 42." },
    ]);
  });

  it("writes one-line instructions from the bot's own profile", () => {
    const text = liveInstructions({ name: "  Rigel\n", title: "QA", description: "Line one\nline two" });
    expect(text.split("\n")[0]).toBe("You are Rigel, QA, an AI agent that runs in OpenMausBot on the user's own computer. Line one line two");
    expect(text).toContain("Never answer it yourself.");
  });

  // On a Cloud the harness is a server in the cloud: a voice that says it
  // runs on the person's own computer offers what it cannot reach. It names
  // the place in the bot's own words (cloudHomePrompt), so the two cannot drift.
  it("on a Cloud, says the voice runs on the user's My Cloud, not their own computer", () => {
    const text = liveInstructions({ name: "Rigel", title: "QA" }, { cloudHome: true });
    expect(text.split("\n")[0]).toBe(`You are Rigel, QA, an AI agent that runs on ${CLOUD_HOME_PLACE}.`);
    expect(text.split("\n")[0]).toBe("You are Rigel, QA, an AI agent that runs on the user's My Cloud, their always-on OpenMausBot in the cloud, not on their own computer.");
    expect(text).not.toContain("OMB");
    expect(liveInstructions({ name: "Rigel" }, { cloudHome: false }).split("\n")[0]).toBe("You are Rigel, an AI agent that runs in OpenMausBot on the user's own computer.");
  });

  // The bot's work happens where it runs: on a Cloud that is My Cloud, never
  // "the computer" just after the voice was told it is not on their computer.
  it("says the bot changes things where it runs", () => {
    const backend = (cloudHome: boolean) => liveInstructions({ name: "Rigel" }, { cloudHome }).split("\n").find((line) => line.startsWith("- Rigel:"));
    expect(backend(true)).toContain("It researches, writes, changes things on My Cloud, and answers questions");
    expect(backend(false)).toContain("It researches, writes, changes things on the computer, and answers questions");
    expect(liveInstructions({ name: "Rigel" }, { cloudHome: true })).not.toMatch(/\bthe computer\b/);
  });

  it("tells the voice to answer 'is it still working?' from the status notes, not by delegating", () => {
    const text = liveInstructions({ name: "Rigel" });
    expect(text).toContain("- The user only asks whether you are still working or stuck.");
    expect(text).toContain("While you work you get quiet status notes");
  });

  // The voice called itself "the voice layer" and offered to "ask the backend"
  // when asked which AI model it is. It is the bot, and it checks without asking.
  it("makes the voice the bot itself: first person, no backend talk, no asking to check", () => {
    const text = liveInstructions({ name: "CFO", title: "Chief Financial Officer" });
    expect(text.split("\n")[0]).toBe("You are CFO, Chief Financial Officer, an AI agent that runs in OpenMausBot on the user's own computer.");
    expect(text).not.toContain("only the voice");
    expect(text).not.toContain("voice of");
    expect(text).toContain("Never mention a backend, delegation, a voice layer, or another system or model doing the work");
    expect(text).toContain("Never ask the user whether you may look something up or check something");
    expect(text).toContain("- The user asks something about you that this conversation does not already answer, for example which AI model you run on.");
    // OpenAI's trained delegation labels stay as they are
    for (const label of ["Backchannel policy:", "Interruption policy:", "Delegation policy:", "Backend tools:", "Delegate to the backend when:", "Do not delegate to the backend when:"]) {
      expect(text).toContain(label);
    }
  });
});

describe("live call summary line", () => {
  it("keeps counters and short codes only", async () => {
    const { liveCallSummaryLine } = await import("./live-call.ts");
    const line = liveCallSummaryLine({
      botId: "bot-1", voice: "sol", client: "ios", seconds: 83.6, delegations: 3, sentToBot: 2, answers: 0, approvals: 1,
      notHeard: 1, replies: 2, end: "close_requested", errors: ["rate_limit", "bad code; rm -rf /", 7],
      said: "this must never be logged",
    });
    expect(line).toBe("[live] call ended bot=bot-1 voice=sol client=ios seconds=84 delegations=3 sentToBot=2 answers=0 approvals=1 notHeard=1 replies=2 end=close_requested errors=rate_limit,badcoderm-rf");
    expect(line).not.toContain("never be logged");
    expect(liveCallSummaryLine({ seconds: -5, delegations: "x" })).toContain("seconds=0 delegations=0");
    expect(liveCallSummaryLine({ client: "desk top!" })).toContain(" client=desktop ");
    expect(liveCallSummaryLine({})).toContain(" client=? ");
  });
});

describe("session config for the untrusted client", () => {
  it("lets the client data channel send only session.close and receive captions", async () => {
    const fetchImpl = okFetch();
    await createLiveSession({ key: "sk-test", sdp: "v=0\r\n", bot: { name: "Ada" } as never, history: [], cloudHome: false, fetchImpl });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.session.client).toEqual({
      data_channel: {
        allowed_client_events: ["session.close"],
        allowed_server_events: [
          { type: "session.started" },
          { type: "session.input_transcript.delta" },
          { type: "session.output_transcript.delta" },
          { type: "session.closed" },
          { type: "error" },
          { type: "info" },
        ],
      },
    });
    expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0\r\n" });
  });
});

describe("live URLs", () => {
  it("uses OpenAI unless a loopback test server is set", () => {
    expect(liveSessionsUrl({})).toBe("https://api.openai.com/v1/live/sessions");
    expect(liveAttachUrl("sess_1", {})).toBe("wss://api.openai.com/v1/live/sessions/sess_1/attach");
    const env = { OMB_OPENAI_LIVE_URL: "http://127.0.0.1:4555" };
    expect(liveSessionsUrl(env)).toBe("http://127.0.0.1:4555/v1/live/sessions");
    expect(liveAttachUrl("sess_1", env)).toBe("ws://127.0.0.1:4555/v1/live/sessions/sess_1/attach");
  });
  it("ignores an override that is not loopback", () => {
    expect(liveBaseUrl({ OMB_OPENAI_LIVE_URL: "http://evil.example:80" })).toBe("https://api.openai.com");
  });
  it("escapes the session id", () => {
    expect(liveAttachUrl("a/b", {})).toBe("wss://api.openai.com/v1/live/sessions/a%2Fb/attach");
  });
});

describe("liveErrorMessage", () => {
  it("blames the voice only when OpenAI names the voice", () => {
    expect(liveErrorMessage(400, "session.audio.output.voice")).toMatch(/voice/);
    expect(liveErrorMessage(400, "session.client")).not.toMatch(/voice/);
    expect(liveErrorMessage(400)).toMatch(/call settings/);
  });
});
