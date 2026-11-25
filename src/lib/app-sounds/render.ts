export const SOUND_EVENTS = ["send", "reply", "done", "attention", "approved", "error", "stop", "mention", "discard", "record"] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

export const SOUND_STYLES = ["tap", "click", "glass", "retro", "breeze"] as const;
export type SoundStyle = (typeof SOUND_STYLES)[number];

export type SoundChoice = SoundStyle | "off";

/** What can be rendered: every event, plus the sample a person hears when they pick a style. */
export type SoundCue = SoundEvent | "preview";

export const DEFAULT_SOUND_STYLE: SoundStyle = "tap";

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

/** The phrases click, glass and retro share; each of those styles only changes the voice that plays them. */
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
  /** Partials as [frequency ratio, level], with an optional decay of their own in seconds for a strike that fades first. */
  partials: Array<[number, number] | [number, number, number]>;
  wave: "sine" | "square";
  attack: number;
  /** Time constant of the decay after the attack, in seconds. */
  decay: number;
  release: number;
  /** Extra time after the last note for the room to ring out. */
  tail: number;
  room?: { delays: number[]; feedback: number; mix: number };
  /** Steps of the amplitude envelope; a coarse envelope gives a retro voice its steps. */
  levels?: number;
  /** Cut-off of a one-pole low-pass that softens the square edges, in hertz. */
  soften?: number;
  /** Length of the fade at each end, in seconds, when shorter than the default suits a short strike. */
  edge?: number;
}

export const VOICES: Record<SoundStyle, Voice> = {
  click: { partials: [[1, 1], [2, 0.16]], wave: "sine", attack: 0.0015, decay: 0.05, release: 0.02, tail: 0.03 },
  glass: {
    partials: [[1, 1], [2.97, 0.2], [5.43, 0.07]], wave: "sine", attack: 0.004, decay: 0.12, release: 0.04, tail: 0.2,
    room: { delays: [0.0231, 0.0297, 0.0373], feedback: 0.46, mix: 0.3 },
  },
  retro: { partials: [[1, 1]], wave: "square", attack: 0.001, decay: 0.08, release: 0.015, tail: 0.03, levels: 8, soften: 2800 },
  tap: {
    partials: [[1, 1], [3.93, 0.09, 0.012], [11.3, 0.04, 0.0014]], wave: "sine", attack: 0.0007, decay: 0.045, release: 0.012, tail: 0.01,
    edge: 0.0035,
  },
  breeze: {
    partials: [[1, 1], [2.01, 0.06], [4.07, 0.1, 0.05]], wave: "sine", attack: 0.006, decay: 0.16, release: 0.06, tail: 0.28,
    room: { delays: [0.0187, 0.0259, 0.0341, 0.0427], feedback: 0.56, mix: 0.34 },
  },
};

interface Tone {
  hz: number;
  at: number;
  hold: number;
  /** Share of the phrase's loudness, for an echo below the notes it repeats. */
  gain?: number;
  /** Starts at `from` times `hz` and settles on `hz` with time constant `settle`, in seconds. */
  glide?: { from: number; settle: number };
}

interface StylePhrase {
  tones: Tone[];
  level: number;
  limit: number;
  voice: Voice;
}

const tone = (hz: number, at: number, hold: number, extra: Partial<Tone> = {}): Tone => ({ hz, at, hold, ...extra });

/** Muffled and short, pitched low enough that no note stands out: stopping confirms quietly, the button already shows it. */
const thud = (hz: number, voice: Voice, level: number): StylePhrase => ({
  tones: [tone(hz, 0, 0.012, { glide: { from: 1.6, settle: 0.006 } })],
  level,
  limit: 0.06,
  voice: { ...voice, partials: [[1, 1]], wave: "sine", attack: 0.0012, decay: 0.011, release: 0.012, tail: 0, room: undefined, levels: undefined, soften: 900, edge: 0.0016 },
});

