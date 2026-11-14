import { describe, expect, it } from "vitest";
import {
  summarizeVoiceReply,
  summarizeVoiceRun,
  summarizeVoiceTurn,
  VOICE_LATENCY_GAP_THRESHOLD_MS,
  type VoiceProbeSample,
} from "../../shared/voice-latency-probe";

const sample = (blocks: Array<{ startAt: number; endAt?: number }>, firstDeltaAt?: number): VoiceProbeSample => ({
  messageId: "m1",
  ...(firstDeltaAt !== undefined ? { firstDeltaAt } : {}),
  blocks: blocks.map((block) => ({ ...block })),
});

describe("summarizeVoiceReply", () => {
  it("measures t0 (first delta) to first audio start", () => {
    const summary = summarizeVoiceReply(sample([{ startAt: 900, endAt: 4_000 }], 250));
    expect(summary.t0ToFirstAudioMs).toBe(650);
  });

  it("is null when the delta or the audio never arrived", () => {
    expect(summarizeVoiceReply(sample([{ startAt: 100, endAt: 200 }])).t0ToFirstAudioMs).toBeNull();
    expect(summarizeVoiceReply(sample([], 100)).t0ToFirstAudioMs).toBeNull();
  });

  it("counts only silences above the 200 ms threshold between consecutive blocks", () => {
    const summary = summarizeVoiceReply(sample([
      { startAt: 0, endAt: 1_000 },
      { startAt: 1_250, endAt: 2_000 },
      { startAt: 2_400, endAt: 3_000 },
    ]));
    expect(VOICE_LATENCY_GAP_THRESHOLD_MS).toBe(200);
    expect(summary.gapCount).toBe(2);
    expect(summary.totalGapMs).toBe(650);
    expect(summary.longestGapMs).toBe(400);
  });

  it("ignores a silence that ends the reply (no following audio start)", () => {
    const summary = summarizeVoiceReply(sample([{ startAt: 0, endAt: 1_000 }]));
    expect(summary.gapCount).toBe(0);
  });

  it("drops blocks missing a start or end instead of guessing a boundary", () => {
    const partial: VoiceProbeSample = {
      messageId: "m1",
      blocks: [{ startAt: 0, endAt: 1_000 }, { startAt: 1_500 }, { endAt: 9_000 }],
    };
    const summary = summarizeVoiceReply(partial);
    expect(summary.t0ToFirstAudioMs).toBeNull();
    expect(summary.gapCount).toBe(0);
  });

  it("keeps first audio from a block that started but never finished; gaps still need both bounds", () => {
    const summary = summarizeVoiceReply(sample([{ startAt: 400 }, { startAt: 2_600, endAt: 3_000 }], 250));
    expect(summary.t0ToFirstAudioMs).toBe(150);
    expect(summary.gapCount).toBe(0);
  });

  it("ignores non-finite timestamps from a broken clock", () => {
    const summary = summarizeVoiceReply({
      messageId: "m1",
      firstDeltaAt: Number.NaN,
      blocks: [{ startAt: Number.POSITIVE_INFINITY, endAt: 1 }],
    });
    expect(summary.t0ToFirstAudioMs).toBeNull();
    expect(summary.gapCount).toBe(0);
  });

  it("keeps a threshold-edge silence out and a one-over silence in", () => {
    const edge = summarizeVoiceReply(sample([{ startAt: 0, endAt: 0 }, { startAt: 200, endAt: 300 }]));
    expect(edge.gapCount).toBe(0);
    const over = summarizeVoiceReply(sample([{ startAt: 0, endAt: 0 }, { startAt: 201, endAt: 300 }]));
    expect(over.gapCount).toBe(1);
    expect(over.longestGapMs).toBe(201);
  });
});

describe("summarizeVoiceTurn", () => {
  const frame = (id: string, firstDeltaAt: number | undefined, blocks: Array<{ startAt?: number; endAt?: number }>, extra?: Partial<VoiceProbeSample>): VoiceProbeSample => ({
    messageId: id,
    ...(firstDeltaAt !== undefined ? { firstDeltaAt } : {}),
    ...extra,
    blocks: blocks.map((block) => ({ ...block })),
  });

  const full = frame("full", 100, [{ startAt: 2_600, endAt: 3_000 }], { messageFrameAt: 2_500, blockCount: 1 });

  it("takes t0 from the turn's first delta and audio from the chosen frame", () => {
    const summary = summarizeVoiceTurn([
      frame("prefix-1", 100, [{ startAt: 500, endAt: 900 }]),
      frame("prefix-2", 260, [{ startAt: 600, endAt: 2_000 }]),
      full,
      frame("trailing", 2_700, [{ startAt: 2_800, endAt: 2_900 }]),
    ], full);
    expect(summary.t0ToFirstAudioMs).toBe(2_500);
    expect(summary.t0ToMessageFrameMs).toBe(2_400);
    expect(summary.messageFrameToFirstAudioMs).toBe(100);
    expect(summary.blocksMeasured).toBe(1);
  });

  it("counts gaps within the chosen frame only", () => {
    const speaker = frame("full", 0, [{ startAt: 100, endAt: 1_100 }, { startAt: 1_400, endAt: 2_000 }]);
    const summary = summarizeVoiceTurn([
      frame("prefix", 0, [{ startAt: 50, endAt: 1_000 }]),
      speaker,
    ], speaker);
    expect(summary.gapCount).toBe(1);
    expect(summary.longestGapMs).toBe(300);
  });

  it("keeps first audio when the chosen frame was interrupted; gaps still need both bounds", () => {
    const interrupted = frame("full", 100, [{ startAt: 150 }]);
    expect(summarizeVoiceTurn([interrupted], interrupted).t0ToFirstAudioMs).toBe(50);
    expect(summarizeVoiceTurn([interrupted], interrupted).gapCount).toBe(0);
    const silent = frame("full", 100, []);
    expect(summarizeVoiceTurn([silent], silent).t0ToFirstAudioMs).toBeNull();
  });

  it("ignores non-finite delta stamps from a broken clock", () => {
    const speaker = frame("full", Number.NaN, [{ startAt: 300, endAt: 400 }]);
    expect(summarizeVoiceTurn([speaker], speaker).t0ToFirstAudioMs).toBeNull();
  });
});

describe("summarizeVoiceRun", () => {
  it("aggregates worst first audio, gap totals and the single longest gap", () => {
    const totals = summarizeVoiceRun([
      { t0ToFirstAudioMs: 700, gapCount: 1, totalGapMs: 300, longestGapMs: 300 },
      { t0ToFirstAudioMs: 2_100, gapCount: 2, totalGapMs: 900, longestGapMs: 500 },
      { t0ToFirstAudioMs: null, gapCount: 0, totalGapMs: 0, longestGapMs: 0 },
    ]);
    expect(totals).toEqual({
      worstFirstAudioMs: 2_100,
      totalGaps: 3,
      totalGapMs: 1_200,
      longestGapMs: 500,
      measuredReplies: 3,
    });
  });

  it("survives an empty run", () => {
    expect(summarizeVoiceRun([])).toEqual({
      worstFirstAudioMs: null,
      totalGaps: 0,
      totalGapMs: 0,
      longestGapMs: 0,
      measuredReplies: 0,
    });
  });
});
