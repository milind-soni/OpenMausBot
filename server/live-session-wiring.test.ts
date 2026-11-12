import { describe, expect, it, vi } from "vitest";
import { fishKeyPrint, fishLiveEndpoint } from "./live-fish.ts";
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
  const saveFishAgent = vi.fn();
  const wired = liveSessionWiring({ bot: () => ({ name: "Rigel" }), history: () => [], cloudHome: false, othersOnLoopback: () => false, saveFishAgent, productName: () => "Acme", env, fetchImpl });
  return { ...wired, saveFishAgent };
}

const start = { key: "fish-key", sdp: "", botId: "b1", threadId: "t1", voice: "agent" };
const routes = (fetchImpl: ReturnType<typeof fakeFish>) => fetchImpl.mock.calls.map(([url, init]) => `${init!.method} ${String(url).replace("https://api.fish.audio/v1/agent", "")}`);

describe("a Fish Audio call's session", () => {
  it("sets up an agent on the first call, saves it for that key's account, and answers with a relay", async () => {
    const fetchImpl = fakeFish();
    const w = wiring(fetchImpl);
    const answer = await w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("", {}) });
    expect(routes(fetchImpl)).toEqual(["POST /tools", "POST /agents", "PATCH /agents/agent_new", "POST /agents/agent_new/publish", "POST /sessions"]);
    expect(w.saveFishAgent).toHaveBeenCalledWith({ fishAgentId: "agent_new", fishAgentFor: fishKeyPrint("fish-key") });
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
    expect(w.saveFishAgent).not.toHaveBeenCalled();
  });

  it("sets up a new agent once when the saved one is gone on Fish Audio", async () => {
    const fetchImpl = fakeFish({ goneAgents: ["agent_saved"] });
    const w = wiring(fetchImpl);
    await expect(w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_saved", {}) })).resolves.toMatchObject({ sessionId: "sess_1" });
    expect(routes(fetchImpl)).toEqual(["POST /sessions", "POST /tools", "POST /agents", "PATCH /agents/agent_new", "POST /agents/agent_new/publish", "POST /sessions"]);
    expect(w.saveFishAgent).toHaveBeenCalledTimes(1);
  });

  it("never replaces an agent the operator chose", async () => {
    const fetchImpl = fakeFish({ goneAgents: ["agent_op"] });
    const w = wiring(fetchImpl, { OMB_FISH_LIVE_AGENT_ID: "agent_op" });
    await expect(w.calls.createSession({ ...start, endpoint: fishLiveEndpoint("agent_op", {}) })).rejects.toMatchObject({ status: 502 });
    expect(routes(fetchImpl)).toEqual(["POST /sessions"]);
    expect(w.saveFishAgent).not.toHaveBeenCalled();
  });

  it("follows the call through its relay, not a socket to Fish", () => {
    const w = wiring(fakeFish());
    const endpoint = fishLiveEndpoint("agent_1", {});
    expect(w.calls.attachUrl("sess_9", endpoint)).toBe("sess_9");
    expect(() => w.calls.openSocket("sess_9", "k", endpoint)).toThrow("no relay for that session");
  });
});
