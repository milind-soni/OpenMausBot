// Length-prefixed framing for the staging and result streams.
//
// Staged task files are binary and can total 200 MB, so they ride a raw stream
// on the worker companion's stdin rather than the line-oriented JSON wire the
// companion's other operations use. One frame is a 4-byte big-endian header
// length, a JSON header, then exactly the payload bytes that header declares —
// no delimiter a payload could forge, and no base64 inflation against the size
// ceilings.
//
// worker-companion/src/frames.ts is the other end of this format. They are
// duplicated rather than imported because the companion ships to the worker as
// a standalone package with no view of this tree; server/worker-task-frames
// .test.ts drives one against the other so they cannot drift.
import { Buffer } from "node:buffer";

export const FRAME_HEADER_PREFIX_BYTES = 4;
export const MAX_FRAME_HEADER_BYTES = 4096;
export const MAX_FRAME_PAYLOAD_BYTES = 50 * 1024 * 1024;

export type FrameKind = "manifest" | "file" | "end";

export interface FrameHeader {
  kind: FrameKind;
  /** Exact payload length following this header. `end` always carries 0. */
  bytes: number;
  /** Present only on `file`: the manifest-relative path being staged. */
  path?: string;
  /** Present only on `file`: the digest the payload must hash to. */
  sha256?: string;
}

function assertHeader(header: FrameHeader): void {
  if (!["manifest", "file", "end"].includes(header.kind)) throw new Error("unknown frame kind");
  if (!Number.isSafeInteger(header.bytes) || header.bytes < 0 || header.bytes > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error("frame payload length is out of range");
  }
  if (header.kind === "end" && header.bytes !== 0) throw new Error("end frame cannot carry a payload");
  if (header.kind === "file" && (!header.path || !header.sha256)) {
    throw new Error("file frame needs a path and a digest");
  }
}

export function encodeFrameHeader(header: FrameHeader): Buffer {
  assertHeader(header);
  const json = Buffer.from(JSON.stringify(header), "utf8");
  if (json.length > MAX_FRAME_HEADER_BYTES) throw new Error("frame header is too large");
  const prefix = Buffer.alloc(FRAME_HEADER_PREFIX_BYTES);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json]);
}

export function encodeFrame(header: FrameHeader, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length !== header.bytes) throw new Error("frame payload length does not match its header");
  return Buffer.concat([encodeFrameHeader(header), payload]);
}

export const END_FRAME = encodeFrame({ kind: "end", bytes: 0 });

export interface FrameHandlers {
  /** A header has been read; its payload follows in zero or more chunks. */
  onHeader: (header: FrameHeader) => void;
  /** A slice of the current frame's payload, in order. */
  onPayload: (chunk: Buffer) => void;
  /** The current frame's payload is complete. */
  onFrameEnd: (header: FrameHeader) => void;
}

/** Incremental reader. Payload chunks are handed straight through so a 50 MB
 * file is written to disk as it arrives rather than held whole in memory. */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);
  private header: FrameHeader | null = null;
  private remaining = 0;
  private finished = false;

  private readonly handlers: FrameHandlers;

  // Assigned in the body, not as a constructor parameter property: the
  // packaged server runs under Node's strip-only TypeScript mode, which
  // rejects `constructor(private readonly x: T)`. tsc and vitest both
  // transpile, so only booting the real server catches it.
  constructor(handlers: FrameHandlers) {
    this.handlers = handlers;
  }

  /** True once an `end` frame has been read; further bytes are an error. */
  get done(): boolean {
    return this.finished;
  }

  push(chunk: Buffer): void {
    if (this.finished) throw new Error("frame stream continued past its end frame");
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    for (;;) {
      if (this.header === null) {
        if (this.pending.length < FRAME_HEADER_PREFIX_BYTES) return;
        const length = this.pending.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_HEADER_BYTES) throw new Error("frame header length is out of range");
        if (this.pending.length < FRAME_HEADER_PREFIX_BYTES + length) return;
        const json = this.pending.subarray(FRAME_HEADER_PREFIX_BYTES, FRAME_HEADER_PREFIX_BYTES + length).toString("utf8");
        this.pending = this.pending.subarray(FRAME_HEADER_PREFIX_BYTES + length);
        this.header = parseFrameHeader(json);
        this.remaining = this.header.bytes;
        this.handlers.onHeader(this.header);
      }
      if (this.remaining > 0) {
        if (this.pending.length === 0) return;
        const take = Math.min(this.remaining, this.pending.length);
        this.handlers.onPayload(this.pending.subarray(0, take));
        this.pending = this.pending.subarray(take);
        this.remaining -= take;
        if (this.remaining > 0) return;
      }
      const complete = this.header;
      this.header = null;
      this.handlers.onFrameEnd(complete);
      if (complete.kind === "end") {
        this.finished = true;
        if (this.pending.length > 0) throw new Error("frame stream continued past its end frame");
        return;
      }
    }
  }

  /** Called when the source stream closes. A stream that stopped mid-frame, or
   * before its end frame, is truncated — never silently accept it. */
  end(): void {
    if (!this.finished) throw new Error("frame stream ended before its end frame");
  }
}

function parseFrameHeader(json: string): FrameHeader {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("frame header is not JSON");
  }
  if (value === null || !(value instanceof Object) || Array.isArray(value)) {
    throw new Error("frame header must be an object");
  }
  // SAFETY: shape is checked field by field in assertHeader below, which
  // rejects anything this cast would otherwise let through.
  const header = value as FrameHeader;
  assertHeader(header);
  return header;
}
