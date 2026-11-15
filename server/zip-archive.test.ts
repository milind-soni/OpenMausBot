import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractZip, readZipDirectory, safeArchivePath } from "./zip-archive.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { buildZip, type ZipFixtureMember } from "./testing/zip-fixture.ts";

let scratch = "";
afterEach(async () => {
  if (scratch) await removeTempDir(scratch);
  scratch = "";
});

function archive(members: ZipFixtureMember[]): { file: string; out: string } {
  scratch = mkdtempSync(join(tmpdir(), "omb-zip-archive-"));
  const file = join(scratch, "fixture.zip");
  writeFileSync(file, buildZip(members));
  const out = join(scratch, "out");
  mkdirSync(out);
  return { file, out };
}

describe("extracting a verified zip", () => {
  it("writes every member, nested folders included, and keeps a Unix executable runnable", async () => {
    const { file, out } = archive([
      { name: "bin/", mode: 0o040755, method: 0 },
      { name: "bin/tool", data: "#!/bin/sh\necho tool\n", mode: 0o100755 },
      { name: "README", data: "plain words", method: 0 },
    ]);
    await extractZip(file, out, { maxEntries: 10 });
    expect(readFileSync(join(out, "bin", "tool"), "utf8")).toBe("#!/bin/sh\necho tool\n");
    expect(readFileSync(join(out, "README"), "utf8")).toBe("plain words");
    if (process.platform !== "win32") expect(statSync(join(out, "bin", "tool")).mode & 0o111).not.toBe(0);
  });

  it.each(["../escape", "/absolute", "a\\b", "C:/drive", "a/../../b", "a//b"])("refuses the member name %s and writes nothing outside", async (name) => {
    const { file, out } = archive([{ name, data: "x" }]);
    await expect(extractZip(file, out, { maxEntries: 10 })).rejects.toThrow(/unsafe/);
    expect(existsSync(join(scratch, "escape"))).toBe(false);
    expect(readdirSync(out)).toEqual([]);
  });

  it.each([
    "CON", "nul", "Aux.txt", "bin/PRN", "COM1", "lpt9.log", "con/tool", "con.d/tool",
    "COM0", "lpt0.txt", "COM\u00b9", "lpt\u00b2.log", "COM\u00b3", "CONIN$", "conout$.txt", "CLOCK$",
    "CON .txt", "nul  .log", "bin/aux .x", "LPT1 .tar.gz",
    "file:stream", "C:x", "trailing.", "trailing ", "dir./tool",
    "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "tab\there",
  ])("refuses %j, which Windows cannot hold or reads as a device or stream", async (name) => {
    const { file, out } = archive([{ name, data: "x" }]);
    await expect(extractZip(file, out, { maxEntries: 10 })).rejects.toThrow(/unsafe/);
  });

  it.each(["console", "nul-device/tool", "COM10", "conman/x", "v1.2.3/opencode", "CLOCK", "conin", "com\u2074", "con x.txt"])("allows the ordinary name %j", (name) => {
    expect(safeArchivePath(name)).toBe(true);
  });

  it("refuses a symbolic link", async () => {
    const { file, out } = archive([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]);
    await expect(extractZip(file, out, { maxEntries: 10 })).rejects.toThrow(/unsafe/);
  });

  it("refuses more members than the caller allows", async () => {
    const { file, out } = archive([{ name: "a", data: "1" }, { name: "b", data: "2" }]);
    await expect(extractZip(file, out, { maxEntries: 1 })).rejects.toThrow(/unsupported/);
  });

  it("refuses a member that inflates past the size its directory gives", async () => {
    const { file, out } = archive([{ name: "big", data: "x".repeat(4096), declaredBytes: 16 }]);
    await expect(extractZip(file, out, { maxEntries: 10 })).rejects.toThrow(/size/);
  });

  it("writes an empty stored member as an empty file", async () => {
    const { file, out } = archive([{ name: "empty", data: "", method: 0 }]);
    await extractZip(file, out, { maxEntries: 10 });
    expect(readFileSync(join(out, "empty"), "utf8")).toBe("");
  });

  it("refuses a file that is not a zip", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-zip-archive-"));
    const file = join(scratch, "not.zip");
    writeFileSync(file, "plain text, no directory");
    await expect(extractZip(file, scratch, { maxEntries: 10 })).rejects.toThrow(/ZIP/);
  });

  it("refuses central directory size exceeding MAX_CENTRAL_DIRECTORY_BYTES without allocating", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-zip-archive-"));
    const file = join(scratch, "oversized-cd.zip");
    const cdSize = 9 * 1024 * 1024; // 9 MiB > 8 MiB cap
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4); // disk
    eocd.writeUInt16LE(0, 6); // cd disk
    eocd.writeUInt16LE(0, 8); // disk entries
    eocd.writeUInt16LE(0, 10); // total entries
    eocd.writeUInt32LE(cdSize, 12); // cd size (9 MiB)
    eocd.writeUInt32LE(0, 16); // cd offset
    eocd.writeUInt16LE(0, 20); // comment length

    const { open } = await import("node:fs/promises");
    const fh = await open(file, "w");
    await fh.truncate(cdSize + 22);
    await fh.write(eocd, 0, 22, cdSize);
    await fh.close();

    const allocSpy = vi.spyOn(Buffer, "alloc");
    try {
      await expect(readZipDirectory(file, 10)).rejects.toThrow(/unsupported ZIP layout|directory/);
      for (const call of allocSpy.mock.calls) {
        expect(call[0]).toBeLessThanOrEqual(8 * 1024 * 1024);
      }
    } finally {
      allocSpy.mockRestore();
    }
  });

  it("refuses entryCount inconsistent with central directory size", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-zip-archive-"));
    const file = join(scratch, "inconsistent-cd.zip");
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(10, 8); // 10 entries requires at least 460 bytes
    eocd.writeUInt16LE(10, 10);
    eocd.writeUInt32LE(40, 12); // but cd size is only 40 bytes (< 460)
    eocd.writeUInt32LE(0, 16);
    eocd.writeUInt16LE(0, 20);

    const { open } = await import("node:fs/promises");
    const fh = await open(file, "w");
    await fh.truncate(40 + 22);
    await fh.write(eocd, 0, 22, 40);
    await fh.close();

    await expect(readZipDirectory(file, 20)).rejects.toThrow(/unsupported ZIP layout|directory/);
  });

  it("refuses ZIP64 sentinel 0xffff in entry count", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-zip-archive-"));
    const file = join(scratch, "zip64.zip");
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(0xffff, 8); // ZIP64 sentinel
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(100, 12);
    eocd.writeUInt32LE(0, 16);
    eocd.writeUInt16LE(0, 20);

    const { open } = await import("node:fs/promises");
    const fh = await open(file, "w");
    await fh.truncate(100 + 22);
    await fh.write(eocd, 0, 22, 100);
    await fh.close();

    await expect(readZipDirectory(file, 100_000)).rejects.toThrow(/unsupported ZIP layout/);
  });

  it("refuses crafted EOCD with directoryBytes = 0x7fff_ffff without allocation error", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-zip-archive-"));
    const file = join(scratch, "large-cd.zip");
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(0, 8);
    eocd.writeUInt16LE(0, 10);
    eocd.writeUInt32LE(0x7fff_ffff, 12);
    eocd.writeUInt32LE(0, 16);
    eocd.writeUInt16LE(0, 20);

    const { open } = await import("node:fs/promises");
    const fh = await open(file, "w");
    await fh.write(eocd, 0, 22, 0);
    await fh.close();

    const allocSpy = vi.spyOn(Buffer, "alloc");
    try {
      await expect(readZipDirectory(file, 10)).rejects.toThrow("The verified archive uses an unsupported ZIP layout.");
      for (const call of allocSpy.mock.calls) {
        expect(call[0]).toBeLessThanOrEqual(8 * 1024 * 1024);
      }
    } finally {
      allocSpy.mockRestore();
    }
  });

  it("fuzz: seeded mutations of zip headers never crash unhandled", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-zip-archive-"));
    const template = buildZip([
      { name: "file1.txt", data: "first file content", method: 0 },
      { name: "file2.txt", data: "second file content", method: 8 },
    ]);
    const file = join(scratch, "fuzz.zip");

    let seed = 0x12345678;
    function rand(): number {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return seed / 0x100000000;
    }
    function randInt(min: number, max: number): number {
      return Math.floor(rand() * (max - min + 1)) + min;
    }

    for (let i = 0; i < 500; i += 1) {
      const copy = Buffer.from(template);
      const mutations = randInt(1, 5);
      for (let m = 0; m < mutations; m += 1) {
        const mode = randInt(0, 2);
        if (mode === 0) {
          const offset = randInt(0, copy.length - 1);
          copy[offset] = randInt(0, 255);
        } else if (mode === 1) {
          const offset = randInt(Math.max(0, copy.length - 100), copy.length - 1);
          copy[offset] = randInt(0, 255);
        } else {
          const offset = randInt(Math.max(0, copy.length - 30), copy.length - 2);
          copy.writeUInt16LE(randInt(0, 0xffff), offset);
        }
      }
      writeFileSync(file, copy);
      try {
        const result = await readZipDirectory(file, 100);
        expect(Array.isArray(result)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
