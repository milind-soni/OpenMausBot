import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  native: vi.fn(async () => ({ sessionId: "native-fixture", sdp: "fixture-answer" })),
  qwen: vi.fn(),
}));
vi.mock("./live-call.ts", async (original) => ({
  ...await original<typeof import("./live-call.ts")>(), createLiveSession: fake.native,
}));
vi.mock("./qwen-live-socket.ts", () => ({
  QwenLiveSocket: class { constructor(input: unknown) { fake.qwen(input); } },
}));

import { createProviderLiveSession } from "./qwen-live-session.ts";

const common = {
  key: "fixture-key-not-a-real-credential", sdp: "fixture-offer", voice: "marin",
  bot: { name: "Fixture", title: "Assistant", description: "Synthetic verification bot" },
  history: [], cloudHome: false,
};
beforeEach(() => vi.clearAllMocks());

for (const provider of ["openai", "azure"] as const) {
  it(`keeps the ${provider} session on the native SDP path`, async () => {
    const input = { ...common, endpoint: { provider, apiBase: "https://fixture.example.test", model: "gpt-live-1" } };
    const result = await createProviderLiveSession(input);
    expect(fake.native).toHaveBeenCalledWith(input);
    expect(fake.qwen).not.toHaveBeenCalled();
    expect(result).toEqual({ sessionId: "native-fixture", sdp: "fixture-answer" });
  });
}

it("selects the Qwen PCM path and preserves the selected voice without a native-key fallback", async () => {
  const input = { ...common, voice: "yuxiaoyun_v3.1", endpoint: { provider: "qwen" as const, apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" } };
  const result = await createProviderLiveSession(input);
  expect(fake.native).not.toHaveBeenCalled();
  expect(fake.qwen).toHaveBeenCalledWith(expect.objectContaining({ key: common.key, voice: input.voice, endpoint: input.endpoint }));
  expect(result).toMatchObject({ sdp: "", transport: { type: "ws-pcm", path: "/api/live/media", inputSampleRate: 16000, outputSampleRate: 24000, playbackFlow: "credit-v1" } });
});
