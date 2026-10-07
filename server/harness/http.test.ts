import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { readBody } from "./http.ts";

/** A request body that arrives in exactly these chunks. */
const request = (chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;

/** Split a UTF-8 buffer inside the first multi-byte character after `from`. */
function splitInsideCharacter(bytes: Buffer, from: number): [Buffer, Buffer] {
  let cut = from;
  while ((bytes[cut]! & 0xc0) !== 0x80) cut += 1;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

describe("readBody", () => {
  it("keeps a character whole when a chunk boundary splits it", async () => {
    const text = "مرحبا بالعالم 中文 😀 ".repeat(50);
    const bytes = Buffer.from(JSON.stringify({ text }));
    const body = await readBody(request(splitInsideCharacter(bytes, 100)));
    expect(body.text).toBe(text);
  });

  it("keeps every character whole across many small chunks", async () => {
    const text = "مرحبا 中文 😀".repeat(20);
    const bytes = Buffer.from(JSON.stringify({ text }));
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 7) chunks.push(bytes.subarray(at, at + 7));
    const body = await readBody(request(chunks));
    expect(body.text).toBe(text);
  });

  it("still refuses a body over the limit", async () => {
    const bytes = Buffer.from(JSON.stringify({ text: "中".repeat(100) }));
    await expect(readBody(request(splitInsideCharacter(bytes, 10)), 64)).rejects.toMatchObject({ status: 413 });
  });
});
