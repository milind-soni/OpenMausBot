/** omp's RPC v2 splits a frame over 1 MiB into base64 `rpc_chunk` pieces (`chunkId`/`count`/
 *  `byteLength` per frame, sequential `index`, `data` per piece). Any inconsistency drops the sequence. */
export class PiRpcChunks {
  /** omp's advertised cap on one reassembled frame. */
  static readonly MAX_BYTES = 64 * 1024 * 1024;
  /** omp's cap on one decoded piece, which also bounds the piece count. */
  static readonly MAX_PIECE_BYTES = 256 * 1024;
  static readonly MAX_COUNT = PiRpcChunks.MAX_BYTES / PiRpcChunks.MAX_PIECE_BYTES;
  private chunkId: string | null = null;
  private count = 0;
  private byteLength = 0;
  private bytes = 0;
  private parts: Buffer[] = [];

  accept(message: Record<string, unknown>): Record<string, unknown> | null {
    const { chunkId, index, count, byteLength, data } = message;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || typeof data !== "string" ||
      data.length === 0 || data.length > Math.ceil(PiRpcChunks.MAX_PIECE_BYTES / 3) * 4 ||
      !Number.isInteger(index) || !Number.isInteger(count) || !Number.isInteger(byteLength) ||
      (index as number) < 0 || (count as number) < 2 || (count as number) > PiRpcChunks.MAX_COUNT ||
      (index as number) >= (count as number) ||
      (byteLength as number) < 0 || (byteLength as number) > PiRpcChunks.MAX_BYTES
    ) {
      this.reset();
      return null;
    }
    if (chunkId !== this.chunkId) {
      if (index !== 0) {
        this.reset();
        return null;
      }
      this.chunkId = chunkId;
      this.count = count as number;
      this.byteLength = byteLength as number;
      this.parts = [];
      this.bytes = 0;
    } else if (count !== this.count || byteLength !== this.byteLength) {
      this.reset();
      return null;
    }
    const part = Buffer.from(data, "base64");
    // An empty piece would let a sequence grow without approaching `byteLength`.
    if (
      index !== this.parts.length || part.length === 0 || part.length > PiRpcChunks.MAX_PIECE_BYTES ||
      this.bytes + part.length > this.byteLength
    ) {
      this.reset();
      return null;
    }
    this.parts.push(part);
    this.bytes += part.length;
    if (this.parts.length < this.count) return null;
    const complete = this.bytes === this.byteLength;
    const text = Buffer.concat(this.parts).toString("utf8");
    this.reset();
    if (!complete) return null;
    try {
      const frame = JSON.parse(text) as unknown;
      return frame && typeof frame === "object" && !Array.isArray(frame)
        ? frame as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private reset(): void {
    this.chunkId = null;
    this.count = 0;
    this.byteLength = 0;
    this.bytes = 0;
    this.parts = [];
  }
}

export function decodePiFrame(line: string, chunks: PiRpcChunks): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const frame = parsed as Record<string, unknown>;
  return frame.type === "rpc_chunk" ? chunks.accept(frame) : frame;
}

const PI_MAX_LINE = PiRpcChunks.MAX_BYTES;

export function piLineReader(onLine: (line: string) => boolean | void): (chunk: string) => void {
  let buf = "";
  let dropping = false;
  return (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (line.length > PI_MAX_LINE || !line.trim()) continue;
      if (onLine(line)) return;
    }
    if (buf.length > PI_MAX_LINE) {
      buf = "";
      dropping = true;
    }
  };
}
