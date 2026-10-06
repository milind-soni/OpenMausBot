/** Languages the composer microphone offers. Whisper codes are the `-l` values. */
export interface DictationLanguage {
  id: string;
  /** Shown as-is. Endonyms stay readable without a translation pass. */
  label: string;
  whisper: string;
  /** BCP-47 tag for the platform recognizer. Empty means no override. */
  tag: string;
}

export const DICTATION_LANGUAGES: readonly DictationLanguage[] = [
  { id: "auto", label: "Auto", whisper: "auto", tag: "" },
  { id: "en", label: "English", whisper: "en", tag: "en-US" },
  { id: "he", label: "עברית", whisper: "he", tag: "he-IL" },
  { id: "es", label: "Español", whisper: "es", tag: "es-ES" },
  { id: "fr", label: "Français", whisper: "fr", tag: "fr-FR" },
  { id: "de", label: "Deutsch", whisper: "de", tag: "de-DE" },
  { id: "pt", label: "Português", whisper: "pt", tag: "pt-BR" },
  { id: "it", label: "Italiano", whisper: "it", tag: "it-IT" },
  { id: "nl", label: "Nederlands", whisper: "nl", tag: "nl-NL" },
  { id: "ru", label: "Русский", whisper: "ru", tag: "ru-RU" },
  { id: "ar", label: "العربية", whisper: "ar", tag: "ar" },
  { id: "hi", label: "हिन्दी", whisper: "hi", tag: "hi-IN" },
  { id: "zh", label: "中文", whisper: "zh", tag: "zh-CN" },
  { id: "ja", label: "日本語", whisper: "ja", tag: "ja-JP" },
  { id: "ko", label: "한국어", whisper: "ko", tag: "ko-KR" },
  { id: "tr", label: "Türkçe", whisper: "tr", tag: "tr-TR" },
  { id: "pl", label: "Polski", whisper: "pl", tag: "pl-PL" },
];

export const WHISPER_MODEL = {
  id: "whisper-large-v3-turbo",
  label: "Whisper Large v3 Turbo",
  fileName: "ggml-large-v3-turbo.bin",
  aboutBytes: 1_600_000_000,
} as const;

export const DICTATION_LANGUAGE_STORAGE_KEY = "openmausbot.dictation.language";

export function dictationLanguage(id: string | null | undefined): DictationLanguage {
  return DICTATION_LANGUAGES.find((language) => language.id === id) ?? DICTATION_LANGUAGES[0];
}

/**
 * A microphone click records only when an engine is already connected.
 * Otherwise it only alerts; the session starts after that download finishes.
 */
export function dictationClickAction(input: { listening: boolean; engineReady: boolean }): "stop" | "start" | "alert" {
  if (input.listening) return "stop";
  if (input.engineReady) return "start";
  return "alert";
}

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/** Linear resample. Dictation captures at the device rate and Whisper wants 16 kHz. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[Math.min(index + 1, input.length - 1)] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}
