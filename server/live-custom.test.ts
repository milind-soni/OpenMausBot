// Live calls through a custom OpenAI-compatible endpoint: the address rules, the key it is tied to, and who may call.
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import { LIVE_CUSTOM_REFUSAL, liveScopeRefusal } from "./live-access.ts";
import {
  createLiveSession,
  customLiveApiBase,
  customLiveEndpoint,
  LIVE_DATA_CHANNEL,
  LIVE_MODEL,
  LIVE_NEEDS_CUSTOM,
  liveAttachUrl,
  liveAuthHeaders,
  liveErrorMessage,
  liveSessionsUrl,
} from "./live-call.ts";
import { LIVE_KEY_NEEDS_CUSTOM_ENDPOINT, liveConfigWithEnv, liveKeyTarget, liveSavePatch, liveSettingEnv, usableLiveKey } from "./live-config.ts";
import { liveCallEndpoint, liveCallKey, liveCallSettings, liveSettingsFor, liveSettingsForClient } from "./live-settings.ts";

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
const BOT = { name: "Ada", title: "Tech Lead", description: "Leads the engineering team." };
const GATEWAY = "https://gateway.example.com/v1";
const custom = { provider: "custom" as const, customEndpoint: GATEWAY, customModel: "gpt-live-1" };
const keyFor = "custom:gateway.example.com";

function okFetch() {
  const answer = { session: { id: "live_9" }, transport: { type: "webrtc", sdp: "v=0 answer" } };
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(answer), { status: 201 }));
}

describe("customLiveApiBase", () => {
  it("accepts the address however it is pasted, and keeps a gateway's own path", () => {
    for (const url of [
      "https://gateway.example.com",
      " https://gateway.example.com/ ",
      "https://gateway.example.com/v1",
      "https://gateway.example.com/v1/",
      "https://gateway.example.com/v1/live/sessions",
    ]) expect(customLiveApiBase(url), url).toBe("https://gateway.example.com/v1");
    expect(customLiveApiBase("https://gw.example.com/team-a/openai/v1")).toBe("https://gw.example.com/team-a/openai/v1");
    expect(customLiveApiBase("https://gw.example.com:8443/proxy")).toBe("https://gw.example.com:8443/proxy/v1");
  });
  it("allows plain http only on this computer's loopback", () => {
    expect(customLiveApiBase("http://127.0.0.1:4555")).toBe("http://127.0.0.1:4555/v1");
    expect(customLiveApiBase("http://localhost:4555/v1")).toBe("http://localhost:4555/v1");
    expect(customLiveApiBase("http://[::1]:4555/v1")).toBe("http://[::1]:4555/v1");
  });
  it("refuses anything the key must not be sent to", () => {
    for (const url of [
      undefined,
      "",
      "gateway.example.com",
      "http://gateway.example.com/v1",
      "http://10.0.0.5:8080/v1",
      "ws://127.0.0.1:4555/v1",
      "ftp://gateway.example.com",
      "https://user:pw@gateway.example.com/v1",
      "https://gateway.example.com/v1?key=x",
      "https://gateway.example.com/v1#x",
    ]) expect(customLiveApiBase(url), String(url)).toBeNull();
  });
  it("points calls at the endpoint with the model, gpt-live-1 when none is saved", () => {
    const endpoint = customLiveEndpoint(GATEWAY, "my-live")!;
    expect(endpoint).toEqual({ provider: "custom", apiBase: GATEWAY, model: "my-live" });
    expect(liveSessionsUrl(endpoint)).toBe("https://gateway.example.com/v1/live/sessions");
    expect(liveAttachUrl("s/1", endpoint)).toBe("wss://gateway.example.com/v1/live/sessions/s%2F1/attach");
    expect(customLiveEndpoint(GATEWAY, "")?.model).toBe(LIVE_MODEL);
    expect(customLiveEndpoint(GATEWAY, "openai/gpt-live-1")?.model).toBe("openai/gpt-live-1");
    expect(customLiveEndpoint(GATEWAY, "bad name")).toBeNull();
    expect(customLiveEndpoint("http://gateway.example.com", "m")).toBeNull();
  });
});

