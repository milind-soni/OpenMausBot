import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { extractZip } from "./zip-archive.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { buildZip } from "./testing/zip-fixture.ts";

const reads = vi.hoisted(() => ({ calls: 0, shortAt: 0, zeroAt: 0, maxBytes: Infinity, shortened: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith("fixture.zip")) {
      const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads.calls += 1;
        if (reads.calls === reads.zeroAt) return { bytesRead: 0, buffer };
        const limit = reads.calls === reads.shortAt ? 3 : reads.maxBytes;
        if (length > limit) reads.shortened += 1;
        return read(buffer, offset, Math.min(length, limit), position);
      }) as typeof handle.read;
    }
    return handle;
  } };
});

let scratch = "";
afterEach(async () => {
  Object.assign(reads, { calls: 0, shortAt: 0, zeroAt: 0, maxBytes: Infinity, shortened: 0 });
  if (scratch) await removeTempDir(scratch);
  scratch = "";
});

function archive(method: 0 | 8 = 8): { file: string; out: string } {
  scratch = mkdtempSync(join(tmpdir(), "omb-zip-short-"));
  const file = join(scratch, "fixture.zip"), out = join(scratch, "out");
  writeFileSync(file, buildZip([{ name: "nested/世界.txt", data: "complete contents\n", method }]));
  mkdirSync(out);
  return { file, out };
}

it.each(["end record", "central directory", "local header", "member name"])(
  "finishes a short %s read before parsing the ZIP",
  async (stage) => {
    const { file, out } = archive();
    reads.shortAt = ["end record", "central directory", "local header", "member name"].indexOf(stage) + 1;
    await extractZip(file, out, { maxEntries: 10 });
    expect(reads.shortened).toBe(1);
    expect(readFileSync(join(out, "nested", "世界.txt"), "utf8")).toBe("complete contents\n");
  },
);

it.each([0, 8] as const)("extracts compression method %s when every metadata read stops after seven bytes", async (method) => {
  const { file, out } = archive(method);
  reads.maxBytes = 7;
  await extractZip(file, out, { maxEntries: 10 });
  expect(reads.shortened).toBeGreaterThan(4);
  expect(readFileSync(join(out, "nested", "世界.txt"), "utf8")).toBe("complete contents\n");
});

it("rejects EOF after a partial metadata read without retrying forever", async () => {
  const { file, out } = archive();
  reads.shortAt = 1;
  reads.zeroAt = 2;
  await expect(extractZip(file, out, { maxEntries: 10 })).rejects.toThrow("The verified archive was truncated.");
  expect(reads.calls).toBeLessThanOrEqual(2);
});
