import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ledgerRows } from "./ledger.ts";

const fault = vi.hoisted(() => ({ file: "", line: "", enabled: false, reads: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { Readable } = await import("node:stream");
  return { ...fs, createReadStream: (path: Parameters<typeof fs.createReadStream>[0], options: Parameters<typeof fs.createReadStream>[1]) => {
    if (String(path) !== fault.file || !fault.enabled) return fs.createReadStream(path, options);
    fault.reads++;
    const stream = Readable.from((async function* () {
      yield fault.line;
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw Object.assign(new Error("fixture read failed after a complete row"), { code: "EIO" });
    })(), { encoding: "utf8", objectMode: false });
    return Object.assign(stream, { bytesRead: Buffer.byteLength(fault.line) }) as ReturnType<typeof fs.createReadStream>;
  } };
});

const dirs: string[] = [];
const at = "2026-11-13T12:00:00.000Z";
const row = (id: string) => `${JSON.stringify({ at, botId: "bot", model: "model", input: 10, output: 2, costUsd: 0.25, threadId: id, trigger: { kind: "owner" } })}\n`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-ledger-read-")); dirs.push(dir);
  mkdirSync(join(dir, "usage"));
  const file = join(dir, "usage", "2026-11.jsonl");
  writeFileSync(file, row("first"));
  return { file, read: () => ledgerRows(dir, Date.parse(at), Date.parse(at)) };
}
afterEach(() => {
  fault.enabled = false; fault.file = ""; fault.reads = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("usage ledger read recovery", () => {
  it("does not retain rows parsed by an unsuccessful incremental read", async () => {
    const { file, read } = fixture();
    expect((await read()).map((entry) => entry.threadId)).toEqual(["first"]);
    appendFileSync(file, row("second") + row("third"));
    Object.assign(fault, { file, line: row("second"), enabled: true });
    await expect(read()).rejects.toThrow("fixture read failed");
    fault.enabled = false;
    const recovered = await read();
    expect(recovered.map((entry) => entry.threadId)).toEqual(["first", "second", "third"]);
    expect(recovered.reduce((total, entry) => total + (entry.costUsd ?? 0), 0)).toBe(0.75);
    expect((await read()).map((entry) => entry.threadId)).toEqual(["first", "second", "third"]);
  });

  it("shares a failed read between callers and still retries without duplicated usage", async () => {
    const { file, read } = fixture();
    await read();
    appendFileSync(file, row("second"));
    Object.assign(fault, { file, line: row("second"), enabled: true });
    const results = await Promise.allSettled([read(), read()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(fault.reads).toBe(1);
    fault.enabled = false;
    expect((await read()).map((entry) => entry.threadId)).toEqual(["first", "second"]);
  });

  it("recovers an unsuccessful first read without publishing a partial cache", async () => {
    const { file, read } = fixture();
    Object.assign(fault, { file, line: row("first"), enabled: true });
    await expect(read()).rejects.toThrow("fixture read failed");
    fault.enabled = false;
    expect((await read()).map((entry) => entry.threadId)).toEqual(["first"]);
  });
});
