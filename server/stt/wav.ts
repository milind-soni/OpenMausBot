// Strict WAV gate for /api/stt/transcribe. The route only accepts exactly
// what the renderer's capture pipeline produces (RIFF, PCM, mono, 16-bit,
// 16 kHz). Rejecting everything else keeps the endpoint from becoming a
// general-purpose upload proxy onto the user's billed STT account.
import type { Utterance } from "./types.ts";

export const STT_SAMPLE_RATE = 16_000;
/** 30 s of 16 kHz s16 mono plus header slack. The renderer force-ends an
 * utterance before this, so hitting it means a misbehaving client. */
export const MAX_UTTERANCE_MS = 30_000;
export const MAX_WAV_BYTES = 44 + (STT_SAMPLE_RATE * 2 * MAX_UTTERANCE_MS) / 1000 + 1024;
/** Shorter than this is a click or a breath, never a sentence. */
export const MIN_UTTERANCE_MS = 150;

export class InvalidAudio extends Error {
  readonly status: number;

  constructor(message: string, status = 415) {
    super(message);
    this.status = status;
  }
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function parseUtteranceWav(bytes: Uint8Array): Utterance {
  if (bytes.byteLength > MAX_WAV_BYTES) throw new InvalidAudio("utterance is too long", 413);
  if (bytes.byteLength < 44 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") {
    throw new InvalidAudio("expected a WAV file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmtSeen = false;
  let dataBytes = -1;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) throw new InvalidAudio("malformed WAV header");
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bits !== 16 || sampleRate !== STT_SAMPLE_RATE) {
        throw new InvalidAudio("audio must be 16 kHz mono 16-bit PCM");
      }
      fmtSeen = true;
    } else if (id === "data") {
      dataBytes = Math.min(size, bytes.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmtSeen || dataBytes < 0) throw new InvalidAudio("malformed WAV header");
  const durationMs = Math.round((dataBytes / 2 / STT_SAMPLE_RATE) * 1000);
  if (durationMs > MAX_UTTERANCE_MS + 250) throw new InvalidAudio("utterance is too long", 413);
  return { wav: bytes, sampleRate: STT_SAMPLE_RATE, durationMs };
}
