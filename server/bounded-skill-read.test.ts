import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readBoundedSkillDescriptor, readBoundedSkillFile } from "./bounded-skill-read.ts";

it("reads at most the checked size plus one byte when a file grows", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-bounded-skill-")), path = join(root, "guide.md");
  writeFileSync(path, "abcd");
  const fd = openSync(path, "r");
  try {
    appendFileSync(path, "efghijkl");
    expect(readBoundedSkillDescriptor(fd, 4)).toBeNull();
    const next = Buffer.alloc(1);
    expect(readSync(fd, next, 0, 1, null)).toBe(1);
    expect(next.toString()).toBe("f");
    expect(readBoundedSkillFile(path, 4)).toBeNull();
    expect(readBoundedSkillFile(path, 12)?.toString()).toBe("abcdefghijkl");
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});
