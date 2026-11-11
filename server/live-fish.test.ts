import { describe, expect, it, vi } from "vitest";
import { LiveSessionError } from "./live-call.ts";
import {
  createFishLiveSession, endFishLiveSession, fishErrorMessage, fishInstructions, fishLiveBaseUrl, fishLiveEndpoint, FishRelays,
  FISH_UPDATE_PREFIX, isFishAgentId,
} from "./live-fish.ts";

const ENDPOINT = fishLiveEndpoint("agent_123", {})!;
const TOKEN = {
  transport: "livekit", session_id: "sess_1", expires_at: "2026-11-11T00:00:00Z", max_duration_seconds: 900,
  livekit_url: "wss://lk.fish.audio", token: "jwt.part.sig",
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(status === 204 ? null : JSON.stringify(body), { status }));
}

describe("the Fish Audio endpoint", () => {
  it("is Fish's API unless a loopback http override is set", () => {
    expect(fishLiveBaseUrl({})).toBe("https://api.fish.audio");
    expect(fishLiveBaseUrl({ OMB_FISH_LIVE_URL: "http://127.0.0.1:4555" })).toBe("http://127.0.0.1:4555");
    for (const url of ["https://evil.example", "http://127.0.0.1.evil.example:80", "http://localhost:80", "http://127.0.0.1:80/x"]) {
      expect(fishLiveBaseUrl({ OMB_FISH_LIVE_URL: url }), url).toBe("https://api.fish.audio");
    }
  });

  it("needs an agent id of word characters and dashes", () => {
    expect(ENDPOINT).toEqual({ provider: "fish", apiBase: "https://api.fish.audio/v1/agent", model: "agent_123" });
    expect(fishLiveEndpoint(" agent-9 ", {})?.model).toBe("agent-9");
    for (const id of [undefined, "", "  ", "a/b", "../x", "a b", "x".repeat(129)]) expect(fishLiveEndpoint(id, {}), String(id)).toBeNull();
    expect(isFishAgentId("ok_id-1")).toBe(true);
    expect(isFishAgentId("no?query")).toBe(false);
  });
});

describe("the Fish agent's instructions", () => {
  it("explain the delegate tool and the update prefix, and carry recent history within bounds", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, text: `message ${i} ${"x".repeat(900)}` }));
    const text = fishInstructions({ name: "Rigel" }, history);
    expect(text).toContain("`delegate` tool");
    expect(text).toContain(FISH_UPDATE_PREFIX);
    expect(text).not.toContain("message 3 ");
    expect(text).toContain("message 11 ");
    expect(text.match(/^(User|You): /gm)).toHaveLength(8);
    expect(text).not.toContain("x".repeat(601));
  });
});

describe("creating a Fish Audio session", () => {
  const input = { key: " fish-key ", endpoint: ENDPOINT, bot: { name: "Rigel" }, history: [], cloudHome: false };

  it("posts the agent and its system prompt with the key as a bearer token, and returns the LiveKit token", async () => {
    const fetchImpl = fakeFetch(201, TOKEN);
    await expect(createFishLiveSession({ ...input, fetchImpl })).resolves.toEqual(TOKEN);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.fish.audio/v1/agent/sessions");
    expect(init!.method).toBe("POST");
    expect(init!.redirect).toBe("error");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer fish-key");
    const body = JSON.parse(String(init!.body));
    expect(body.agent_id).toBe("agent_123");
    expect(body.overrides.system_prompt).toContain("You are Rigel");
    expect(Object.keys(body)).toEqual(["agent_id", "overrides"]);
  });

  it("refuses without a key and never calls Fish", async () => {
    const fetchImpl = fakeFetch(201, TOKEN);
    await expect(createFishLiveSession({ ...input, key: " ", fetchImpl })).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns Fish's errors into the user's next step, never echoing Fish's body or the key", async () => {
    for (const status of [400, 401, 402, 403, 404, 409, 422, 429, 500]) {
      const fetchImpl = fakeFetch(status, { message: "raw fish-key detail" });
      const error = await createFishLiveSession({ ...input, fetchImpl }).catch((caught: unknown) => caught);
      expect(error, String(status)).toBeInstanceOf(LiveSessionError);
      expect((error as LiveSessionError).message).toBe(fishErrorMessage(status));
      expect((error as LiveSessionError).message).not.toContain("fish-key");
      expect((error as LiveSessionError).status).toBe(status === 429 ? 429 : 502);
    }
  });

  it("rejects an answer that is not a LiveKit session with a secure URL", async () => {
    for (const body of [null, {}, { ...TOKEN, transport: "webrtc" }, { ...TOKEN, livekit_url: "http://lk.example" }, { ...TOKEN, token: "" }, { ...TOKEN, session_id: 7 }]) {
      await expect(createFishLiveSession({ ...input, fetchImpl: fakeFetch(201, body) }), JSON.stringify(body)).rejects.toMatchObject({ status: 502 });
    }
  });

  it("reports an unreachable Fish as a gateway error", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(createFishLiveSession({ ...input, fetchImpl })).rejects.toMatchObject({ status: 502, message: "Could not reach Fish Audio. Check the internet connection." });
  });

  it("ends a session by id, and never throws", async () => {
    const fetchImpl = fakeFetch(204, null);
    await expect(endFishLiveSession("sess/1", "fish-key", ENDPOINT, fetchImpl)).resolves.toBe(true);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.fish.audio/v1/agent/sessions/sess%2F1/end");
    await expect(endFishLiveSession("s", "k", ENDPOINT, vi.fn(async () => { throw new Error("down"); }))).resolves.toBe(false);
  });
});

