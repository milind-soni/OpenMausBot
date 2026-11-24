import { renderSound, type SoundChoice, type SoundEvent, type SoundStyle } from "./render";

/** What a hidden or unfocused window may still play: the person is not looking, so only what asks for them. */
export const BACKGROUND_EVENTS: ReadonlySet<SoundEvent> = new Set(["attention", "mention", "done", "error"]);

export const REPEAT_WINDOW_MS = 150;

export type HoldReason = "recording" | "call";

export interface SoundOutput {
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: AudioNode;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, rate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
}

export interface SoundHost {
  now(): number;
  choice(): SoundChoice;
  background(): boolean;
  /** Whether this window is the one used last, among every window of the app on this device. */
  leader(): boolean;
  createOutput(): SoundOutput | null;
}

export function createSoundPlayer(host: SoundHost) {
  let output: SoundOutput | null = null;
  const lastPlayed = new Map<SoundEvent, number>();
  const holds = new Map<symbol, HoldReason>();
  const rendered = new Map<string, Float32Array<ArrayBuffer>>();

  const held = (event: SoundEvent) => {
    for (const reason of holds.values()) {
      if (reason === "call") return true;
      if (event !== "record" && event !== "discard") return true;
    }
    return false;
  };

  const sound = (event: SoundEvent, style: SoundStyle, rate: number) => {
    const key = `${event}:${style}:${rate}`;
    let samples = rendered.get(key);
    if (!samples) {
      samples = renderSound(event, style, rate);
      rendered.set(key, samples);
    }
    return samples;
  };

  const emit = (event: SoundEvent, style: SoundStyle) => {
    if (!output) return;
    if (output.state === "suspended") void output.resume().catch(() => undefined);
    const samples = sound(event, style, output.sampleRate);
    const buffer = output.createBuffer(1, samples.length, output.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = output.createBufferSource();
    source.buffer = buffer;
    source.connect(output.destination);
    source.start();
  };

  /** Browsers only let a page make sound after the person clicked or typed in it: call from that gesture. */
  const unlock = () => {
    output ??= host.createOutput();
    if (output?.state === "suspended") void output.resume().catch(() => undefined);
  };

  return {
    unlock,
    unlocked: () => output !== null,
    hold(reason: HoldReason): () => void {
      const token = Symbol(reason);
      holds.set(token, reason);
      return () => void holds.delete(token);
    },
    play(event: SoundEvent): boolean {
      const choice = host.choice();
      if (choice === "off" || !output || held(event)) return false;
      if (host.background() && (!BACKGROUND_EVENTS.has(event) || !host.leader())) return false;
      const now = host.now();
      const last = lastPlayed.get(event);
      if (last !== undefined && now - last < REPEAT_WINDOW_MS) return false;
      lastPlayed.set(event, now);
      emit(event, choice);
      return true;
    },
    /** The sample a person hears when they pick a style; it comes from their click, so no other rule applies. */
    preview(style: SoundStyle) {
      unlock();
      emit("done", style);
    },
  };
}

export type SoundPlayer = ReturnType<typeof createSoundPlayer>;
