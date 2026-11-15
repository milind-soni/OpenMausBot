import { describe, expect, it, vi } from "vitest";
import { fishKeyPrint, fishLiveEndpoint } from "./live-fish.ts";
import { elevenLabsLiveEndpoint } from "./live-elevenlabs.ts";
import { liveSessionWiring } from "./live-session-wiring.ts";

const TOKEN = { transport: "livekit", session_id: "sess_1", expires_at: "x", max_duration_seconds: 900, livekit_url: "wss://lk.fish.audio", token: "jwt" };

function fakeFish({ goneAgents = [] as string[] } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = `${init!.method} ${String(url).replace("https://api.fish.audio/v1/agent", "")}`;
    if (route === "POST /sessions") {
      const agent = JSON.parse(String(init!.body)).agent_id as string;
      return goneAgents.includes(agent) ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(TOKEN), { status: 201 });
    }
    const answers: Record<string, unknown> = { "POST /tools": { tool_id: "tool_1" }, "POST /agents": { agent_id: "agent_new" } };
    return new Response(JSON.stringify(answers[route] ?? {}), { status: 200 });
  });
}

function wiring(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}) {
  const saveAgent = vi.fn();
  const wired = liveSessionWiring({ bot: () => ({ name: "Rigel" }), history: () => [], cloudHome: false, othersOnLoopback: () => false, saveAgent, productName: () => "Acme", env, fetchImpl });
  return { ...wired, saveAgent };
}

const start = { key: "fish-key", sdp: "", botId: "b1", threadId: "t1", voice: "agent" };
const routes = (fetchImpl: ReturnType<typeof fakeFish>) => fetchImpl.mock.calls.map(([url, init]) => `${init!.method} ${String(url).replace("https://api.fish.audio/v1/agent", "")}`);

describe("a Fish Audio call's session", () => {
  it("sets up an agent on the first call, saves it for that key's account, and answers with a relay", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl);
    const answer = await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("", {}) });
    expect(routes(fetchImpl)).toEqual(["POST /tools", "POST /agents", "PATCH /agents/agent_new", "POST /agents/agent_new/publish", "POST /sessions"]);
    expect(w.saveAgent).toHaveBeenCalledWith({ fishAgentId: "agent_new", fishAgentFor: fishKeyPrint("fish-key") });
    const created = fetchImpl.mock.calls.find(([url, init]) => init!.method === "POST" && String(url).endsWith("/agents"))!;
    expect(JSON.parse(String(created[1]!.body)).name).toBe("Acme Live calls");
    expect(answer).toMatchObject({ sessionId: "sess_1", fish: { type: "fish", session: TOKEN } });
    const relayToken = (answer as { fish: { relayToken: string } }).fish.relayToken;
    expect(w.fishRelay("sess_1", relayToken)).not.toBeNull();
    expect(w.fishRelay("sess_1", "guessed")).toBeNull();
  });

  it("starts the saved agent without setting one up", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl);
    await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) });
    expect(routes(fetchImpl)).toEqual(["POST /sessions"]);
    expect(w.saveAgent).not.toHaveBeenCalled();
  });

  it("sets up a new agent once when the saved one is gone on Fish Audio", async () => {
    const fetchImpl = fakeFish({ goneAgents: ["agent_saved"] });
    const w = wiring(fetchImpl);
    await expect(w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) })).resolves.toMatchObject({ sessionId: "sess_1" });
    expect(routes(fetchImpl)).toEqual(["POST /sessions", "POST /tools", "POST /agents", "PATCH /agents/agent_new", "POST /agents/agent_new/publish", "POST /sessions"]);
    expect(w.saveAgent).toHaveBeenCalledTimes(1);
  });

  it("never replaces an agent the operator chose", async () => {
    const fetchImpl = fakeFish({ goneAgents: ["agent_op"] });
    const w = wiring(fetchImpl, { OMB_FISH_LIVE_AGENT_ID: "agent_op" });
    await expect(w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_op", {}) })).rejects.toMatchObject({ status: 502 });
    expect(routes(fetchImpl)).toEqual(["POST /sessions"]);
    expect(w.saveAgent).not.toHaveBeenCalled();
  });

  it("follows the call through its relay, not a socket to Fish", () => {
    const w = wiring(fakeFish());
    const endpoint = fishLiveEndpoint("agent_1", {});
    expect(w.calls.attachUrl("sess_9", endpoint)).toBe("sess_9");
    expect(() => w.calls.openSocket("sess_9", "k", endpoint)).toThrow("no relay for that session");
  });
});

