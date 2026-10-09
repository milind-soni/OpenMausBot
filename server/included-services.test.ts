// Which credential a Boat, ElevenLabs or Jev request uses, and where it may
// go. The relays know only the Admin's accounts: an own key must never reach
// them, and the included token must never reach the providers.
import { afterEach, describe, expect, it, vi } from "vitest";

import { jevEndpoint } from "./decider/jev.ts";
import { boatCredential, deciderCredential, trialCreditCredential, voiceCredential } from "./included-services.ts";

const RELAY_BOAT = "https://cloud.example.test/api/cloud/services/boat/api/box/v1";
const RELAY_VOICE = "https://cloud.example.test/api/cloud/services/voice/v1";
// A Jev base URL: the relay's one route is <this>/v1/systemone.
const RELAY_DECIDER = "https://cloud.example.test/api/cloud/services/decider";
const cloud = {
  OMB_CLOUD_BOAT_URL: RELAY_BOAT,
  OMB_CLOUD_BOAT_TOKEN: "box_omb_included",
  OMB_CLOUD_VOICE_URL: RELAY_VOICE,
  OMB_CLOUD_VOICE_TOKEN: "omb_voice_included",
  OMB_CLOUD_DECIDER_URL: RELAY_DECIDER,
  OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included",
};

describe("Boat credential", () => {
  it("falls back to the included token, sent only to the relay, when there is no own key", () => {
    expect(boatCredential(undefined, cloud)).toEqual({ token: "box_omb_included", api: RELAY_BOAT, included: true });
    expect(boatCredential("", cloud)).toEqual({ token: "box_omb_included", api: RELAY_BOAT, included: true });
  });

  it("uses the person's own key, sent only to Boat, whenever there is one", () => {
    expect(boatCredential("box_own", cloud)).toEqual({ token: "box_own", api: "https://ascii.dev/api/box/v1", included: false });
    // OMB_BOX_API keeps pointing own keys at a stub for dev and tests.
    expect(boatCredential("box_own", { ...cloud, OMB_BOX_API: "http://127.0.0.1:9/api/box/v1" }))
      .toEqual({ token: "box_own", api: "http://127.0.0.1:9/api/box/v1", included: false });
  });

  it("sends the included token only to the relay even when it comes back as a plain token", () => {
    // A leased computer descriptor carries the token in use back to boat.ts.
    expect(boatCredential("box_omb_included", { ...cloud, OMB_BOX_API: "http://127.0.0.1:9/api/box/v1" }))
      .toEqual({ token: "box_omb_included", api: RELAY_BOAT, included: true });
  });

  it("is included only when both the relay URL and the token are set", () => {
    expect(boatCredential(undefined, {})).toBeNull();
    expect(boatCredential(undefined, { OMB_CLOUD_BOAT_TOKEN: "box_omb_included" })).toBeNull();
    expect(boatCredential(undefined, { OMB_CLOUD_BOAT_URL: RELAY_BOAT })).toBeNull();
    expect(boatCredential(undefined, { OMB_CLOUD_BOAT_URL: `${RELAY_BOAT}/`, OMB_CLOUD_BOAT_TOKEN: " box_omb_included " }))
      .toEqual({ token: "box_omb_included", api: RELAY_BOAT, included: true });
  });
});

describe("ElevenLabs credential", () => {
  it("falls back to the included token, sent only to the relay, when there is no own key", () => {
    expect(voiceCredential(undefined, cloud)).toEqual({ token: "omb_voice_included", api: RELAY_VOICE, included: true });
    expect(voiceCredential(undefined, { OMB_CLOUD_VOICE_TOKEN: "omb_voice_included" })).toBeNull();
  });

  it("uses the person's own key, sent only to ElevenLabs", () => {
    expect(voiceCredential("sk-own", cloud)).toEqual({ token: "sk-own", api: "https://api.elevenlabs.io/v1", included: false });
    expect(voiceCredential("sk-own", { ...cloud, OMB_ELEVENLABS_API: "http://127.0.0.1:9/v1" }))
      .toEqual({ token: "sk-own", api: "http://127.0.0.1:9/v1", included: false });
  });

  it("never mixes the two services' tokens", () => {
    expect(voiceCredential("box_omb_included", cloud)).toMatchObject({ api: "https://api.elevenlabs.io/v1", included: false });
    expect(boatCredential(undefined, { OMB_CLOUD_VOICE_URL: RELAY_VOICE, OMB_CLOUD_VOICE_TOKEN: "omb_voice_included" })).toBeNull();
  });
});

