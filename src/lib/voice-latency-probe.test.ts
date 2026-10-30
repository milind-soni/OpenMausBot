import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { VoiceProbeSample } from "../../shared/voice-latency-probe";
import { recordBotTextMessage, recordRuntimeEvent } from "./voice-latency-probe";

const delta = (threadId: string): RuntimeEvent => ({
  eventId: `${threadId}-delta`, provider: "claudeAgent", threadId, createdAt: "2026-01-01T00:00:00.000Z",
  type: "content.delta", streamKind: "assistant_text", delta: "chunk",
});

const turnStarted = (threadId: string): RuntimeEvent => ({
  eventId: `${threadId}-turn`, provider: "claudeAgent", threadId, createdAt: "2026-01-01T00:00:00.000Z",
  type: "turn.started",
});

describe("voice latency recorder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attributes each thread's first delta to its own completed message", () => {
    const probe: VoiceProbeSample[] = [];
    vi.stubGlobal("window", { __ombVoiceProbe: probe });
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValueOnce(100);
    recordRuntimeEvent(delta("interleave-a"));
    clock.mockReturnValueOnce(200);
    recordRuntimeEvent(delta("interleave-b"));
    clock.mockReturnValueOnce(300);
    recordBotTextMessage({ id: "msg-b", text: "b" }, "interleave-b");
    clock.mockReturnValueOnce(301);
    recordBotTextMessage({ id: "msg-a", text: "a" }, "interleave-a");
    const byId = new Map(probe.map((sample) => [sample.messageId, sample]));
    expect(byId.get("msg-a")!.firstDeltaAt).toBe(100);
    expect(byId.get("msg-b")!.firstDeltaAt).toBe(200);
  });

  it("clears only the pending delta of the thread whose turn started", () => {
    const probe: VoiceProbeSample[] = [];
    vi.stubGlobal("window", { __ombVoiceProbe: probe });
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValueOnce(100);
    recordRuntimeEvent(delta("clear-a"));
    clock.mockReturnValueOnce(200);
    recordRuntimeEvent(delta("clear-b"));
    recordRuntimeEvent(turnStarted("clear-a"));
    clock.mockReturnValueOnce(300);
    recordBotTextMessage({ id: "msg-clear-b", text: "b" }, "clear-b");
    clock.mockReturnValueOnce(301);
    recordBotTextMessage({ id: "msg-clear-a", text: "a" }, "clear-a");
    const byId = new Map(probe.map((sample) => [sample.messageId, sample]));
    expect(byId.get("msg-clear-b")!.firstDeltaAt).toBe(200);
    expect(byId.get("msg-clear-a")!.firstDeltaAt).toBeUndefined();
  });

  it("records a fresh first delta after its own thread's turn restarts", () => {
    const probe: VoiceProbeSample[] = [];
    vi.stubGlobal("window", { __ombVoiceProbe: probe });
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValueOnce(100);
    recordRuntimeEvent(delta("restart"));
    recordRuntimeEvent(turnStarted("restart"));
    clock.mockReturnValueOnce(400);
    recordRuntimeEvent(delta("restart"));
    clock.mockReturnValueOnce(500);
    recordBotTextMessage({ id: "msg-restart", text: "r" }, "restart");
    expect(probe[0]!.firstDeltaAt).toBe(400);
  });
});
