import type { LivePlaybackCredit } from "../shared/live-pcm-wire.ts";
import type { LiveMediaConsumer } from "./qwen-live-socket.ts";

export interface LiveSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  bindMedia?(media: LiveMediaConsumer, playbackFlow?: "credit-v1"): boolean;
  appendPcm?(pcm: Uint8Array): boolean;
  playbackCredit?(credit: LivePlaybackCredit): boolean;
}
