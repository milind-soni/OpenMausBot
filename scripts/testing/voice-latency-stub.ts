// Record-protocol TTS endpoint for the voice-latency cut (2026-10-17): the
// record runs never call the live engine and never read an engine key
// (Brad's directive, 2026-10-17). This loopback server speaks the ElevenLabs
// wire shape the provider module uses (server/tts/elevenlabs.ts) with
// synthesis latency and clip duration modeled from the text length at the
// RTF pinned in the corpus manifest, so both sides of the before/after
// measurement share one deterministic synthesis timeline.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SYNTHESIS } from "./voice-latency-corpus.ts";

/** Labels the run log carries on both sides; the provider module pins the
 * same model string in its synthesize call. */
export const STUB_MODEL = "eleven_flash_v2_5";
export const STUB_VOICE = "omb-stub-voice";
/** A literal, not a secret: the config schema requires a key and the provider
 * sends one, but it only ever reaches this loopback stub, which ignores it. */
export const STUB_KEY = "omb-record-stub";

/** Modeled synthesis latency: RTF × modeled clip duration, one value per
 * text char. 319 chars → 11,165 ms, the pinned 11.2 s worst case. */
export const synthesisDelayMs = (chars: number): number =>
  chars * SYNTHESIS.rtf * SYNTHESIS.audioMsPerChar;

/** Chunks a streamed response is spread over. */
const STREAM_CHUNKS = 8;

// One MPEG-1 Layer III frame at the requested wire format (44.1 kHz, 64 kbps,
// mono, no CRC): 208 bytes = 144 × 64000 / 44100. A zero payload decodes as
// silence; the frame count sets the duration the browser actually plays.
const FRAME_HEADER = Uint8Array.of(0xff, 0xfb, 0x50, 0xc0);
const FRAME_BYTES = 208;
const FRAME_MS = 1152 / 44.1;

export function silenceMp3(durationMs: number): Buffer {
  const frames = Math.max(1, Math.round(durationMs / FRAME_MS));
  const frame = Buffer.alloc(FRAME_BYTES);
  frame.set(FRAME_HEADER, 0);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

export interface VoiceLatencyStub {
  url: string;
  close(): Promise<void>;
}

export function launchVoiceLatencyStub(): Promise<VoiceLatencyStub> {
  const { promise, resolve, reject } = Promise.withResolvers<VoiceLatencyStub>();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const fail = (status: number, detail: string): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail }));
    };
    if (req.method === "GET" && path === "/voices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices: [{ voice_id: STUB_VOICE, name: "OMB record stub" }] }));
      return;
    }
    const streamPath = /^\/text-to-speech\/[^/]+\/stream$/.test(path);
    const legacyPath = /^\/text-to-speech\/[^/]+$/.test(path);
    if (req.method === "POST" && (streamPath || legacyPath)) {
      const streamRequested =
        streamPath || new URL(req.url ?? "/", "http://stub").searchParams.get("stream") === "true";
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", () => fail(400, "body read failed"));
      req.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return fail(400, "body is not JSON");
        }
        if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" || !body.text) {
          return fail(400, "text required");
        }
        const chars = [...body.text].length;
        const bytes = silenceMp3(chars * SYNTHESIS.audioMsPerChar);
        const totalMs = synthesisDelayMs(chars);
        if (!streamRequested) {
          // Non-stream delivery, modeled: the complete clip lands at once at
          // the whole-clip synthesis time.
          setTimeout(() => {
            res.writeHead(200, {
              "content-type": "audio/mpeg",
              "content-length": String(bytes.byteLength),
            });
            res.end(bytes);
          }, totalMs);
          return;
        }
        // Streamed delivery, modeled: first chunk at the pinned first-byte
        // latency, the rest spread so the last byte still lands at the
        // whole-clip synthesis time — generation is unchanged, delivery streams.
        const firstAt = Math.min(SYNTHESIS.firstByteMs, totalMs / 2);
        const chunkBytes = Math.ceil(bytes.byteLength / STREAM_CHUNKS);
        res.writeHead(200, { "content-type": "audio/mpeg" });
        for (let j = 0; j < STREAM_CHUNKS; j += 1) {
          const chunk = bytes.subarray(j * chunkBytes, Math.min((j + 1) * chunkBytes, bytes.byteLength));
          setTimeout(() => res.write(chunk), Math.round(firstAt + ((totalMs - firstAt) * j) / (STREAM_CHUNKS - 1)));
        }
        setTimeout(() => res.end(), totalMs);
        return;
      });
      return;
    }
    fail(404, `no such stub route: ${req.method} ${path}`);
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    // listen's callback fires with the bound socket populated.
    const address = server.address() as AddressInfo;
    const closed = Promise.withResolvers<void>();
    resolve({
      url: `http://127.0.0.1:${address.port}`,
      close: () => {
        server.close(() => closed.resolve());
        return closed.promise;
      },
    });
  });
  return promise;
}
