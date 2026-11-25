import { describe, expect, it } from "vitest";
import { voiceFailure, voiceNoteFailure } from "./errors.ts";
import { NoVoiceConfigured } from "./index.ts";
import { OpenAiVoiceError } from "./openai.ts";

describe("speech failure responses", () => {
  it.each(["key", "auth", "rateLimit", "timeout"] as const)("maps OpenAI %s consistently for readout and voice notes", (code) => {
    const error = new OpenAiVoiceError(code);
    const expected = { status: code === "key" ? 409 : 502, body: { error: error.message, errorKey: error.errorKey } };
    expect(voiceFailure(error)).toEqual(expected);
    expect(voiceNoteFailure(error)).toEqual(expected);
  });
  it("preserves existing missing-voice and legacy voice-note status handling", () => {
    expect(voiceNoteFailure(new NoVoiceConfigured("voice"))?.status).toBe(409);
    const error = Object.assign(new Error("voice note refused"), { status: 422 });
    expect(voiceNoteFailure(error)).toEqual({ status: 422, body: { error: error.message } });
    expect(voiceFailure(error)).toBeUndefined();
    expect(voiceNoteFailure(new Error("unexpected"))).toBeUndefined();
  });
});
