import { appendFileSync, fstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { readFileNoFollow } from "./imported-skills.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fstatSync: vi.fn(fs.fstatSync) };
});
const original = (await vi.importActual<typeof import("node:fs")>("node:fs")).fstatSync;
afterEach(() => vi.mocked(fstatSync).mockReset().mockImplementation(original));

describe("bounded file reads", () => {
  it("keeps existing callers unlimited and rejects files above the supplied limit", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, "bounded.txt");
    writeFileSync(file, "1234");
    expect(readFileNoFollow(file, 4)?.toString()).toBe("1234");
    expect(readFileNoFollow(file, 3)).toBeNull();
    expect(readFileNoFollow(file)?.toString()).toBe("1234");
  });

  it("rejects growth after the opened descriptor was checked", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, "growing.txt");
    writeFileSync(file, "1234");
    vi.mocked(fstatSync).mockImplementationOnce((fd) => {
      const info = original(fd);
      appendFileSync(file, Buffer.alloc(4096));
      return info;
    });
    expect(readFileNoFollow(file, 4)).toBeNull();
  });
});
