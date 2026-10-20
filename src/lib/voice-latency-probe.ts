// Inert voice-latency recorder. Every exported function is a no-op unless the
// measurement harness installed a sink array at `window.__ombVoiceProbe` — with
// the probe off, the speak path runs exactly as it did before the probe existed.
import type { RuntimeEvent, ThreadId } from "../../shared/runtime-events";
import type { VoiceProbeSample } from "../../shared/voice-latency-probe";

const PROBE_KEY = "__ombVoiceProbe";

type ProbeWindow = Window & { [PROBE_KEY]?: VoiceProbeSample[] };

const sink = (): VoiceProbeSample[] | null => {
  if (typeof window === "undefined") return null;
  const held = (window as ProbeWindow)[PROBE_KEY];
  return Array.isArray(held) ? held : null;
};

const now = (): number => performance.now();

const sampleFor = (probe: VoiceProbeSample[], messageId: string): VoiceProbeSample => {
  const existing = probe.find((sample) => sample.messageId === messageId);
  if (existing) return existing;
  const created: VoiceProbeSample = { messageId, blocks: [] };
  probe.push(created);
  return created;
};

/** t0 candidates for each thread's next completed message: the first
 * assistant_text delta of that thread's turn. `turn.started` clears only its
 * own thread's entry, matching how turns own replies. */
const pendingFirstDeltaAt = new Map<ThreadId, number>();

export function recordRuntimeEvent(event: RuntimeEvent): void {
  if (!sink()) return;
  if (event.type === "turn.started") {
    pendingFirstDeltaAt.delete(event.threadId);
    return;
  }
  if (event.type !== "content.delta" || event.streamKind !== "assistant_text") return;
  if (!pendingFirstDeltaAt.has(event.threadId)) pendingFirstDeltaAt.set(event.threadId, now());
}

export function recordBotTextMessage(message: { id: string; text?: string | null }, threadId: ThreadId): void {
  const probe = sink();
  if (!probe) return;
  const pending = pendingFirstDeltaAt.get(threadId);
  pendingFirstDeltaAt.delete(threadId);
  const sample = sampleFor(probe, message.id);
  if (sample.messageFrameAt === undefined) sample.messageFrameAt = now();
  if (sample.firstDeltaAt === undefined && pending !== undefined) {
    sample.firstDeltaAt = pending;
  }
  if (sample.textChars === undefined && typeof message.text === "string") sample.textChars = [...message.text].length;
}

export function recordSpeakEnter(messageId: string | undefined): void {
  const probe = sink();
  if (!probe || !messageId) return;
  const sample = sampleFor(probe, messageId);
  if (sample.speakEnterAt === undefined) sample.speakEnterAt = now();
}

export function recordPrepared(messageId: string | undefined, blockCount: number): void {
  const probe = sink();
  if (!probe || !messageId) return;
  const sample = sampleFor(probe, messageId);
  if (sample.preparedAt === undefined) sample.preparedAt = now();
  sample.blockCount = blockCount;
}

export function recordBlockTiming(
  messageId: string | undefined,
  block: number,
  phase: "renderStart" | "renderDone" | "audioStart" | "audioEnd",
): void {
  const probe = sink();
  if (!probe || !messageId) return;
  const sample = sampleFor(probe, messageId);
  while (sample.blocks.length <= block) sample.blocks.push({});
  const timing = sample.blocks[block]!;
  const at = now();
  if (phase === "renderStart" && timing.renderStartAt === undefined) timing.renderStartAt = at;
  else if (phase === "renderDone" && timing.renderDoneAt === undefined) timing.renderDoneAt = at;
  else if (phase === "audioStart" && timing.startAt === undefined) timing.startAt = at;
  else if (phase === "audioEnd" && timing.endAt === undefined) timing.endAt = at;
}