describe("Jev credential", () => {
  // `api` is a Jev base URL: the backend adds /v1/systemone.
  const endpoint = (credential: ReturnType<typeof deciderCredential>) => String(jevEndpoint(credential?.api));

  it("falls back to the included token, sent only to the relay's one route, when there is no own key", () => {
    for (const own of [undefined, "", "   "]) {
      const credential = deciderCredential(own, undefined, cloud);
      expect(credential).toEqual({ token: "omb_decide_included", api: RELAY_DECIDER, included: true });
      expect(endpoint(credential)).toBe(`${RELAY_DECIDER}/v1/systemone`);
    }
  });

  it("uses the person's own key, sent only to Jev or their own base URL", () => {
    const own = deciderCredential(" tsk_own ", undefined, cloud);
    expect(own).toEqual({ token: "tsk_own", api: "https://api.typesafe.ai", included: false });
    expect(endpoint(own)).toBe("https://api.typesafe.ai/v1/systemone");
    const local = deciderCredential("tsk_own", "http://127.0.0.1:9", cloud);
    expect(local).toEqual({ token: "tsk_own", api: "http://127.0.0.1:9", included: false });
    expect(endpoint(local)).toBe("http://127.0.0.1:9/v1/systemone");
  });

  it("sends the included token only to the relay, whatever base URL is set for own keys", () => {
    expect(deciderCredential(undefined, "http://127.0.0.1:9", cloud)).toMatchObject({ token: "omb_decide_included", included: true });
    expect(endpoint(deciderCredential(undefined, "http://127.0.0.1:9", cloud))).toBe(`${RELAY_DECIDER}/v1/systemone`);
    // Pasted back as if it were an own key, it still goes only to the relay.
    expect(endpoint(deciderCredential("omb_decide_included", undefined, cloud))).toBe(`${RELAY_DECIDER}/v1/systemone`);
  });

  it("is included only when both the relay URL and the token are set", () => {
    expect(deciderCredential(undefined, undefined, {})).toBeNull();
    expect(deciderCredential(undefined, undefined, { OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included" })).toBeNull();
    expect(deciderCredential(undefined, undefined, { OMB_CLOUD_DECIDER_URL: RELAY_DECIDER })).toBeNull();
    expect(deciderCredential(undefined, undefined, { OMB_CLOUD_DECIDER_URL: RELAY_DECIDER, OMB_CLOUD_DECIDER_TOKEN: "  " })).toBeNull();
    const slashed = deciderCredential(undefined, undefined, { OMB_CLOUD_DECIDER_URL: `${RELAY_DECIDER}/`, OMB_CLOUD_DECIDER_TOKEN: " omb_decide_included " });
    expect(slashed).toEqual({ token: "omb_decide_included", api: RELAY_DECIDER, included: true });
  });

  it("uses the relay URL as it is: the final URL is exactly <OMB_CLOUD_DECIDER_URL>/v1/systemone", () => {
    for (const url of [RELAY_DECIDER, "https://relay.example.test/v1", "https://relay.example.test/a/v1/b"]) {
      const credential = deciderCredential(undefined, undefined, { OMB_CLOUD_DECIDER_URL: url, OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included" });
      expect(credential?.api).toBe(url);
      expect(endpoint(credential)).toBe(`${url}/v1/systemone`);
    }
  });

  it("never takes another service's relay token", () => {
    const { OMB_CLOUD_DECIDER_URL: _url, OMB_CLOUD_DECIDER_TOKEN: _token, ...others } = cloud;
    expect(deciderCredential(undefined, undefined, others)).toBeNull();
    expect(boatCredential(undefined, { OMB_CLOUD_DECIDER_URL: RELAY_DECIDER, OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included" })).toBeNull();
  });
});

describe("the trial's AI credit", () => {
  const AI = "https://cloud.example.test/api/cloud/services/ai", TOKEN = `omb_ai_${"a".repeat(43)}`;
  it("is the relay and this machine's token, only when both are set, HTTPS (loopback for tests) and the Admin's own token shape", () => {
    expect(trialCreditCredential({ OMB_CLOUD_AI_URL: AI, OMB_CLOUD_AI_TOKEN: TOKEN })).toEqual({ token: TOKEN, api: AI, included: true });
    expect(trialCreditCredential({ OMB_CLOUD_AI_URL: `${AI}/`, OMB_CLOUD_AI_TOKEN: ` ${TOKEN} ` })).toEqual({ token: TOKEN, api: AI, included: true });
    expect(trialCreditCredential({ OMB_CLOUD_AI_URL: "http://127.0.0.1:9/ai", OMB_CLOUD_AI_TOKEN: TOKEN })?.api).toBe("http://127.0.0.1:9/ai");
    for (const env of [{}, { OMB_CLOUD_AI_URL: AI }, { OMB_CLOUD_AI_TOKEN: TOKEN }, { OMB_CLOUD_AI_URL: "http://cloud.example.test/ai", OMB_CLOUD_AI_TOKEN: TOKEN },
      { OMB_CLOUD_AI_URL: "https://user:pw@cloud.example.test/ai", OMB_CLOUD_AI_TOKEN: TOKEN }, { OMB_CLOUD_AI_URL: `${AI}?key=1`, OMB_CLOUD_AI_TOKEN: TOKEN },
      { OMB_CLOUD_AI_URL: "not a url", OMB_CLOUD_AI_TOKEN: TOKEN }, { OMB_CLOUD_AI_URL: AI, OMB_CLOUD_AI_TOKEN: "sk-ant-own-key" },
      { OMB_CLOUD_AI_URL: AI, OMB_CLOUD_AI_TOKEN: `omb_ai_${"a".repeat(42)}` }, { ...cloud }]) {
      expect(trialCreditCredential(env), JSON.stringify(env)).toBeNull();
    }
  });
});

describe("holdIncludedServices", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the tokens in memory and removes them from the environment, so nothing started later inherits them", async () => {
    for (const [name, value] of Object.entries(cloud)) vi.stubEnv(name, value);
    // A fresh module: the hold is process-wide state.
    vi.resetModules();
    const services = await import("./included-services.ts");
    vi.stubEnv("OMB_CLOUD_AI_URL", "https://cloud.example.test/api/cloud/services/ai");
    vi.stubEnv("OMB_CLOUD_AI_TOKEN", `omb_ai_${"a".repeat(43)}`);
    services.holdIncludedServices();
    expect(process.env.OMB_CLOUD_AI_TOKEN).toBeUndefined();
    expect(services.trialCreditCredential()).toEqual({ token: `omb_ai_${"a".repeat(43)}`, api: "https://cloud.example.test/api/cloud/services/ai", included: true });
    expect(process.env.OMB_CLOUD_BOAT_TOKEN).toBeUndefined();
    expect(process.env.OMB_CLOUD_VOICE_TOKEN).toBeUndefined();
    expect(process.env.OMB_CLOUD_DECIDER_TOKEN).toBeUndefined();
    // The URLs are not secrets and stay.
    expect(process.env.OMB_CLOUD_BOAT_URL).toBe(RELAY_BOAT);
    expect(process.env.OMB_CLOUD_DECIDER_URL).toBe(RELAY_DECIDER);
    expect(services.boatCredential(undefined)).toEqual({ token: "box_omb_included", api: RELAY_BOAT, included: true });
    expect(services.voiceCredential(undefined)).toEqual({ token: "omb_voice_included", api: RELAY_VOICE, included: true });
    expect(services.deciderCredential(undefined, undefined)).toEqual({ token: "omb_decide_included", api: RELAY_DECIDER, included: true });
    // The person's own key still wins, and still goes only to the provider.
    expect(services.boatCredential("box_own")).toMatchObject({ token: "box_own", included: false });
    expect(services.voiceCredential("sk-own")).toMatchObject({ token: "sk-own", included: false });
    expect(services.deciderCredential("tsk_own", undefined)).toEqual({ token: "tsk_own", api: "https://api.typesafe.ai", included: false });
  });
});
