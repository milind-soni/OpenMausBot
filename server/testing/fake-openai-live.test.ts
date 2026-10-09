import { afterEach, describe, expect, it } from "vitest";
import { fakeAnswerSdp, startFakeOpenAiLive, type FakeOpenAiLive } from "./fake-openai-live.ts";

let fake: FakeOpenAiLive | undefined;
afterEach(async () => { await fake?.stop(); fake = undefined; });

async function create(url: string, key = "sk-fake") {
  return fetch(`${url}/v1/live/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ session: { model: "gpt-live-1" }, transport: { type: "webrtc", sdp: "v=0\r\n" } }),
  });
}

function attach(url: string, id: string, key = "sk-fake") {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/v1/live/sessions/${id}/attach`, { headers: { authorization: `Bearer ${key}` } } as never);
  const received: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (event) => received.push(JSON.parse(String((event as MessageEvent).data))));
  return { ws, received };
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("fake GPT-Live", () => {
  it("creates a session and records the body", async () => {
    fake = await startFakeOpenAiLive();
    const response = await create(fake.url);
    expect(response.status).toBe(201);
    const payload = await response.json() as { session: { id: string }; transport: { sdp: string } };
    expect(payload.session.id).toMatch(/^sess_fake_/);
    expect(payload.transport.sdp).toContain("v=0");
    expect(fake.sessions[0].body).toMatchObject({ session: { model: "gpt-live-1" } });
  });

  it("refuses a create without a key and can fail on demand", async () => {
    fake = await startFakeOpenAiLive();
    expect((await create(fake.url, "")).status).toBe(401);
    fake.failNextCreate(400, { error: { param: "session.audio.output.voice" } });
    expect((await create(fake.url)).status).toBe(400);
  });

  it("attaches a sideband, plays events and records commands", async () => {
    fake = await startFakeOpenAiLive();
    const { session } = await (await create(fake.url)).json() as { session: { id: string } };
    const { ws, received } = attach(fake.url, session.id);
    await fake.waitForAttach(session.id);
    await until(() => received.some((e) => e.type === "session.started"));
    fake.emit(session.id, { type: "session.input_transcript.delta", delta: "hello", start_ms: 10, end_ms: 20 });
    await until(() => received.some((e) => e.type === "session.input_transcript.delta"));
    ws.send(JSON.stringify({ type: "session.thinking.append", delegation_id: null, content: "x".repeat(70_000) }));
    const command = await fake.waitForCommand(session.id, (c) => c.type === "session.thinking.append");
    expect(String(command.content)).toHaveLength(70_000);
    ws.send(JSON.stringify({ type: "session.close" }));
    await until(() => received.some((e) => e.type === "session.closed"));
    await until(() => ws.readyState === WebSocket.CLOSED);
  });

  it("refuses an attach with an HTTP status and can drop the socket", async () => {
    fake = await startFakeOpenAiLive();
    const { session } = await (await create(fake.url)).json() as { session: { id: string } };
    fake.refuseNextAttach(404);
    const refused = attach(fake.url, session.id);
    const errored = new Promise<void>((resolve) => refused.ws.addEventListener("error", () => resolve()));
    await errored;
    const { ws } = attach(fake.url, session.id);
    await fake.waitForAttach(session.id);
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
    fake.dropSideband(session.id);
    await closed;
  });
});

// A browser's offer: audio (Opus first) and the events data channel, bundled.
const OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS stream",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:0123456789abcdefghijklmn",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 AA:BB",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:9 G722/8000",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:0123456789abcdefghijklmn",
  "a=fingerprint:sha-256 AA:BB",
  "a=setup:actpass",
  "a=mid:1",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "",
].join("\r\n");

describe("fake GPT-Live answer", () => {
  const lines = (sdp: string) => sdp.split("\r\n").filter(Boolean);

  it("answers every offered section in order, with the same mids, bundled", () => {
    const answer = fakeAnswerSdp(OFFER);
    expect(answer.endsWith("\r\n")).toBe(true);
    // CRLF only: no bare LF anywhere
    expect(answer.replaceAll("\r\n", "")).not.toContain("\n");
    const all = lines(answer);
    expect(all.slice(0, 4)).toEqual(["v=0", expect.stringMatching(/^o=- \d+ 2 IN IP4 127\.0\.0\.1$/), "s=-", "t=0 0"]);
    expect(all).toContain("a=group:BUNDLE 0 1");
    expect(all.filter((line) => line.startsWith("m="))).toEqual([
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    ]);
    expect(all.filter((line) => line.startsWith("a=mid:"))).toEqual(["a=mid:0", "a=mid:1"]);
  });

  it("takes the offer's first audio codec and the data channel's settings, and plays the active DTLS side", () => {
    const answer = fakeAnswerSdp(OFFER);
    const [audio, application] = answer.split("\r\nm=").slice(1).map((section) => lines(`m=${section}`));
    expect(audio).toEqual(expect.arrayContaining(["a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1", "a=rtcp-mux", "a=sendrecv", "a=setup:active"]));
    expect(audio.some((line) => line.startsWith("a=rtpmap:63") || line.startsWith("a=rtpmap:9 "))).toBe(false);
    expect(application).toEqual(expect.arrayContaining(["a=sctp-port:5000", "a=max-message-size:262144", "a=setup:active"]));
    for (const section of [audio, application]) {
      expect(section).toContain("a=candidate:1 1 udp 2122260223 127.0.0.1 9 typ host");
      expect(section.at(-1)).toBe("a=end-of-candidates");
      expect(section.find((line) => line.startsWith("a=ice-ufrag:"))).toMatch(/^a=ice-ufrag:[0-9a-f]{8}$/);
      expect(section.find((line) => line.startsWith("a=ice-pwd:"))).toMatch(/^a=ice-pwd:[0-9a-f]{32}$/);
      expect(section.find((line) => line.startsWith("a=fingerprint:"))).toMatch(/^a=fingerprint:sha-256 [0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    }
    // its own credentials, not the offer's
    expect(answer).not.toContain("a=ice-ufrag:abcd");
    expect(fakeAnswerSdp(OFFER)).not.toBe(answer);
  });

  it("rejects media it does not speak and mirrors a one-way direction", () => {
    const offer = OFFER.replace("m=application", "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:2\r\nm=application").replace("a=sendrecv", "a=sendonly");
    const all = lines(fakeAnswerSdp(offer));
    expect(all.filter((line) => line.startsWith("m="))).toEqual([
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "m=video 0 UDP/TLS/RTP/SAVPF 96",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    ]);
    expect(all.filter((line) => line.startsWith("a=mid:"))).toEqual(["a=mid:0", "a=mid:2", "a=mid:1"]);
    expect(all).toContain("a=group:BUNDLE 0 1");
    expect(all).toContain("a=recvonly");
  });

  it("answers an offer without media with session lines only", () => {
    expect(lines(fakeAnswerSdp("v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))).toHaveLength(4);
  });

  it("answers a create with the answer to its own offer", async () => {
    fake = await startFakeOpenAiLive();
    const response = await fetch(`${fake.url}/v1/live/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer sk-fake", "content-type": "application/json" },
      body: JSON.stringify({ session: { model: "gpt-live-1" }, transport: { type: "webrtc", sdp: OFFER } }),
    });
    const { transport } = await response.json() as { transport: { sdp: string } };
    expect(lines(transport.sdp).filter((line) => line.startsWith("a=mid:"))).toEqual(["a=mid:0", "a=mid:1"]);
  });
});