const TAP = VOICES.tap;
const tapStrike: Voice = { ...TAP, decay: 0.0075, release: 0.006, tail: 0 };
const tapTick: Voice = { ...TAP, partials: [[1, 1], [2.7, 0.2, 0.004]], decay: 0.005, release: 0.004, tail: 0 };
const tapLow: Voice = { ...TAP, partials: [[1, 1], [3.93, 0.05, 0.01]], decay: 0.02, release: 0.01, tail: 0, soften: 1800 };

const BREEZE = VOICES.breeze;
const breezeDry: Voice = { ...BREEZE, attack: 0.002, decay: 0.012, release: 0.006, tail: 0, room: undefined, edge: 0.0016 };
const breezeSend: Voice = { ...BREEZE, decay: 0.014, release: 0.02, tail: 0.1, room: { delays: [0.0187, 0.0259, 0.0341], feedback: 0.38, mix: 0.26 } };
const breezeLow: Voice = { ...BREEZE, decay: 0.06, release: 0.03, tail: 0.06, room: { delays: [0.0187, 0.0259], feedback: 0.3, mix: 0.2 } };


/** The styles with phrases of their own; each event keeps its role and its place among the others in loudness. */
const STYLE_PHRASES: Partial<Record<SoundStyle, Record<SoundCue, StylePhrase>>> = {
  tap: {
    send: { tones: [tone(622, 0, 0.016)], level: 0.52, limit: 0.05, voice: tapStrike },
    stop: thud(158, TAP, 0.56),
    reply: { tones: [tone(466, 0, 0.05), tone(554, 0.085, 0.07)], level: 0.72, limit: 0.3, voice: TAP },
    done: { tones: [tone(466, 0, 0.05), tone(554, 0.085, 0.07)], level: 0.72, limit: 0.3, voice: TAP },
    preview: { tones: [tone(370, 0, 0.045), tone(466, 0.07, 0.045), tone(554, 0.14, 0.08)], level: 0.86, limit: 0.35, voice: TAP },
    attention: { tones: [tone(740, 0, 0.045), tone(554, 0.075, 0.045), tone(740, 0.15, 0.08)], level: 0.86, limit: 0.35, voice: TAP },
    approved: { tones: [tone(554, 0, 0.04), tone(831, 0.065, 0.08)], level: 0.74, limit: 0.3, voice: TAP },
    mention: { tones: [tone(831, 0, 0.03), tone(932, 0.05, 0.03), tone(831, 0.1, 0.06)], level: 0.8, limit: 0.3, voice: TAP },
    error: { tones: [tone(415, 0, 0.06), tone(311, 0.09, 0.09)], level: 0.74, limit: 0.32, voice: tapLow },
    record: { tones: [tone(1245, 0, 0.008)], level: 0.48, limit: 0.03, voice: tapTick },
    discard: { tones: [tone(277, 0, 0.02)], level: 0.36, limit: 0.07, voice: tapLow },
  },
  breeze: {
    send: { tones: [tone(1245, 0, 0.025, { glide: { from: 0.95, settle: 0.012 } })], level: 0.41, limit: 0.16, voice: breezeSend },
    stop: thud(205, BREEZE, 0.54),
    reply: { tones: [tone(932, 0, 0.05), tone(1109, 0.09, 0.1)], level: 0.7, limit: 0.65, voice: BREEZE },
    done: { tones: [tone(932, 0, 0.05), tone(1109, 0.09, 0.1)], level: 0.7, limit: 0.65, voice: BREEZE },
    preview: { tones: [tone(740, 0, 0.05), tone(932, 0.08, 0.05), tone(1109, 0.16, 0.12)], level: 0.84, limit: 0.75, voice: BREEZE },
    attention: { tones: [tone(1480, 0, 0.05), tone(1109, 0.085, 0.05), tone(1480, 0.17, 0.12)], level: 0.84, limit: 0.75, voice: BREEZE },
    approved: { tones: [tone(1109, 0, 0.05), tone(1661, 0.075, 0.12)], level: 0.74, limit: 0.65, voice: BREEZE },
    mention: { tones: [tone(1661, 0, 0.035), tone(1865, 0.055, 0.035), tone(1661, 0.11, 0.09)], level: 0.78, limit: 0.6, voice: BREEZE },
    error: { tones: [tone(622, 0, 0.07), tone(466, 0.1, 0.12)], level: 0.72, limit: 0.45, voice: breezeLow },
    record: { tones: [tone(2490, 0, 0.006)], level: 0.46, limit: 0.04, voice: breezeDry },
    discard: { tones: [tone(554, 0, 0.02)], level: 0.34, limit: 0.06, voice: breezeDry },
  },
};

