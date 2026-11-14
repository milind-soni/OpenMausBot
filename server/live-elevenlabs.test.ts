import { describe, expect, it, vi } from "vitest";
import { createElevenLabsLiveSession, elevenLabsErrorMessage, elevenLabsLiveEndpoint, setUpElevenLabsAgent, usableElevenLabsAgent } from "./live-elevenlabs.ts";
import { FISH_DELEGATE_TOOL, fishKeyPrint } from "./live-fish.ts";
import { LiveSessionError } from "./live-call.ts";

const NOW = Date.parse("2026-11-14T10:00:00Z");
const SIGNED = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&conversation_signature=sig";

function fakeElevenLabs(answers: Record<string, () => Response> = {}) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const answer = answers[path];
    if (answer) return answer();
    if (path.endsWith("/tools")) return Response.json({ id: "tool_1" });
    if (path.endsWith("/agents/create")) return Response.json({ agent_id: "agent_1" });
    return Response.json({ signed_url: SIGNED });
  });
}

const create = (fetchImpl: typeof fetch, endpoint = elevenLabsLiveEndpoint("agent_1", {}), key = " eleven-secret ") =>
  createElevenLabsLiveSession({ key, endpoint, bot: { name: "Rigel" }, history: [{ role: "user", text: "hi there" }], cloudHome: false, fetchImpl, now: () => NOW });

describe("ElevenLabs Live endpoint", () => {
  it("talks to ElevenLabs' Agents API with the saved agent, or none yet", () => {
    expect(elevenLabsLiveEndpoint("agent_1", {})).toEqual({ provider: "elevenlabs", apiBase: "https://api.elevenlabs.io/v1/convai", model: "agent_1" });
    expect(elevenLabsLiveEndpoint("../evil", {}).model).toBe("");
    expect(elevenLabsLiveEndpoint(undefined, {}).model).toBe("");
  });

  it("uses the ElevenLabs API root ElevenLabs voices use", () => {
    expect(elevenLabsLiveEndpoint("agent_1", { OMB_ELEVENLABS_API: "http://127.0.0.1:9124/v1/" }).apiBase).toBe("http://127.0.0.1:9124/v1/convai");
  });

  it("uses a saved agent only with the key of the account it was set up on", () => {
    const live = { elevenlabsAgentId: "agent_1", elevenlabsAgentFor: fishKeyPrint("eleven-secret") };
    expect(usableElevenLabsAgent(live, " eleven-secret ")).toBe("agent_1");
    expect(usableElevenLabsAgent(live, "another-key")).toBeNull();
    expect(usableElevenLabsAgent({ elevenlabsAgentId: "agent_1" }, "eleven-secret")).toBeNull();
    expect(usableElevenLabsAgent(live, "")).toBeNull();
  });
});

