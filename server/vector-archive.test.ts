import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  VECTOR_ARCHIVE_KEEP,
  archiveStateVector,
  defaultVectorArchiveDir,
  forbiddenArchiveDir,
  isUsableArchiveDir,
  resolveVectorArchiveDir,
  vectorArchiveFilename,
} from "./vector-archive.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-archive-"));
  scratch.push(dir);
  return dir;
}

describe("forbiddenArchiveDir", () => {
  it("rejects roots, home, and system folders", () => {
    expect(forbiddenArchiveDir("/")).toBe(true);
    expect(forbiddenArchiveDir("/Applications")).toBe(true);
    expect(forbiddenArchiveDir("/System")).toBe(true);
    expect(forbiddenArchiveDir("/usr")).toBe(true);
    expect(forbiddenArchiveDir("/Users")).toBe(true);
  });

  it("allows a real project or private workspace", () => {
    const dir = tmp();
    expect(forbiddenArchiveDir(dir)).toBe(false);
    expect(isUsableArchiveDir(dir)).toBe(true);
    expect(isUsableArchiveDir("relative/path")).toBe(false);
    expect(isUsableArchiveDir("")).toBe(false);
  });
});

describe("resolveVectorArchiveDir", () => {
  it("nests state-vectors under the bot private folder by default", () => {
    const home = tmp();
    expect(resolveVectorArchiveDir({ fallbackDir: home })).toBe(defaultVectorArchiveDir(home));
  });

  it("uses a custom absolute folder when it is allowed", () => {
    const custom = tmp();
    expect(resolveVectorArchiveDir({ customDir: custom, fallbackDir: tmp() })).toBe(custom);
  });

  it("ignores a forbidden custom folder instead of writing there", () => {
    expect(resolveVectorArchiveDir({ customDir: "/Applications", fallbackDir: tmp() })).toBeNull();
  });
});

describe("archiveStateVector", () => {
  it("writes a compact_*.md recap and skips empty bodies", () => {
    const home = tmp();
    const path = archiveStateVector({
      summary: "Goal\nship the recap\n\nNext action\nkeep going",
      fallbackDir: home,
      botLabel: "Engineer Bot",
      at: new Date("2026-09-06T10:24:12"),
    });
    expect(path).toBeTruthy();
    expect(path).toContain("compact_Engineer-Bot_");
    expect(readFileSync(path!, "utf8")).toContain("Next action");
    expect(archiveStateVector({ summary: "   ", fallbackDir: home, botLabel: "x" })).toBeNull();
  });

  it("prunes down to the keep cap", () => {
    const dir = tmp();
    mkdirSync(join(dir, "state-vectors"), { recursive: true });
    const archive = join(dir, "state-vectors");
    for (let i = 0; i < VECTOR_ARCHIVE_KEEP + 5; i++) {
      const name = vectorArchiveFilename("bot", new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      writeFileSync(join(archive, name), `n${i}\n`);
    }
    archiveStateVector({
      summary: "latest",
      fallbackDir: dir,
      botLabel: "bot",
      at: new Date(Date.UTC(2026, 0, 2, 0, 0, 0)),
    });
    const left = readdirSync(archive).filter((name) => name.startsWith("compact_"));
    expect(left.length).toBe(VECTOR_ARCHIVE_KEEP);
    expect(left.some((name) => readFileSync(join(archive, name), "utf8").includes("latest"))).toBe(true);
  });
});
