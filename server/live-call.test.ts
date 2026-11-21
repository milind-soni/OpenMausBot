import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openLiveSocket } from "./live-call-controller.ts";
import {
  azureLiveEndpoint,
  azureOpenAiRoot,
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
  spokenHangUp,
  openAiLiveEndpoint,
  type LiveEndpoint,
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

  it("says an OpenAI account with no credit left needs billing, not another try", async () => {
    const noCredit = vi.fn(async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } }), { status: 429 }));
    const error = await createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: noCredit }).catch((e) => e);
    expect(error).toMatchObject({ status: 429, message: expect.stringContaining("no credit left") });
    expect(error.message).not.toContain("Try again in a moment");
    const limited = vi.fn(async () => new Response(JSON.stringify({ error: { type: "requests", code: "rate_limit_exceeded" } }), { status: 429 }));
    await expect(createLiveSession({ key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: limited }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining("limiting Live sessions") });
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

  it("skips a text row that carries no text, so the voice is never given an empty line", () => {
    expect(liveHistoryFrom([
      { role: "user", kind: "text" },
      { role: "bot", kind: "text" },
      { role: "user", kind: "text", text: "and the other one?" },
    ])).toEqual([
      { role: "user", text: "and the other one?" },
    ]);
  });

  it("writes one-line instructions from the bot's own profile", () => {
    const text = liveInstructions({ name: "  Rigel\n", title: "QA", description: "Line one\nline two" });
    expect(text.split("\n")[0]).toBe("You are Rigel, QA, an AI agent that runs in OpenMausBot on the user's own computer. Line one line two");
    expect(text).toContain("Never answer it yourself.");
  });

  it("on a Cloud, says the voice runs on the user's My Cloud, not their own computer", () => {
    const text = liveInstructions({ name: "Rigel", title: "QA" }, { cloudHome: true });
    expect(text.split("\n")[0]).toBe(`You are Rigel, QA, an AI agent that runs on ${CLOUD_HOME_PLACE}.`);
    expect(text.split("\n")[0]).toBe("You are Rigel, QA, an AI agent that runs on the user's My Cloud, their always-on OpenMausBot in the cloud, not on their own computer.");
    expect(text).not.toContain("OMB");
    expect(liveInstructions({ name: "Rigel" }, { cloudHome: false }).split("\n")[0]).toBe("You are Rigel, an AI agent that runs in OpenMausBot on the user's own computer.");
  });

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
    expect(liveSessionsUrl(openAiLiveEndpoint({}))).toBe("https://api.openai.com/v1/live/sessions");
    expect(liveAttachUrl("sess_1", openAiLiveEndpoint({}))).toBe("wss://api.openai.com/v1/live/sessions/sess_1/attach");
    const env = { OMB_OPENAI_LIVE_URL: "http://127.0.0.1:4555" };
    expect(liveSessionsUrl(openAiLiveEndpoint(env))).toBe("http://127.0.0.1:4555/v1/live/sessions");
    expect(liveAttachUrl("sess_1", openAiLiveEndpoint(env))).toBe("ws://127.0.0.1:4555/v1/live/sessions/sess_1/attach");
  });
  it("ignores an override that is not loopback", () => {
    expect(liveBaseUrl({ OMB_OPENAI_LIVE_URL: "http://evil.example:80" })).toBe("https://api.openai.com");
  });
  it("escapes the session id", () => {
    expect(liveAttachUrl("a/b", openAiLiveEndpoint({}))).toBe("wss://api.openai.com/v1/live/sessions/a%2Fb/attach");
  });
  it("points an Azure call at the resource's v1 API with the deployment as the model", () => {
    const endpoint = azureLiveEndpoint("https://my-res.openai.azure.com", "my-live")!;
    expect(endpoint).toEqual({ provider: "azure", apiBase: "https://my-res.openai.azure.com/openai/v1", model: "my-live" });
    expect(liveSessionsUrl(endpoint)).toBe("https://my-res.openai.azure.com/openai/v1/live/sessions");
    expect(liveAttachUrl("s/1", endpoint)).toBe("wss://my-res.openai.azure.com/openai/v1/live/sessions/s%2F1/attach");
    expect(azureLiveEndpoint("https://my-res.openai.azure.com", "")?.model).toBe(LIVE_MODEL);
  });
});