describe("an ElevenLabs agent for Live calls", () => {
  it("is set up with the delegate client tool and a prompt each conversation may override", async () => {
    const fetchImpl = fakeElevenLabs();
    expect(await setUpElevenLabsAgent(" eleven-secret ", elevenLabsLiveEndpoint(null, {}), "OpenMausBot", fetchImpl)).toBe("agent_1");
    const [[toolUrl, toolInit], [agentUrl, agentInit]] = fetchImpl.mock.calls;
    expect(String(toolUrl)).toBe("https://api.elevenlabs.io/v1/convai/tools");
    expect(toolInit!.headers).toMatchObject({ "xi-api-key": "eleven-secret" });
    expect(JSON.parse(String(toolInit!.body)).tool_config).toMatchObject({ type: "client", name: FISH_DELEGATE_TOOL, expects_response: true });
    expect(String(agentUrl)).toBe("https://api.elevenlabs.io/v1/convai/agents/create");
    const agent = JSON.parse(String(agentInit!.body));
    expect(agent).toMatchObject({
      name: "OpenMausBot Live calls",
      conversation_config: { agent: { prompt: { tool_ids: ["tool_1"] } }, asr: { user_input_audio_format: "pcm_16000" }, tts: { agent_output_audio_format: "pcm_16000" } },
      platform_settings: { overrides: { conversation_config_override: { agent: { prompt: { prompt: true } } } }, auth: { enable_auth: true } },
    });
    expect(agent.conversation_config.conversation.client_events).toEqual(expect.arrayContaining(["client_tool_call", "audio", "interruption", "user_transcript", "agent_response", "agent_response_complete", "ping"]));
    expect(agent.conversation_config.conversation.max_duration_seconds).toBe(3600);
  });

  it("fails with words for the person, never ElevenLabs' body, when ElevenLabs refuses or answers oddly", async () => {
    const refused = fakeElevenLabs({ "/v1/convai/tools": () => new Response("secret detail", { status: 401 }) });
    await expect(setUpElevenLabsAgent("k", elevenLabsLiveEndpoint(null, {}), "P", refused)).rejects.toMatchObject({ status: 502, message: elevenLabsErrorMessage(401) });
    const odd = fakeElevenLabs({ "/v1/convai/agents/create": () => Response.json({ agent_id: "../x" }) });
    await expect(setUpElevenLabsAgent("k", elevenLabsLiveEndpoint(null, {}), "P", odd)).rejects.toBeInstanceOf(LiveSessionError);
  });

  it("removes the tool again when the agent is not created", async () => {
    const fetchImpl = fakeElevenLabs({ "/v1/convai/agents/create": () => new Response("", { status: 500 }), "/v1/convai/tools/tool_1": () => new Response(null, { status: 204 }) });
    await expect(setUpElevenLabsAgent("k", elevenLabsLiveEndpoint(null, {}), "P", fetchImpl)).rejects.toMatchObject({ status: 502 });
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/convai/tools/tool_1");
    expect(init).toMatchObject({ method: "DELETE", headers: { "xi-api-key": "k" } });
  });
});

describe("an ElevenLabs Live call's session", () => {
  it("asks for a signed URL with the key in a header and answers with it and the call's instructions, never the key", async () => {
    const fetchImpl = fakeElevenLabs();
    const session = await create(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_1");
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { "xi-api-key": "eleven-secret" } });
    expect(JSON.stringify(session)).not.toContain("eleven-secret");
    expect(session).toEqual({
      session_id: expect.stringMatching(/^elevenlabs_[0-9a-f]{24}$/),
      signed_url: SIGNED,
      instructions: expect.stringContaining("Rigel"),
      expires_at: "2026-11-14T10:01:00.000Z",
    });
    expect(session.instructions).toContain(`\`${FISH_DELEGATE_TOOL}\``);
    expect(session.instructions).toContain("User: hi there");
  });

  it("takes a loopback ws URL only from a loopback override", async () => {
    const local = "ws://127.0.0.1:9124/v1/convai/conversation?agent_id=agent_1";
    const fetchImpl = fakeElevenLabs({ "/v1/convai/conversation/get-signed-url": () => Response.json({ signed_url: local }) });
    const loopback = elevenLabsLiveEndpoint("agent_1", { OMB_ELEVENLABS_API: "http://127.0.0.1:9124/v1" });
    expect((await create(fetchImpl, loopback)).signed_url).toBe(local);
    await expect(create(fetchImpl)).rejects.toMatchObject({ status: 502 });
  });

  it("refuses a missing key before asking ElevenLabs", async () => {
    const fetchImpl = fakeElevenLabs();
    await expect(create(fetchImpl, undefined, " ")).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says when the agent is gone, so it can be set up again", async () => {
    const fetchImpl = fakeElevenLabs({ "/v1/convai/conversation/get-signed-url": () => new Response("{}", { status: 404 }) });
    await expect(create(fetchImpl)).rejects.toMatchObject({ elevenlabsStatus: 404, message: elevenLabsErrorMessage(404) });
  });

  it("keeps a rate limit as a rate limit", async () => {
    const fetchImpl = fakeElevenLabs({ "/v1/convai/conversation/get-signed-url": () => new Response("{}", { status: 429 }) });
    await expect(create(fetchImpl)).rejects.toMatchObject({ status: 429 });
  });
});
