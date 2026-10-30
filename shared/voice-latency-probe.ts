/** Voice-latency probe: the wire types and the pure accounting the
 * measurement harness runs on. The recorder in `src/lib/voice-latency-probe.ts`
 * is inert unless the harness installs a sink in the page; these shapes are
 * shared so the offline harness and the in-page recorder cannot drift. */

/** A silence between the end of one audio block and the start of the next
 * counts as a gap only above this many milliseconds (cut protocol, §3). */
export const VOICE_LATENCY_GAP_THRESHOLD_MS = 200;

export interface VoiceProbeBlockTiming {
  /** Milliseconds on the page clock when this block's audio element began playing. */
  startAt?: number;
  /** Milliseconds on the page clock when playback of this block stopped
   * (ended, errored, or was torn down by a later speak). */
  endAt?: number;
  /** When the renderer asked the server to synthesize this block. */
  renderStartAt?: number;
  /** When synthesis for this block resolved. */
  renderDoneAt?: number;
}

export interface VoiceProbeSample {
  messageId: string;
  /** First assistant_text content.delta arrival for the turn that produced
   * this message, on the same page clock as the audio timings. */
  firstDeltaAt?: number;
  /** Arrival of the completed bot message frame (the app's speak trigger). */
  messageFrameAt?: number;
  /** Entry into Speaker.speak for this message. */
  speakEnterAt?: number;
  /** Completion of /api/tts/prepare for this message. */
  preparedAt?: number;
  blockCount?: number;
  textChars?: number;
  blocks: VoiceProbeBlockTiming[];
}

export interface VoiceGapSummary {
  /** firstDelta → first audio start; null when either end is missing. */
  t0ToFirstAudioMs: number | null;
  /** Silences longer than VOICE_LATENCY_GAP_THRESHOLD_MS between consecutive
   * blocks, after first audio, within this reply. */
  gapCount: number;
  totalGapMs: number;
  longestGapMs: number;
}

const finiteOrUndefined = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Accounting for one reply. First audio needs only a playback start; a
 * silence needs both bounds on the page clock: a block the probe never saw
 * finish cannot bound one, and counting it would understate dead air. */
export function summarizeVoiceReply(sample: VoiceProbeSample): VoiceGapSummary {
  const firstDeltaAt = finiteOrUndefined(sample.firstDeltaAt);
  const starts = sample.blocks
    .map((block) => finiteOrUndefined(block.startAt))
    .filter((value): value is number => value !== undefined);
  const firstAudio = starts.length ? Math.min(...starts) : undefined;
  const played = sample.blocks
    .map((block) => ({ startAt: finiteOrUndefined(block.startAt), endAt: finiteOrUndefined(block.endAt) }))
    .filter((block): block is { startAt: number; endAt: number } =>
      block.startAt !== undefined && block.endAt !== undefined && block.endAt >= block.startAt)
    .sort((a, b) => a.startAt - b.startAt);
  const gaps: number[] = [];
  for (let i = 1; i < played.length; i += 1) {
    const silence = played[i]!.startAt - played[i - 1]!.endAt;
    if (silence > VOICE_LATENCY_GAP_THRESHOLD_MS) gaps.push(silence);
  }
  return {
    t0ToFirstAudioMs: firstDeltaAt !== undefined && firstAudio !== undefined ? firstAudio - firstDeltaAt : null,
    gapCount: gaps.length,
    totalGapMs: gaps.reduce((sum, gap) => sum + gap, 0),
    longestGapMs: gaps.length ? Math.max(...gaps) : 0,
  };
}

export interface VoiceTurnSummary extends VoiceGapSummary {
  t0ToMessageFrameMs: number | null;
  messageFrameToFirstAudioMs: number | null;
  blocksMeasured: number | null;
}

/** Summary for one scripted reply. A streaming turn emits several message
 * frames; the harness picks the frame carrying the full corpus reply as
 * `audioFrame`. t0 is the first delta across the whole turn; audio, the
 * message frame, and gaps come from `audioFrame`. First audio needs only a
 * playback start; gaps still require both bounds. */
export function summarizeVoiceTurn(frames: readonly VoiceProbeSample[], audioFrame: VoiceProbeSample): VoiceTurnSummary {
  const t0 = Math.min(...frames.map((frame) => finiteOrUndefined(frame.firstDeltaAt) ?? Number.POSITIVE_INFINITY));
  const summary = summarizeVoiceReply(audioFrame);
  const messageFrameAt = finiteOrUndefined(audioFrame.messageFrameAt);
  const starts = audioFrame.blocks.map((block) => finiteOrUndefined(block.startAt)).filter((value): value is number => value !== undefined);
  const firstAudio = starts.length ? Math.min(...starts) : undefined;
  return {
    t0ToFirstAudioMs: Number.isFinite(t0) && firstAudio !== undefined ? firstAudio - t0 : null,
    t0ToMessageFrameMs: Number.isFinite(t0) && messageFrameAt !== undefined ? messageFrameAt - t0 : null,
    messageFrameToFirstAudioMs: messageFrameAt !== undefined && firstAudio !== undefined ? firstAudio - messageFrameAt : null,
    gapCount: summary.gapCount,
    totalGapMs: summary.totalGapMs,
    longestGapMs: summary.longestGapMs,
    blocksMeasured: typeof audioFrame.blockCount === "number" ? audioFrame.blockCount : null,
  };
}

export interface VoiceRunTotals {
  worstFirstAudioMs: number | null;
  totalGaps: number;
  totalGapMs: number;
  longestGapMs: number;
  measuredReplies: number;
}

export function summarizeVoiceRun(replies: readonly VoiceGapSummary[]): VoiceRunTotals {
  const firstAudio = replies.map((reply) => reply.t0ToFirstAudioMs).filter((value): value is number => value !== null);
  return {
    worstFirstAudioMs: firstAudio.length ? Math.max(...firstAudio) : null,
    totalGaps: replies.reduce((sum, reply) => sum + reply.gapCount, 0),
    totalGapMs: replies.reduce((sum, reply) => sum + reply.totalGapMs, 0),
    longestGapMs: replies.length ? Math.max(0, ...replies.map((reply) => reply.longestGapMs)) : 0,
    measuredReplies: replies.length,
  };
}