describe("the relay of a Fish call", () => {
  function opened() {
    const relays = new FishRelays();
    const endSession = vi.fn(async () => true);
    const { relay, token } = relays.open("sess_1", endSession);
    const messages: Array<Record<string, unknown>> = [];
    relay.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    const onopen = vi.fn();
    relay.onopen = onopen;
    return { relays, relay, token, endSession, messages, onopen };
  }

  it("is found only with its own token", () => {
    const { relays, relay, token } = opened();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(relays.find("sess_1", token)).toBe(relay);
    expect(relays.find("sess_1", `${token}x`)).toBeNull();
    expect(relays.find("sess_1", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(relays.find("sess_1", "")).toBeNull();
    expect(relays.find("other", token)).toBeNull();
    expect(relays.socket("sess_1")).toBe(relay);
    expect(() => relays.socket("other")).toThrow();
  });

  it("reads the client's reports as GPT-Live sideband events, only once the client has joined", () => {
    const { relay, messages, onopen } = opened();
    relay.receive([{ type: "heard", text: "too early", startMs: 0, endMs: 1 }, { type: "delegate", id: "d1", atMs: 1 }]);
    expect(messages).toEqual([]);
    relay.receive([{ type: "connected" }, { type: "connected" }]);
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(relay.readyState).toBe(1);
    relay.receive([
      { type: "heard", text: "book a table", startMs: 100, endMs: 900 },
      { type: "spoke", startMs: 1000, endMs: 1500 },
      { type: "delegate", id: "call_1", atMs: 950 },
      { type: "error", code: "provider_error" },
      { type: "ended", reason: "agent_hangup" },
    ]);
    expect(messages).toEqual([
      { type: "session.input_transcript.delta", delta: "book a table ", start_ms: 100, end_ms: 900 },
      { type: "session.output_transcript.delta", start_ms: 1000, end_ms: 1500 },
      { type: "session.delegation.created", delegation: { id: "call_1", target: "client" }, offset_ms: 950 },
      { type: "error", error: { code: "provider_error" } },
      { type: "session.closed", reason: "remote_hangup" },
    ]);
  });

  it("maps only known endings to a reason", () => {
    const { relay, messages } = opened();
    relay.receive([{ type: "ended", reason: "user_hangup" }, { type: "ended", reason: "conversation_timeout" }]);
    expect(messages).toEqual([{ type: "session.closed" }, { type: "session.closed", reason: "expired" }]);
  });

  it("queues the controller's appends for the client's poll and wakes a waiting poll", async () => {
    const { relay } = opened();
    const waiting = relay.poll(10_000);
    relay.send(JSON.stringify({ type: "session.instructions.append", delegation_id: "call_1", content: "Booked for 7pm." }));
    relay.send(JSON.stringify({ type: "session.thinking.append", content: "Checking the calendar" }));
    relay.send(JSON.stringify({ type: "session.instructions.append", content: "" }));
    relay.send(JSON.stringify({ type: "session.update", session: {} }));
    relay.send("not json");
    expect(await waiting).toEqual({ commands: [
      { type: "append", kind: "instructions", content: "Booked for 7pm.", delegationId: "call_1" },
      { type: "append", kind: "thinking", content: "Checking the calendar", delegationId: null },
    ], closed: false });
    expect(await relay.poll(0)).toEqual({ commands: [], closed: false });
  });

  it("keeps at most the 50 newest commands", async () => {
    const { relay } = opened();
    for (let i = 0; i < 60; i++) relay.send(JSON.stringify({ type: "session.commentary.append", content: `n${i}` }));
    const { commands } = await relay.poll(0);
    expect(commands).toHaveLength(50);
    expect(commands[0]).toMatchObject({ content: "n10" });
  });

  it("answers an older poll with nothing when a newer one arrives", async () => {
    const { relay } = opened();
    const older = relay.poll(10_000);
    const newer = relay.poll(10_000);
    await expect(older).resolves.toEqual({ commands: [], closed: false });
    relay.send(JSON.stringify({ type: "session.commentary.append", content: "hi" }));
    await expect(newer).resolves.toMatchObject({ commands: [{ content: "hi" }] });
  });

  it("on session.close tells the client to hang up, ends the Fish session once, then reports it closed", async () => {
    const { relay, endSession, messages } = opened();
    relay.receive([{ type: "connected" }]);
    relay.send(JSON.stringify({ type: "session.close" }));
    relay.send(JSON.stringify({ type: "session.close" }));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: "session.closed" }));
    expect(endSession).toHaveBeenCalledTimes(1);
    expect((await relay.poll(0)).commands).toEqual([{ type: "close" }, { type: "close" }]);
  });

  it("when closed ends the session, answers the waiting poll, forgets itself and ignores later reports", async () => {
    const { relays, relay, token, endSession, messages } = opened();
    relay.receive([{ type: "connected" }]);
    const waiting = relay.poll(10_000);
    relay.close();
    await expect(waiting).resolves.toEqual({ commands: [{ type: "close" }], closed: true });
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(relays.find("sess_1", token)).toBeNull();
    relay.receive([{ type: "heard", text: "late", startMs: 0, endMs: 1 }]);
    expect(messages).toEqual([]);
    expect(() => relay.send(JSON.stringify({ type: "session.close" }))).toThrow();
  });

  it("replaces a relay opened again for the same session", () => {
    const relays = new FishRelays();
    const first = relays.open("s", async () => true);
    const second = relays.open("s", async () => true);
    expect(first.relay.readyState).toBe(3);
    expect(relays.find("s", first.token)).toBeNull();
    expect(relays.find("s", second.token)).toBe(second.relay);
  });
});
