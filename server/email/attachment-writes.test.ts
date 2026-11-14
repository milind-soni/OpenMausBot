import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { saveAttachment } from "./client.ts";

const state = vi.hoisted(() => ({ mode: "short", writes: 0, closeFails: false }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeSync(fd: number, buffer: Buffer, offset = 0, length = buffer.length - offset, position: number | null = null) {
      state.writes++;
      if (state.mode === "zero") return 0;
      if (state.mode === "fail" && state.writes > 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return original.writeSync(fd, buffer, offset, Math.min(length, 7), position);
    },
    closeSync(fd: number) {
      original.closeSync(fd);
      if (state.closeFails) throw new Error("close failed");
    },
  };
});

const root = mkdtempSync(join(tmpdir(), "omb-mail-writes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { state.mode = "short"; state.writes = 0; state.closeFails = false; });

describe("saving an entire attachment", () => {
  it("continues after a short filesystem write", () => {
    const bytes = Buffer.from(Array.from({ length: 257 }, (_, index) => index % 256));
    const path = saveAttachment(join(root, "short"), "file.bin", bytes);
    expect(readFileSync(path)).toEqual(bytes);
    expect(state.writes).toBeGreaterThan(1);
  });

  it("refuses a write that makes no progress", () => {
    state.mode = "zero";
    const folder = join(root, "zero");
    expect(() => saveAttachment(folder, "file.bin", Buffer.from("content"))).toThrow();
    expect(readdirSync(folder)).toEqual([]);
  });

  it("removes its partial file when a later write fails", () => {
    state.mode = "fail";
    const folder = join(root, "failure");
    expect(() => saveAttachment(folder, "file.bin", Buffer.from("content that needs several writes"))).toThrow("disk full");
    expect(readdirSync(folder)).toEqual([]);
  });

  it("continues to save empty files", () => {
    const path = saveAttachment(join(root, "empty"), "empty.bin", Buffer.alloc(0));
    expect(readFileSync(path)).toHaveLength(0);
  });

  it.each(["short", "fail"])("removes the output if closing fails after %s writes", (mode) => {
    state.mode = mode;
    state.closeFails = true;
    const folder = join(root, `close-${mode}`);
    expect(() => saveAttachment(folder, "file.bin", Buffer.from("content that needs several writes"))).toThrow("close failed");
    expect(readdirSync(folder)).toEqual([]);
  });
});