describe("createLiveSession on a custom endpoint", () => {
  it("sends the key as a bearer token, the model, and the client's tool list like OpenAI", async () => {
    const fetchImpl = okFetch();
    const endpoint = customLiveEndpoint(GATEWAY, "my-live")!;
    const result = await createLiveSession({ key: " gw-secret ", endpoint, sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl });
    expect(result).toEqual({ sessionId: "live_9", sdp: "v=0 answer" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://gateway.example.com/v1/live/sessions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer gw-secret");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.session.model).toBe("my-live");
    expect(body.session.client).toEqual({ data_channel: LIVE_DATA_CHANNEL });
    expect(String(init?.body)).not.toContain("gw-secret");
    expect(liveAuthHeaders("custom", "k")).toEqual({ authorization: "Bearer k" });
  });
  it("names the custom endpoint in its errors", async () => {
    const endpoint = customLiveEndpoint(GATEWAY, undefined)!;
    const refuse = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(createLiveSession({ key: "k", endpoint, sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: refuse }))
      .rejects.toMatchObject({ status: 502, message: expect.stringContaining("custom endpoint") });
    expect(liveErrorMessage(401, undefined, "custom")).toMatch(/^The custom endpoint rejected the key/);
    await expect(createLiveSession({ key: "", endpoint, sdp: OFFER, bot: BOT, history: [], cloudHome: false, fetchImpl: refuse }))
      .rejects.toMatchObject({ status: 409, message: LIVE_NEEDS_CUSTOM });
  });

  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });
  it("refuses a redirect, so the key never reaches another host", async () => {
    const reached: IncomingMessage[] = [];
    const listen = async (handler: RequestListener) => {
      const server = createServer(handler);
      servers.push(server);
      await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
      return (server.address() as AddressInfo).port;
    };
    const other = await listen((req, res) => { reached.push(req); res.end("{}"); });
    const first = await listen((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${other}/elsewhere` }).end(); });
    const endpoint = customLiveEndpoint(`http://127.0.0.1:${first}/v1`, "m")!;
    await expect(createLiveSession({ key: "made-up-key", endpoint, sdp: OFFER, bot: BOT, history: [], cloudHome: false })).rejects.toMatchObject({ status: 502 });
    expect(reached).toEqual([]);
  });
});

describe("the key a custom endpoint's calls use", () => {
  it("is only the key saved for that endpoint, never the OpenAI API key", () => {
    const cfg = { live: custom, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveCallKey(cfg)).toBeNull();
    expect(liveCallSettings(cfg)).toMatchObject({ provider: "custom", key: "", setupProblem: LIVE_NEEDS_CUSTOM });
    const saved = { live: { ...custom, key: "gw-secret", keyFor }, openai: { key: "sk-openai" } } as AppConfig;
    expect(liveCallKey(saved)).toEqual({ key: "gw-secret", source: "live" });
    expect(liveCallEndpoint(saved)).toEqual({ provider: "custom", apiBase: GATEWAY, model: "gpt-live-1" });
    expect(liveCallSettings(saved)).toMatchObject({ provider: "custom", key: "gw-secret", setupProblem: null });
    expect(liveSettingsFor(saved)).toMatchObject({ configured: true, keySource: "live", provider: "custom", customEndpoint: GATEWAY, customModel: "gpt-live-1" });
    expect(JSON.stringify(liveSettingsFor(saved))).not.toContain("gw-secret");
  });
  it("is not a key saved for another host, for Azure on the same host, or for OpenAI", () => {
    expect(liveKeyTarget(custom)).toBe(keyFor);
    expect(liveKeyTarget({ provider: "custom", customEndpoint: "nope" })).toBeNull();
    for (const keyForOther of ["openai", "custom:other.example.com", "azure:gateway.example.com", undefined]) {
      expect(usableLiveKey({ ...custom, key: "k", keyFor: keyForOther }), String(keyForOther)).toBeUndefined();
    }
    expect(usableLiveKey({ ...custom, key: "k", keyFor })).toBe("k");
  });
  it("ties a new key to the endpoint and forgets it when the endpoint moves", () => {
    expect(liveSavePatch(custom, { key: "k" })).toEqual({ key: "k", keyFor });
    expect(() => liveSavePatch({ provider: "custom" }, { key: "k" })).toThrow(LIVE_KEY_NEEDS_CUSTOM_ENDPOINT);
    expect(liveSavePatch({ ...custom, key: "k", keyFor }, { customEndpoint: "https://elsewhere.example.com/v1" })).toMatchObject({ key: "", keyFor: "nowhere" });
    expect(liveSavePatch({ ...custom, key: "k", keyFor }, { customModel: "other" })).toEqual({ customModel: "other" });
  });
  it("hides the endpoint and model from a caller without the admin scope", () => {
    const client = liveSettingsForClient(liveSettingsFor({ live: { ...custom, key: "k", keyFor } } as AppConfig));
    expect(client).toEqual({ configured: true, keySource: "live", provider: "custom", voice: "", readTypedReplies: true, idleMinutes: 5 });
  });
});

describe("a custom endpoint from the environment", () => {
  it("reads the endpoint and model, and pairs a key set beside them", () => {
    const env = { OMB_LIVE_PROVIDER: "custom", OMB_CUSTOM_LIVE_ENDPOINT: ` ${GATEWAY} `, OMB_CUSTOM_LIVE_MODEL: "m", OMB_OPENAI_LIVE_KEY: "gw" };
    expect(liveConfigWithEnv(undefined, env)).toEqual({ provider: "custom", customEndpoint: GATEWAY, customModel: "m", key: "gw", keyFor });
    expect(liveConfigWithEnv({ keyFor: "nowhere" }, env).keyFor).toBe("nowhere");
    expect(liveSettingEnv(custom)).toEqual(expect.arrayContaining([[GATEWAY, "OMB_CUSTOM_LIVE_ENDPOINT"], ["gpt-live-1", "OMB_CUSTOM_LIVE_MODEL"]]));
  });
});

describe("who may call through a custom endpoint", () => {
  it("names the custom endpoint to a caller without the admin scope", () => {
    expect(liveScopeRefusal({ live: custom }, "POST", "/api/live/session")).toBe(LIVE_CUSTOM_REFUSAL);
  });
});
