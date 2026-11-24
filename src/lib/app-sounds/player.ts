import { renderSound, type SoundChoice, type SoundEvent, type SoundStyle } from "./render";

/** What a hidden or unfocused window may still play: the person is not looking, so only what asks for them. */
export const BACKGROUND_EVENTS: ReadonlySet<SoundEvent> = new Set(["attention", "mention", "done", "error"]);

export const REPEAT_WINDOW_MS = 150;
/** How long a suspended context gets to wake before the cue is left to the system chime. */
export const RESUME_DEADLINE_MS = 300;

export type HoldReason = "recording" | "call";

/** What became of one sound: heard, kept quiet on purpose, or one the app cannot make here, which the system chime stands in for. */
export type SoundOutcome = "played" | "silenced" | "unplayable";
export type SoundDecision = SoundOutcome | Promise<SoundOutcome>;
/** `elsewhere`: this window is in the background and another one is the window in use, so that one decides. */
export type PlayOutcome = SoundOutcome | "elsewhere";
export type PlayDecision = PlayOutcome | Promise<PlayOutcome>;

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

  const emit = (out: SoundOutput, event: SoundEvent, style: SoundStyle) => {
    const samples = sound(event, style, out.sampleRate);
    const buffer = out.createBuffer(1, samples.length, out.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = out.createBufferSource();
    source.buffer = buffer;
    source.connect(out.destination);
    source.start();
  };

  /** A suspended context only counts once it woke within the deadline; until then anything may have asked for quiet,
   * and what asked for quiet keeps the system chime quiet too. */
  const emitWhenRunning = (event: SoundEvent, style: SoundStyle, quiet: () => boolean): SoundDecision => {
    const out = output;
    if (!out) return "unplayable";
    if (out.state === "running") {
      emit(out, event, style);
      return "played";
    }
    if (out.state !== "suspended") return "unplayable";
    return new Promise<SoundOutcome>((resolve) => {
      let open = true;
      const settle = (outcome: SoundOutcome) => {
        if (!open) return;
        open = false;
        clearTimeout(deadline);
        if (outcome === "played") emit(out, event, style);
        resolve(outcome);
      };
      const fallBack = () => settle(quiet() ? "silenced" : "unplayable");
      const deadline = setTimeout(fallBack, RESUME_DEADLINE_MS);
      out.resume().then(() => (quiet() ? settle("silenced") : out.state === "running" ? settle("played") : fallBack()), fallBack);
    });
  };

  /** Browsers only let a page make sound after the person clicked or typed in it: call from that gesture. */
  const unlock = () => {
    output ??= host.createOutput();
    if (output?.state === "suspended") void output.resume().catch(() => undefined);
  };

  return {
    unlock,
    holding: () => holds.size > 0,
    hold(reason: HoldReason): () => void {
      const token = Symbol(reason);
      holds.set(token, reason);
      return () => void holds.delete(token);
    },
    /** `wanted`: asked again once a suspended context wakes, for what may have changed meanwhile (a notice read). */
    play(event: SoundEvent, wanted: () => boolean = () => true): PlayDecision {
      const choice = host.choice();
      if (choice === "off" || held(event)) return "silenced";
      if (host.background() && !BACKGROUND_EVENTS.has(event)) return "silenced";
      if (host.background() && !host.leader()) return "elsewhere";
      if (!output) return "unplayable";
      const now = host.now();
      const last = lastPlayed.get(event);
      if (last !== undefined && now - last < REPEAT_WINDOW_MS) return "silenced";
      lastPlayed.set(event, now);
      return emitWhenRunning(event, choice, () => host.choice() === "off" || held(event) || !wanted());
    },
    /** The sample a person hears when they pick a style, from their own click; a call or a recording keeps it quiet. */
    preview(style: SoundStyle): SoundDecision {
      if (holds.size > 0) return "silenced";
      unlock();
      return emitWhenRunning("done", style, () => holds.size > 0);
    },
  };
}

export type SoundPlayer = ReturnType<typeof createSoundPlayer>;
