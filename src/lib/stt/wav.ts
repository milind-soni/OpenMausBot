// 16 kHz mono s16le PCM -> WAV bytes, the only format /api/stt/transcribe accepts.
export const STT_SAMPLE_RATE = 16_000;

export function encodeWav(frames: readonly Int16Array[], sampleRate = STT_SAMPLE_RATE): Uint8Array {
  let samples = 0;
  for (const frame of frames) samples += frame.length;
  const dataBytes = samples * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++, offset += 2) view.setInt16(offset, frame[i]!, true);
  }
  return out;
}

export function durationMs(frames: readonly Int16Array[], sampleRate = STT_SAMPLE_RATE): number {
  let samples = 0;
  for (const frame of frames) samples += frame.length;
  return (samples / sampleRate) * 1000;
}
