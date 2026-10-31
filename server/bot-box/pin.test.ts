import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bwrapArgs, type BoxPlan, type Mount } from "./plan.ts";
import { closeMountFds } from "./pin.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), "omb-pin-")); roots.push(root); return root; };
const plan = (mounts: Mount[]): BoxPlan => ({ mounts, options: [], net: "shared", writable: [], botId: null });

describe.skipIf(process.platform !== "linux")("pinned mount failures", () => {
  it("closes partially pinned sources without closing an existing seccomp descriptor", () => {
    const root = temp(), source = join(root, "source"), replaced = join(root, "replaced");
    mkdirSync(source);
    symlinkSync(source, replaced);
    const file = join(root, "seccomp");
    writeFileSync(file, "filter fixture");
    const seccomp = openSync(file, "r"), fds = [seccomp];
    const ownedFds = () => readdirSync("/proc/self/fd").flatMap((fd) => {
      try { const path = readlinkSync(`/proc/self/fd/${fd}`); return path.startsWith(root) ? [path] : []; } catch { return []; }
    });
    try {
      expect(() => bwrapArgs(plan([
        { kind: "ro", source, target: "/source" },
        { kind: "ro", source, target: "/alias" },
        { kind: "bind", source: replaced, target: "/replaced" },
      ]), fds)).toThrow(/mount source changed/);
      expect(fds).toEqual([seccomp]);
      expect(fstatSync(seccomp).isFile()).toBe(true);
      expect(ownedFds()).toEqual([file]);
    } finally { closeMountFds(fds); }
  });

  it("refuses a source redirected through a replaced ancestor", () => {
    const root = temp(), parent = join(root, "parent"), data = join(root, "data");
    mkdirSync(join(parent, "child"), { recursive: true });
    mkdirSync(join(data, "child"), { recursive: true });
    const given = plan([{ kind: "bind", source: join(parent, "child"), target: "/granted" }]);
    renameSync(parent, `${parent}-saved`);
    symlinkSync(data, parent);
    const fds: number[] = [];
    try { expect(() => bwrapArgs(given, fds)).toThrow(/mount source changed/); }
    finally { closeMountFds(fds); }
  });

  it("skips missing optional paths but preserves a missing required source error", () => {
    const root = temp(), missing = join(root, "missing");
    const fds: number[] = [];
    try {
      expect(bwrapArgs(plan([{ kind: "ro", source: missing, target: "/optional", optional: true }]), fds)).toEqual([]);
      expect(() => bwrapArgs(plan([{ kind: "bind", source: missing, target: "/required" }]), fds)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(fds).toEqual([]);
    } finally { closeMountFds(fds); }
  });

  it("hands each alias its own child descriptor while opening the source once", () => {
    const source = temp(), fds: number[] = [];
    try {
      expect(bwrapArgs(plan([{ kind: "ro", source, target: "/one" }, { kind: "ro", source, target: "/two" }]), fds))
        .toEqual(["--ro-bind-fd", "3", "/one", "--ro-bind-fd", "4", "/two"]);
      expect(fds).toHaveLength(2);
      expect(fds[0]).toBe(fds[1]);
      const fd = fds[0]!;
      closeMountFds(fds);
      expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    } finally { for (const fd of new Set(fds)) closeSync(fd); }
  });
});
