// speak() on the built-in provider, on this Windows machine: no key, a
// real PowerShell/SAPI synthesis, and the same NoVoiceConfigured contract
// as macOS.
import { describe, expect, it } from "vitest";

import { NoVoiceConfigured, providerConfigured, speak } from "./index.ts";
import type { AppConfig } from "../config.ts";

const cfg = (tts: AppConfig["tts"]): AppConfig => ({ tts });
const onWindows = process.platform === "win32";

describe("system provider on win32", () => {
  it("is configured with no key at all", () => {
    expect(providerConfigured(cfg({ provider: "system" }))).toBe(onWindows);
  });

  it("synthesizes through System.Speech with the chosen voice", async () => {
    if (!onWindows) return; // the say-shaped seam covers the darwin side
    // The production path on win32 IS the PowerShell engine; this proves
    // the whole route — config gate, spawn, WAV bytes — with no mocks.
    const audio = await speak(cfg({ provider: "system", voice: "Microsoft David Desktop" }), "hello there");
    expect(audio.mime).toBe("audio/wav");
    expect(Buffer.from(audio.bytes).toString()).toContain("WAVE");
  });
});

describe("voice contract", () => {
  it("still demands a picked voice, and says so", () => {
    expect(() => speak(cfg({ provider: "system" }), "hi")).toThrow(NoVoiceConfigured);
    expect(() => speak(cfg({ provider: "system" }), "hi")).toThrow("Pick a voice in the agent profile.");
  });
});