describe("azureOpenAiRoot", () => {
  it("accepts a resource URL however it is pasted", () => {
    for (const url of [
      "https://my-res.openai.azure.com",
      " https://my-res.openai.azure.com/ ",
      "https://my-res.openai.azure.com/openai/v1",
      "https://my-res.openai.azure.com/openai/v1/live/sessions?api-version=preview",
    ]) expect(azureOpenAiRoot(url), url).toBe("https://my-res.openai.azure.com/openai");
    expect(azureOpenAiRoot("https://proj.services.ai.azure.com")).toBe("https://proj.services.ai.azure.com/openai");
    expect(azureOpenAiRoot("https://res.cognitiveservices.azure.com/")).toBe("https://res.cognitiveservices.azure.com/openai");
    expect(azureOpenAiRoot("https://gw.azure-api.net/team-a/openai/v1")).toBe("https://gw.azure-api.net/team-a/openai");
  });
  it("refuses anything the key must not be sent to", () => {
    for (const url of [
      undefined,
      "",
      "my-res.openai.azure.com",
      "http://my-res.openai.azure.com",
      "https://openai.azure.com",
      "https://my-res.openai.azure.com.evil.example",
      "https://evil.example/my-res.openai.azure.com",
      "https://user:pw@my-res.openai.azure.com",
      "https://api.openai.com",
    ]) expect(azureOpenAiRoot(url), String(url)).toBeNull();
  });
  it("refuses a deployment name Azure could not have", () => {
    expect(azureLiveEndpoint("https://my-res.openai.azure.com", "bad name/../x")).toBeNull();
  });
});

describe("the key on real connections, to a loopback server", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });
  const listen = async (onRequest: RequestListener, onUpgrade?: (req: IncomingMessage, socket: Duplex) => void) => {
    const server = createServer(onRequest);
    if (onUpgrade) server.on("upgrade", onUpgrade);
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return (server.address() as AddressInfo).port;
  };
  const azureAt = (port: number): LiveEndpoint => ({ provider: "azure", apiBase: `http://127.0.0.1:${port}/openai/v1`, model: "dep" });
  const openAiAt = (port: number): LiveEndpoint => ({ provider: "openai", apiBase: `http://127.0.0.1:${port}/v1`, model: "dep" });
  const sessionAt = (endpoint: LiveEndpoint) => createLiveSession({ key: "made-up-key", endpoint, sdp: OFFER, bot: BOT, history: [], cloudHome: false });

  it("refuses a redirect on Azure, so api-key never reaches another host", async () => {
    const reached: IncomingMessage[] = [];
    const other = await listen((req, res) => { reached.push(req); res.end("{}"); });
    const first = await listen((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${other}/elsewhere` }).end(); });
    await expect(sessionAt(azureAt(first))).rejects.toMatchObject({ status: 502 });
    expect(reached).toEqual([]);
  });

  it("asks fetch to refuse redirects on Azure, and leaves OpenAI's request as it was", async () => {
    const fetchImpl = okFetch();
    const session = { key: "k", sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl };
    await createLiveSession({ ...session, endpoint: azureLiveEndpoint("https://my-res.openai.azure.com", "dep")! });
    await createLiveSession({ ...session, endpoint: openAiLiveEndpoint({}) });
    expect(fetchImpl.mock.calls.map(([, init]) => init?.redirect)).toEqual(["error", undefined]);
  });

  const attempt = (url: string, endpoint: LiveEndpoint) => new Promise<void>((settled) => {
    const socket = openLiveSocket(url, "made-up-key", endpoint);
    socket.onerror = () => settled();
    socket.onclose = () => settled();
  });

  it("sends the sideband's key as api-key on Azure and as a bearer token on OpenAI", async () => {
    const heard: IncomingMessage["headers"][] = [];
    const port = await listen(() => {}, (req, socket) => {
      heard.push(req.headers);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await attempt(liveAttachUrl("sess_1", azureAt(port)), azureAt(port));
    await attempt(liveAttachUrl("sess_1", openAiAt(port)), openAiAt(port));
    expect(heard.map((headers) => [headers["api-key"], headers.authorization])).toEqual([["made-up-key", undefined], [undefined, "Bearer made-up-key"]]);
  });

  it("never follows a redirect on the sideband, so its api-key stays with the first host", async () => {
    const reached: string[] = [];
    const other = await listen((req, res) => { reached.push(String(req.url)); res.end(); }, (req, socket) => { reached.push(String(req.url)); socket.destroy(); });
    const first = await listen(() => {}, (_req, socket) => {
      socket.end(`HTTP/1.1 307 Temporary Redirect\r\nLocation: ws://127.0.0.1:${other}/elsewhere\r\nConnection: close\r\n\r\n`);
    });
    await attempt(liveAttachUrl("sess_1", azureAt(first)), azureAt(first));
    expect(reached).toEqual([]);
  });
});

