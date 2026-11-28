import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ failInstalling: false }));
vi.mock("../atomic.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomic.ts")>();
  return {
    ...actual,
    renameWithRetry: (from: string, to: string) => {
      if (control.failInstalling && from.endsWith(".tmp")) throw new Error("the replacement could not be installed");
      actual.renameWithRetry(from, to);
    },
  };
});

import { PublishedPageFiles } from "./owner-files.ts";

const PAGE = "page0000000000000000000001";
const index = (text: string) => [{ path: "index.html", data: Buffer.from(text) }];

describe("an owner-only page's files", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-owner-files-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("swaps in a new version whole, and restores the old one when installing the replacement fails", () => {
    const files = new PublishedPageFiles(dir);
    files.save(PAGE, index("old"));
    expect(files.read(PAGE, "")?.toString()).toBe("old");
    control.failInstalling = true;
    try {
      expect(() => files.save(PAGE, index("new"))).toThrow("the replacement could not be installed");
    } finally {
      control.failInstalling = false;
    }
    expect(files.read(PAGE, "")?.toString()).toBe("old");
    files.save(PAGE, index("newer"));
    expect(files.read(PAGE, "")?.toString()).toBe("newer");
  });

  it("keeps the old version when the new one is incomplete", () => {
    const files = new PublishedPageFiles(dir);
    files.save(PAGE, index("old"));
    expect(() => files.save(PAGE, [{ path: "style.css", data: Buffer.from("h1{}") }])).toThrow("the page has no index.html");
    expect(files.read(PAGE, "")?.toString()).toBe("old");
  });
});
