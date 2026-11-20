import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RUN_COMPUTER_MEMORY_MAX, runComputerMemory } from "./cloud-computer-run-memory.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-run-memory-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("which routines used a cloud computer, kept across restarts", () => {
  it("reads back what it saved", () => {
    const file = join(dir, "routine-computers.json");
    runComputerMemory(file).save(["routine-1", "routine-2"]);
    expect(runComputerMemory(file).load()).toEqual(["routine-1", "routine-2"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["routine-1", "routine-2"]);
  });

  it("is empty when there is no file, or the file is not a list of ids", () => {
    const file = join(dir, "routine-computers.json");
    expect(runComputerMemory(file).load()).toEqual([]);
    for (const broken of ["", "{", '{"a":1}', "null"]) {
      writeFileSync(file, broken);
      expect(runComputerMemory(file).load(), broken).toEqual([]);
    }
    writeFileSync(file, JSON.stringify(["ok", 7, null, "", "x".repeat(201), { id: "no" }, "also-ok"]));
    expect(runComputerMemory(file).load()).toEqual(["ok", "also-ok"]);
  });

  it("keeps the newest five hundred, in the file and when reading a longer one", () => {
    const file = join(dir, "routine-computers.json");
    const ids = Array.from({ length: RUN_COMPUTER_MEMORY_MAX + 20 }, (_unused, index) => `routine-${index}`);
    runComputerMemory(file).save(ids);
    expect(runComputerMemory(file).load()).toEqual(ids.slice(20));
    writeFileSync(file, JSON.stringify(ids));
    expect(runComputerMemory(file).load()).toEqual(ids.slice(20));
  });

  it("never throws when the file cannot be written", () => {
    expect(() => runComputerMemory(join(dir, "no-such-folder", "deeper", "file.json")).save(["routine-1"])).not.toThrow();
  });
});