describe("createLiveSession on Azure", () => {
  it("sends the resource key as api-key, never as a bearer token, and the deployment as the model", async () => {
    const fetchImpl = okFetch();
    const endpoint = azureLiveEndpoint("https://my-res.openai.azure.com", "live-prod")!;
    const result = await createLiveSession({ key: " azure-secret ", endpoint, sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl });
    expect(result).toEqual({ sessionId: "live_123", sdp: "v=0 answer" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://my-res.openai.azure.com/openai/v1/live/sessions");
    const headers = init!.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("azure-secret");
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(init?.body));
    expect(body.session.model).toBe("live-prod");
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.session.client).toBeUndefined();
    expect(String(init?.body)).not.toContain("azure-secret");
  });
  it("names Azure in its errors", async () => {
    const endpoint = azureLiveEndpoint("https://my-res.openai.azure.com", undefined)!;
    const refuse = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(createLiveSession({ key: "k", endpoint, sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: refuse }))
      .rejects.toMatchObject({ status: 502, message: expect.stringContaining("deployment") });
    expect(liveErrorMessage(401, undefined, "azure")).toMatch(/^Azure OpenAI rejected the API key/);
  });
});

describe("liveErrorMessage", () => {
  it("blames the voice only when OpenAI names the voice", () => {
    expect(liveErrorMessage(400, "session.audio.output.voice")).toMatch(/voice/);
    expect(liveErrorMessage(400, "session.client")).not.toMatch(/voice/);
    expect(liveErrorMessage(400)).toMatch(/call settings/);
  });
});

describe("spokenHangUp", () => {
  it("accepts only a whole, clear request to end the call", () => {
    for (const text of ["hang up", "Hang up.", "please hang up", "you can hang up now", "okay, bye, hang up", "thanks, you can end the call now",
      "end the call", "End call please", "can you hang up?", "go ahead and end this call", "let's end the call. Bye!", "um, hang up the call", "that\u2019s all, let\u2019s end the call"]) {
      expect(spokenHangUp(text), text).toBe(true);
    }
    for (const text of ["", "bye", "goodbye", "thanks", "don't hang up", "please don't end the call", "no, hang up", "how do I end the call?",
      "hang up the poster", "hang up on him", "end the call with Sam", "what's the weather, then hang up", "end it", "should I hang up?"]) {
      expect(spokenHangUp(text), text).toBe(false);
    }
  });

  it("tells the voice to delegate a hang-up request and never to end a call on its own", () => {
    expect(liveInstructions({ name: "Rigel" })).toContain("- The user clearly asks you to hang up or end the call. Never end or offer to end the call on your own.");
  });
});
