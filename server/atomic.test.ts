import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renameWithRetry, writeFileAtomic } from "./atomic.ts";

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing contents in full", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old-and-longer");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("leaves no temp files behind", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "a");
    writeFileAtomic(p, "b");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("preserves unicode across the write", () => {
    const p = join(dir, "u.json");
    const s = JSON.stringify({ msg: "café — 日本語 — 🚀" });
    writeFileAtomic(p, s);
    expect(readFileSync(p, "utf8")).toBe(s);
    expect(existsSync(p)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("applies the requested mode when replacing a file", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "old");
    chmodSync(p, 0o644);

    writeFileAtomic(p, "new", { mode: 0o600 });

    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("cleans up the temporary file when replacement fails", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomic(p, "cannot replace a directory")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

// Windows refuses a rename onto an existing path while anything else holds a
// handle to either file, and a virus scanner or the search indexer opening a
// just-closed file for a few milliseconds is enough. Callers treat a throw here
// as a failed save, so a transient error used to lose the write.
describe("renameWithRetry", () => {
  function failing(times: number, code: string) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      rename: () => {
        calls += 1;
        if (calls <= times) throw Object.assign(new Error(`${code}: simulated`), { code });
      },
    };
  }

  it("survives a transient EPERM instead of losing the write", () => {
    const stub = failing(3, "EPERM");
    expect(() => renameWithRetry("a.tmp", "a", stub.rename)).not.toThrow();
    expect(stub.calls).toBe(4);
  });

  it("retries EACCES and EBUSY the same way", () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const stub = failing(1, code);
      expect(() => renameWithRetry("a.tmp", "a", stub.rename)).not.toThrow();
      expect(stub.calls).toBe(2);
    }
  });

  it("gives up rather than retrying forever", () => {
    const stub = failing(Number.MAX_SAFE_INTEGER, "EPERM");
    expect(() => renameWithRetry("a.tmp", "a", stub.rename)).toThrow(/EPERM/);
    expect(stub.calls).toBe(6); // first attempt plus five backoffs
  });

  it("does not retry an error that will never clear", () => {
    // Busy-waiting on a missing directory or a cross-device rename would hide
    // a real bug behind a delay and still fail.
    for (const code of ["ENOENT", "EXDEV", "EISDIR"]) {
      const stub = failing(Number.MAX_SAFE_INTEGER, code);
      expect(() => renameWithRetry("a.tmp", "a", stub.rename)).toThrow(new RegExp(code));
      expect(stub.calls).toBe(1);
    }
  });
});
