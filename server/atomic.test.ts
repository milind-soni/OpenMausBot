import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spied, not replaced: every call still reaches the real filesystem, and the
// tests can count the fsyncs and reads a save costs. The shared test setup
// has already loaded atomic.ts (through config.ts) against the real module,
// so load a fresh copy that sees the spies.
vi.mock("node:fs", { spy: true });
vi.resetModules();
const spied = await import("node:fs");
const { renameWithRetry, writeFileAtomic, writeFileAtomicIfChanged } = await import("./atomic.ts");

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

// fsync is F_FULLFSYNC on macOS, ~4 ms of blocked event loop per call, and
// several per-turn saves put back exactly what the file already holds.
describe("writeFileAtomic durability", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
    vi.mocked(spied.fsyncSync).mockClear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fsyncs by default", () => {
    writeFileAtomic(join(dir, "x.json"), "a");
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
  });

  it("still replaces atomically without the fsync when durable is false", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    vi.mocked(spied.fsyncSync).mockClear();
    writeFileAtomic(p, "new", { durable: false });
    expect(spied.fsyncSync).not.toHaveBeenCalled();
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
});

describe("writeFileAtomicIfChanged", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const clearSpies = () => {
    vi.mocked(spied.fsyncSync).mockClear();
    vi.mocked(spied.readFileSync).mockClear();
  };

  it("leaves the file alone when it already holds exactly these bytes", () => {
    const p = join(dir, "x.json");
    const data = JSON.stringify({ msg: "café — 日本語" });
    writeFileAtomic(p, data, { mode: 0o600 });
    const before = statSync(p);
    clearSpies();

    expect(writeFileAtomicIfChanged(p, data, { mode: 0o600 })).toBe(false);

    const after = statSync(p);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(spied.fsyncSync).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("writes and fsyncs when the bytes differ", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"unread":true}');
    clearSpies();
    // Same length, different bytes: only the read can tell.
    expect(writeFileAtomicIfChanged(p, '{"unread":fals}')).toBe(true);
    expect(readFileSync(p, "utf8")).toBe('{"unread":fals}');
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
  });

  it("does not read the old contents when the size already differs", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "short");
    clearSpies();
    expect(writeFileAtomicIfChanged(p, "a longer replacement")).toBe(true);
    expect(spied.readFileSync).not.toHaveBeenCalled();
    expect(readFileSync(p, "utf8")).toBe("a longer replacement");
  });

  it("writes a file that does not exist yet", () => {
    const p = join(dir, "new.json");
    expect(writeFileAtomicIfChanged(p, "fresh", { mode: 0o600 })).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("fresh");
  });

  it("passes durable through to the write", () => {
    const p = join(dir, "x.json");
    clearSpies();
    writeFileAtomicIfChanged(p, "token", { durable: false });
    expect(spied.fsyncSync).not.toHaveBeenCalled();
    expect(readFileSync(p, "utf8")).toBe("token");
  });

  it.skipIf(process.platform === "win32")("rewrites identical bytes whose permissions are broader than requested", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "same");
    chmodSync(p, 0o644);
    expect(writeFileAtomicIfChanged(p, "same", { mode: 0o600 })).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("replaces a symlink holding identical bytes instead of following it", () => {
    const target = join(dir, "elsewhere.json");
    const p = join(dir, "x.json");
    writeFileSync(target, "same");
    symlinkSync(target, p);
    expect(writeFileAtomicIfChanged(p, "same")).toBe(true);
    expect(lstatSync(p).isSymbolicLink()).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("same");
    expect(readFileSync(target, "utf8")).toBe("same");
  });

  it.skipIf(process.platform === "win32")("does not hang on a FIFO planted at the path", () => {
    const p = join(dir, "x.json");
    execFileSync("mkfifo", [p]);
    expect(writeFileAtomicIfChanged(p, "data")).toBe(true);
    expect(lstatSync(p).isFile()).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("data");
  });

  it("still fails like writeFileAtomic when the path cannot be replaced", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomicIfChanged(p, "cannot replace a directory")).toThrow();
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
