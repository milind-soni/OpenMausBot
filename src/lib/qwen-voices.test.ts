import { describe, expect, it } from "vitest";
import source from "../testing/qwen-voices-source.json";
import { qwenVoicesForModel, QWEN_VOICE_SOURCES } from "./qwen-voices";

describe("official Qwen 3.1 realtime system voices", () => {
  it("contains only voices the realtime model accepts, plus the realtime default, with source provenance", () => {
    for (const model of ["qwen-audio-3.1-realtime-flash", "qwen-audio-3.1-realtime-plus"]) {
      const voices = qwenVoicesForModel(model);
      expect(voices).toHaveLength(69);
      expect(new Set(voices.map((voice: { id: string }) => voice.id)).size).toBe(69);
      expect(voices[0]).toMatchObject({ id: "longanqian_v3.1", sourceUrl: source.compatibilitySourceUrl });
      expect(voices.slice(1)).toEqual(source.voices.map((voice) => ({ ...voice, sourceUrl: source.sourceUrl })));
      expect(voices.some((voice: { id: string }) => voice.id === "longanlingxin")).toBe(false);
      expect(voices.some((voice: { id: string }) => voice.id === "Cherry")).toBe(false);
    }
    expect(qwenVoicesForModel("qwen-audio-3.0-realtime-plus")).toEqual([]);
    expect(qwenVoicesForModel("unknown-model")).toEqual([]);
    expect(QWEN_VOICE_SOURCES).toEqual({
      compatibility: source.compatibilitySourceUrl,
      catalog: source.sourceUrl,
      custom: "https://help.aliyun.com/zh/model-studio/audio-realtime-voice-cloning-api",
      protocol: "https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events",
    });
  });
});