/** The notes, voice, loudness and longest length one cue gets in one style. */
export function phraseOf(cue: SoundCue, style: SoundStyle): { tones: Tone[]; level: number; limit: number; voice: Voice } {
  const own = STYLE_PHRASES[style]?.[cue];
  if (own) return own;
  const shared = PHRASES[cue === "preview" ? "done" : cue];
  return { tones: shared.notes.map((one) => tone(stepFrequency(one.step), one.at, one.hold)), level: shared.level, limit: shared.limit, voice: VOICES[style] };
}

const EDGE_FADE = 0.005;

function envelope(voice: Voice, t: number, hold: number): number {
  if (t < 0) return 0;
  const body = t < voice.attack ? t / voice.attack : Math.exp(-(t - voice.attack) / voice.decay);
  const gate = t <= hold ? 1 : Math.max(0, 1 - (t - hold) / voice.release);
  const level = body * gate;
  return voice.levels ? Math.round(level * voice.levels) / voice.levels : level;
}

function oscillator(voice: Voice, phase: number): number {
  const value = Math.sin(phase);
  return voice.wave === "sine" ? value : value >= 0 ? 1 : -1;
}

/** Elapsed cycles at time `t` of a tone, counted in seconds at its settled pitch: a glide runs ahead or behind early on. */
function elapsed(one: Tone, t: number): number {
  if (!one.glide) return t;
  const { from, settle } = one.glide;
  return t + (from - 1) * settle * (1 - Math.exp(-t / settle));
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
export function renderSound(cue: SoundCue, style: SoundStyle, rate: number): Float32Array<ArrayBuffer> {
  const { tones, level: loudness, limit, voice } = phraseOf(cue, style);
  const end = Math.max(...tones.map((one) => one.at + one.hold + voice.release));
  const seconds = Math.min(limit, end + voice.tail);
  const samples = new Float32Array(Math.max(1, Math.floor(seconds * rate)));
  for (const one of tones) {
    const frequency = one.hz;
    const first = Math.floor(one.at * rate);
    const last = Math.min(samples.length, Math.ceil((one.at + one.hold + voice.release) * rate));
    for (let i = first; i < last; i++) {
      const t = i / rate - one.at;
      const level = envelope(voice, t, one.hold);
      if (level === 0) continue;
      const time = elapsed(one, t);
      let value = 0;
      for (const [ratio, gain, fade] of voice.partials) {
        const part = gain * oscillator(voice, 2 * Math.PI * frequency * ratio * time);
        value += fade === undefined ? part : part * Math.exp(-t / fade);
      }
      samples[i] += one.gain === undefined ? value * level : value * level * one.gain;
    }
  }
  if (voice.soften) soften(samples, rate, voice.soften);
  if (voice.room) addRoom(samples, rate, voice.room);
  const fade = Math.max(1, Math.round((voice.edge ?? EDGE_FADE) * rate));
  for (let i = 0; i < Math.min(fade, samples.length); i++) {
    const gain = (1 - Math.cos((Math.PI * i) / fade)) / 2;
    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? (SOUND_PEAK * loudness) / peak : 0;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  return samples;
}