describe("a Gemini Live call's session", () => {
  const gemini = { provider: "gemini" as const, apiBase: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.8-live" };

  it("takes a token from Gemini and answers with it and a relay, never the key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/t1" }), { status: 200 }));
    const w = wiring(fetchImpl as unknown as typeof fetch);
    const answer = await w.calls.createSession({ ...start, key: "gemini-secret", endpoint: gemini });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({ gemini: { type: "gemini", session: { token: "auth_tokens/t1" } } });
    expect(JSON.stringify(answer)).not.toContain("gemini-secret");
    const { session, relayToken } = (answer as { gemini: { session: { session_id: string }; relayToken: string } }).gemini;
    expect(answer.sessionId).toBe(session.session_id);
    expect(w.fishRelay(session.session_id, relayToken)).not.toBeNull();
    expect(w.calls.attachUrl(session.session_id, gemini)).toBe(session.session_id);
    expect(w.calls.openSocket(session.session_id, "k", gemini)).toBeTruthy();
  });

  it("asks who is calling as for Fish Audio", () => {
    const w = wiring(fakeFish());
    expect(w.calls.geminiRefusal({ kind: "loopback", scopes: ["admin", "client"] })).toBeNull();
  });
});

describe("an ElevenLabs call's session", () => {
  const SIGNED = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_new&conversation_signature=s";
  function fakeElevenLabs({ goneAgents = [] as string[] } = {}) {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const { pathname, searchParams } = new URL(String(url));
      if (pathname.endsWith("/tools")) return Response.json({ id: "tool_1" });
      if (pathname.endsWith("/agents/create")) return Response.json({ agent_id: "agent_new" });
      const agent = searchParams.get("agent_id") ?? "";
      return goneAgents.includes(agent) ? new Response("{}", { status: 404 }) : Response.json({ signed_url: SIGNED });
    });
  }
  const paths = (fetchImpl: ReturnType<typeof fakeElevenLabs>) => fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname.replace("/v1/convai", ""));
  const eleven = { ...start, key: "eleven-key" };

  it("sets up an agent on the first call, saves it for that key's account, and answers with a relay, never the key", async () => {
    const fetchImpl = fakeElevenLabs();
    const w = wiring(fetchImpl as unknown as typeof fetch);
    const answer = await w.calls.createSession({ ...eleven, endpoint: elevenLabsLiveEndpoint(null, {}) });
    expect(paths(fetchImpl)).toEqual(["/tools", "/agents/create", "/conversation/get-signed-url"]);
    expect(w.saveAgent).toHaveBeenCalledWith({ elevenlabsAgentId: "agent_new", elevenlabsAgentFor: fishKeyPrint("eleven-key") });
    expect(answer).toMatchObject({ elevenlabs: { type: "elevenlabs", session: { signed_url: SIGNED } } });
    expect(JSON.stringify(answer)).not.toContain("eleven-key");
    const { session, relayToken } = (answer as { elevenlabs: { session: { session_id: string }; relayToken: string } }).elevenlabs;
    expect(answer.sessionId).toBe(session.session_id);
    expect(w.fishRelay(session.session_id, relayToken)).not.toBeNull();
    expect(w.calls.attachUrl(session.session_id, elevenLabsLiveEndpoint("agent_new", {}))).toBe(session.session_id);
  });

  it("uses the saved agent without setting one up", async () => {
    const fetchImpl = fakeElevenLabs();
    const w = wiring(fetchImpl as unknown as typeof fetch);
    await w.calls.createSession({ ...eleven, endpoint: elevenLabsLiveEndpoint("agent_1", {}) });
    expect(paths(fetchImpl)).toEqual(["/conversation/get-signed-url"]);
    expect(w.saveAgent).not.toHaveBeenCalled();
  });

  it("sets the agent up again when it was removed on ElevenLabs", async () => {
    const fetchImpl = fakeElevenLabs({ goneAgents: ["agent_old"] });
    const w = wiring(fetchImpl as unknown as typeof fetch);
    await w.calls.createSession({ ...eleven, endpoint: elevenLabsLiveEndpoint("agent_old", {}) });
    expect(paths(fetchImpl)).toEqual(["/conversation/get-signed-url", "/tools", "/agents/create", "/conversation/get-signed-url"]);
    expect(w.saveAgent).toHaveBeenCalledTimes(1);
  });

  it("asks who is calling as for Fish Audio", () => {
    const w = wiring(fakeFish());
    expect(w.calls.elevenlabsRefusal({ kind: "loopback", scopes: ["admin", "client"] })).toBeNull();
  });
});
