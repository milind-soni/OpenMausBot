export const SOUND_EVENTS = ["send", "reply", "done", "attention", "approved", "error", "stop", "mention", "discard", "record"] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

export const SOUND_STYLES = ["click", "glass", "retro"] as const;
export type SoundStyle = (typeof SOUND_STYLES)[number];

export type SoundChoice = SoundStyle | "off";

export const DEFAULT_SOUND_STYLE: SoundStyle = "click";

/** The loudest sample any sound reaches, as a share of full scale. */
export const SOUND_PEAK = 0.35;

interface Note {
  /** A degree of the scale below: 0 is the tonic, 5 the tonic an octave up, -5 an octave down. */
  step: number;
  at: number;
  hold: number;
}

interface Phrase {
  notes: Note[];
  level: number;
  /** The longest the rendered sound may last, tail included, in seconds. */
  limit: number;
}

const note = (step: number, at: number, hold: number): Note => ({ step, at, hold });

export const PHRASES: Record<SoundEvent, Phrase> = {
  send: { notes: [note(2, 0, 0.04), note(4, 0.05, 0.06)], level: 0.8, limit: 0.4 },
  reply: { notes: [note(4, 0, 0.05), note(2, 0.065, 0.09)], level: 0.75, limit: 0.45 },
  done: { notes: [note(0, 0, 0.05), note(2, 0.07, 0.05), note(5, 0.14, 0.16)], level: 1, limit: 0.7 },
  attention: { notes: [note(5, 0, 0.06), note(3, 0.09, 0.06), note(5, 0.19, 0.12)], level: 1, limit: 0.7 },
  approved: { notes: [note(3, 0, 0.05), note(6, 0.065, 0.13)], level: 0.9, limit: 0.55 },
  error: { notes: [note(-1, 0, 0.08), note(-3, 0.1, 0.15)], level: 0.9, limit: 0.6 },
  stop: { notes: [note(-2, 0, 0.07)], level: 0.7, limit: 0.35 },
  mention: { notes: [note(6, 0, 0.04), note(8, 0.055, 0.04), note(6, 0.12, 0.1)], level: 0.95, limit: 0.55 },
  discard: { notes: [note(-4, 0, 0.045)], level: 0.45, limit: 0.2 },
  record: { notes: [note(3, 0, 0.025)], level: 0.65, limit: 0.09 },
};

const PENTATONIC = [0, 2, 4, 7, 9];
const TONIC_MIDI = 74;

export function stepFrequency(step: number): number {
  const octave = Math.floor(step / PENTATONIC.length);
  const degree = step - octave * PENTATONIC.length;
  const midi = TONIC_MIDI + octave * 12 + PENTATONIC[degree];
  return 440 * 2 ** ((midi - 69) / 12);
}

interface Voice {
  /** Partials as [frequency ratio, level]. */
  partials: Array<[number, number]>;
  wave: "sine" | "square";
  attack: number;
  /** Time constant of the decay after the attack, in seconds. */
  decay: number;
  release: number;
  /** Extra time after the last note for the room to ring out. */
  tail: number;
  room?: { delays: number[]; feedback: number; mix: number };
  /** Steps of the amplitude envelope; a coarse envelope is what makes a chip voice. */
  levels?: number;
  /** Cut-off of a one-pole low-pass that softens the square edges, in hertz. */
  soften?: number;
}

export const VOICES: Record<SoundStyle, Voice> = {
  click: { partials: [[1, 1], [2, 0.16]], wave: "sine", attack: 0.0015, decay: 0.05, release: 0.02, tail: 0.03 },
  glass: {
    partials: [[1, 1], [2.97, 0.2], [5.43, 0.07]], wave: "sine", attack: 0.004, decay: 0.12, release: 0.04, tail: 0.2,
    room: { delays: [0.0231, 0.0297, 0.0373], feedback: 0.46, mix: 0.3 },
  },
  retro: { partials: [[1, 1]], wave: "square", attack: 0.001, decay: 0.08, release: 0.015, tail: 0.03, levels: 8, soften: 2800 },
};

const EDGE_FADE = 0.005;

function envelope(voice: Voice, t: number, hold: number): number {
  if (t < 0) return 0;
  const body = t < voice.attack ? t / voice.attack : Math.exp(-(t - voice.attack) / voice.decay);
  const gate = t <= hold ? 1 : Math.max(0, 1 - (t - hold) / voice.release);
  const level = body * gate;
  return voice.levels ? Math.round(level * voice.levels) / voice.levels : level;
}

function oscillator(wave: Voice["wave"], phase: number): number {
  const value = Math.sin(phase);
  return wave === "sine" ? value : value >= 0 ? 1 : -1;
}

function addRoom(samples: Float32Array, rate: number, room: NonNullable<Voice["room"]>): void {
  const dry = Float32Array.from(samples);
  const wet = new Float32Array(samples.length);
  for (const delay of room.delays) {
    const lag = Math.max(1, Math.round(delay * rate));
    const line = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      line[i] = dry[i] + (i >= lag ? line[i - lag] * room.feedback : 0);
      wet[i] += line[i] / room.delays.length;
    }
  }
  for (let i = 0; i < samples.length; i++) samples[i] = dry[i] * (1 - room.mix) + wet[i] * room.mix;
}

function soften(samples: Float32Array, rate: number, cutoff: number): void {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
  let previous = 0;
  for (let i = 0; i < samples.length; i++) {
    previous += k * (samples[i] - previous);
    samples[i] = previous;
  }
}

/** One sound as mono samples at `rate`: silent at both ends, its peak at `SOUND_PEAK` times the phrase's level. */
export function renderSound(event: SoundEvent, style: SoundStyle, rate: number): Float32Array<ArrayBuffer> {
  const phrase = PHRASES[event];
  const voice = VOICES[style];
  const end = Math.max(...phrase.notes.map((one) => one.at + one.hold + voice.release));
  const seconds = Math.min(phrase.limit, end + voice.tail);
  const samples = new Float32Array(Math.max(1, Math.floor(seconds * rate)));
  for (const one of phrase.notes) {
    const frequency = stepFrequency(one.step);
    const first = Math.floor(one.at * rate);
    const last = Math.min(samples.length, Math.ceil((one.at + one.hold + voice.release) * rate));
    for (let i = first; i < last; i++) {
      const t = i / rate - one.at;
      const level = envelope(voice, t, one.hold);
      if (level === 0) continue;
      let value = 0;
      for (const [ratio, gain] of voice.partials) value += gain * oscillator(voice.wave, 2 * Math.PI * frequency * ratio * t);
      samples[i] += value * level;
    }
  }
  if (voice.soften) soften(samples, rate, voice.soften);
  if (voice.room) addRoom(samples, rate, voice.room);
  const fade = Math.max(1, Math.round(EDGE_FADE * rate));
  for (let i = 0; i < Math.min(fade, samples.length); i++) {
    const gain = (1 - Math.cos((Math.PI * i) / fade)) / 2;
    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? (SOUND_PEAK * phrase.level) / peak : 0;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  return samples;
}
