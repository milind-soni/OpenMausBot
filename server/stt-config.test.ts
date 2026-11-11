import { describe, expect, it } from "vitest";
import { sttConfigSchema, sttConfigWithEnv, sttKeySendable, sttSavePatch, sttStatus, usableSttKey } from "./stt-config.ts";
import { STT_PRESETS } from "../shared/stt.ts";

describe("speech input configuration", () => {
  it("offers transcription servers only, not a chat model that listens", () => {
    expect(sttConfigSchema.safeParse({ provider: "gemini" }).success).toBe(false);
    expect(sttStatus({ stt: { provider: "openai" }, tts: { geminiKey: "speech-output-key" } })).toMatchObject({
      provider: "openai", ...STT_PRESETS.openai, model: "", configured: false, keyConfigured: false,
    });
  });
  it("only accepts API roots without embedded credentials or URL parameters", () => {
    for (const baseUrl of ["file:///tmp", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#fragment", "not a URL"]) {
      expect(sttConfigSchema.safeParse({ baseUrl }).success).toBe(false);
    }
    expect(sttConfigSchema.safeParse({ baseUrl: "http://localhost:8080/v1" }).success).toBe(true);
  });
  it("does not carry credentials between API roots, but permits saving a new key together with its address", () => {
    const current = { baseUrl: "https://api.openai.com/v1", key: "openai-secret" };
    expect(sttSavePatch(current, { baseUrl: "http://localhost:8080/v1" })).toEqual({ baseUrl: "http://localhost:8080/v1", key: "", keyFor: "nowhere" });
    expect(sttSavePatch(current, { baseUrl: "https://api.openai.com/v1/" })).toEqual({ baseUrl: "https://api.openai.com/v1/" });
    expect(sttSavePatch(current, { baseUrl: "http://localhost:8080/v1", key: "local-secret" }).key).toBe("local-secret");
  });
  it("keeps a stale desktop-store credential revoked after restart and ignores client-supplied key bindings", () => {
    const current = { baseUrl: "https://api.openai.com/v1", key: "old-secret", keyFor: "https://api.openai.com/v1" };
    const changed = { ...current, ...sttSavePatch(current, { baseUrl: "http://localhost:8080/v1", keyFor: "http://localhost:8080/v1" }) };
    expect(usableSttKey(sttConfigWithEnv(changed, { OMB_STT_API_KEY: "old-secret" }))).toBeUndefined();
    const saved = { ...changed, ...sttSavePatch(changed, { key: "new-secret" }) };
    expect(usableSttKey(sttConfigWithEnv({ ...saved, key: "" }, { OMB_STT_API_KEY: "new-secret" }))).toBe("new-secret");
    const removed = { ...saved, ...sttSavePatch(saved, { key: "" }) };
    expect(usableSttKey(sttConfigWithEnv(removed, { OMB_STT_API_KEY: "new-secret" }))).toBeUndefined();
  });
  it("requires an OpenAI key and accepts keyless custom servers without borrowing chat keys", () => {
    expect(sttStatus({ stt: { provider: "openai" } }).configured).toBe(false);
    expect(sttStatus({ stt: { provider: "openai", baseUrl: "http://localhost:8080/v1" } }).configured).toBe(false);
    expect(sttStatus({ stt: { provider: "openai", baseUrl: "http://localhost:8080/v1", model: "custom-audio" } }).configured).toBe(true);
    expect(sttStatus({ tts: { fishKey: "fish" } }).configured).toBe(true);
  });
  it("lets any custom server run without a key, but not the OpenAI and Groq presets", () => {
    for (const baseUrl of ["http://whisper:8000/v1", "http://host.docker.internal:9000/v1", "https://stt.corp.internal/v1", "http://100.101.1.2/v1", "http://[fd00::5]:8000/v1"]) {
      expect(sttStatus({ stt: { provider: "openai", baseUrl, model: "whisper-1" } }).configured, baseUrl).toBe(true);
    }
    for (const preset of [STT_PRESETS.openai, STT_PRESETS.groq]) {
      expect(sttStatus({ stt: { provider: "openai", ...preset, model: "whisper-1" } }).configured).toBe(false);
    }
  });
  it("says when a key from the environment is not used for the saved address", () => {
    const env = { OMB_STT_API_KEY: "operator-key" };
    const revoked = sttConfigWithEnv({ provider: "openai", baseUrl: "https://stt.example.com/v1", model: "whisper", keyFor: "nowhere" }, env);
    expect(sttStatus({ stt: revoked })).toMatchObject({ keyConfigured: false, keyIgnored: true });
    const bound = sttConfigWithEnv({ provider: "openai", baseUrl: "https://stt.example.com/v1", model: "whisper" }, env);
    expect(sttStatus({ stt: bound })).not.toHaveProperty("keyIgnored");
    expect(sttStatus({ stt: bound }).keyConfigured).toBe(true);
  });
  it("sends a key only over https or to this computer", () => {
    for (const baseUrl of ["https://stt.example.com/v1", "http://localhost:8000", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"]) {
      expect(sttKeySendable({ provider: "openai", baseUrl }), baseUrl).toBe(true);
      expect(usableSttKey(sttSavePatch(undefined, { provider: "openai", baseUrl, key: "k" })), baseUrl).toBe("k");
    }
    for (const baseUrl of ["http://192.168.1.5:8000/v1", "http://whisper:8000/v1", "http://localhost.example.com/v1"]) {
      expect(sttKeySendable({ provider: "openai", baseUrl }), baseUrl).toBe(false);
      expect(usableSttKey(sttSavePatch(undefined, { provider: "openai", baseUrl, key: "k" })), baseUrl).toBeUndefined();
    }
  });
  it("adds /v1 to an API root that has no path", () => {
    expect(sttStatus({ stt: { provider: "openai", baseUrl: "http://localhost:8000/" } }).baseUrl).toBe("http://localhost:8000/v1");
    expect(sttStatus({ stt: { provider: "openai", baseUrl: "http://localhost:8000/api/v2" } }).baseUrl).toBe("http://localhost:8000/api/v2");
  });
});
