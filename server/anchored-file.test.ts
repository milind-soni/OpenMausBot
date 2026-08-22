import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeAnchoredFile, writeAnchoredFileSync } from "./anchored-file.ts";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "omb-anchored-file-"));
  temporary.push(path);
  return path;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("anchored file writes", () => {
  it("creates and replaces a bounded file relative to the approved directory object", async () => {
    const root = directory();
    const parent = lstatSync(root);
    const path = join(root, "result.txt");
    const created = writeAnchoredFileSync({
      path,
      parent: { dev: parent.dev, ino: parent.ino },
      mode: "create",
      content: "one",
      maximumBytes: 1024,
    });
    expect(readFileSync(path, "utf8")).toBe("one");

    const before = lstatSync(path);
    const replaced = await writeAnchoredFile({
      path,
      parent: { dev: parent.dev, ino: parent.ino },
      mode: "replace",
      content: "two",
      maximumBytes: 1024,
      expectedFile: {
        dev: before.dev,
        ino: before.ino,
        nlink: before.nlink,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        sha256: sha256("one"),
      },
    });
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(replaced).toMatchObject({ dev: created.dev, ino: created.ino, size: 3 });
  });

  it("fails before creation when the approved parent path is replaced", () => {
    const root = directory();
    const approved = join(root, "approved");
    const displaced = join(root, "approved-before-swap");
    mkdirSync(approved);
    const parent = lstatSync(approved);

    expect(() => writeAnchoredFileSync({
      path: join(approved, "must-not-exist.txt"),
      parent: { dev: parent.dev, ino: parent.ino },
      mode: "create",
      content: "must-not-land",
      maximumBytes: 1024,
    }, {
      beforeSpawn: () => {
        renameSync(approved, displaced);
        mkdirSync(approved);
      },
    })).toThrow(/parent identity changed/);
    expect(() => readFileSync(join(approved, "must-not-exist.txt"))).toThrow();
    expect(() => readFileSync(join(displaced, "must-not-exist.txt"))).toThrow();
  });

  it("rejects preimage drift without truncating the current file", async () => {
    const root = directory();
    const path = join(root, "stable.txt");
    writeFileSync(path, "current");
    const parent = lstatSync(root);
    const before = lstatSync(path);
    await expect(writeAnchoredFile({
      path,
      parent: { dev: parent.dev, ino: parent.ino },
      mode: "replace",
      content: "replacement",
      maximumBytes: 1024,
      expectedFile: {
        dev: before.dev,
        ino: before.ino,
        nlink: before.nlink,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        sha256: sha256("different"),
      },
    })).rejects.toThrow(/content changed/);
    expect(readFileSync(path, "utf8")).toBe("current");
  });

  it("fails closed when the worker stdin rejects the bounded request", async () => {
    const root = directory();
    const parent = lstatSync(root);
    const path = join(root, "must-not-land.txt");

    await expect(writeAnchoredFile({
      path,
      parent: { dev: parent.dev, ino: parent.ino },
      mode: "create",
      content: "must-not-land",
      maximumBytes: 1024,
    }, {
      beforeStdinWrite: (stdin) => stdin.destroy(new Error("forced stdin failure")),
    })).rejects.toThrow(/stdin failed closed/);
    expect(() => readFileSync(path)).toThrow();
  });

  it("closes the worker stdin when a pre-write hook throws", async () => {
    const root = directory();
    const parent = lstatSync(root);
    const path = join(root, "hook-failure.txt");

    await expect(writeAnchoredFile({
      path,
      parent: { dev: parent.dev, ino: parent.ino },
      mode: "create",
      content: "must-not-land",
      maximumBytes: 1024,
    }, {
      beforeStdinWrite: () => { throw new Error("forced hook failure"); },
    })).rejects.toThrow(/stdin failed closed/);
    expect(() => readFileSync(path)).toThrow();
  });
});
