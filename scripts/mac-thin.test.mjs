import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMachO, writeThinMachO } from "./mac-thin.mjs";

// Real Mach-O fixtures: /usr/bin binaries are arm64e, not arm64, so compile.
const canBuildMachO = process.platform === "darwin" && fs.existsSync("/usr/bin/lipo") &&
  spawnSync("cc", ["--version"]).status === 0;

describe.skipIf(!canBuildMachO)("writeThinMachO", () => {
  let directory;
  const archs = (file) => execFileSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" }).trim();
  const file = (name) => path.join(directory, name);

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-mac-thin-"));
    fs.writeFileSync(file("main.c"), "int main(void) { return 0; }\n");
    for (const arch of ["arm64", "x86_64"]) execFileSync("cc", ["-arch", arch, "-o", file(arch), file("main.c")]);
    execFileSync("/usr/bin/lipo", ["-create", file("arm64"), file("x86_64"), "-output", file("fat")]);
    fs.chmodSync(file("fat"), 0o644);
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("stages one slice of a universal source and leaves the source whole", async () => {
    const before = fs.readFileSync(file("fat"));
    await writeThinMachO(file("fat"), file("staged-x86_64"), "x86_64");
    expect(archs(file("staged-x86_64"))).toBe("x86_64");
    expect(fs.statSync(file("staged-x86_64")).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(file("fat")).equals(before)).toBe(true);
  });

  it("copies a source that already has only the wanted slice", async () => {
    await writeThinMachO(file("arm64"), file("staged-arm64"), "arm64");
    expect(fs.readFileSync(file("staged-arm64")).equals(fs.readFileSync(file("arm64")))).toBe(true);
  });

  it("refuses a source without the wanted slice and writes nothing", async () => {
    await expect(writeThinMachO(file("x86_64"), file("missing"), "arm64")).rejects.toThrow(/no arm64 slice/);
    expect(fs.readdirSync(directory).some((name) => name.includes("missing"))).toBe(false);
  });

  it("recognizes Mach-O files by their header", async () => {
    expect(await isMachO(file("fat"))).toBe(true);
    expect(await isMachO(file("arm64"))).toBe(true);
    expect(await isMachO(file("main.c"))).toBe(false);
  });
});
