import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractZip, safeArchivePath } from "./zip-archive.ts";
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
});
