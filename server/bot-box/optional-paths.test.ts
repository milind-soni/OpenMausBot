import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { visibleInBox, planBox, type BoxRequest, type BoxSetup } from "./plan.ts";

describe.skipIf(process.platform === "win32")("unavailable box paths", () => {
  let root: string, setup: BoxSetup, notDirectory: string, denied: string;
  const request: BoxRequest = { command: "/bin/true", args: [], env: {} };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-optional-paths-"));
    for (const path of ["home", "data", "denied"]) mkdirSync(join(root, path));
    writeFileSync(join(root, "file"), "fixture");
    notDirectory = join(root, "file", "child");
    denied = join(root, "denied", "child");
    setup = { home: join(root, "home"), dataDir: join(root, "data"), codeRoots: [], engineRoots: [], bridges: [] };
  });
  afterEach(() => {
    chmodSync(join(root, "denied"), 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["ro", "argv"])("skips an optional %s path below a regular file", (source) => {
    const plan = planBox(setup, { ...request, ...(source === "ro" ? { ro: [notDirectory] } : { args: [notDirectory] }) });
    expect(plan.mounts.some((mount) => "source" in mount && mount.source === notDirectory)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0).each(["ro", "argv"])("skips an inaccessible optional %s path", (source) => {
    chmodSync(join(root, "denied"), 0);
    const plan = planBox(setup, { ...request, ...(source === "ro" ? { ro: [denied] } : { args: [denied] }) });
    expect(plan.mounts.some((mount) => "source" in mount && mount.source === denied)).toBe(false);
  });

  it.each(["file", "directory"])("removes writable bookkeeping covered by an explicit read-only %s grant", (grant) => {
    const dir = join(root, "denied"), file = join(dir, "config.json");
    writeFileSync(file, "config fixture");
    const plan = planBox(setup, { ...request, rw: [file], ro: [grant === "file" ? file : dir], args: [file] });
    expect(visibleInBox(plan, file)).toBe("ro");
    expect(plan.writable).not.toContain(file);
  });

  it("keeps ENOTDIR for a required cwd", () => {
    expect(() => planBox(setup, { ...request, cwd: notDirectory })).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  });

  it.skipIf(process.getuid?.() === 0)("keeps EACCES for a required cwd", () => {
    chmodSync(join(root, "denied"), 0);
    expect(() => planBox(setup, { ...request, cwd: denied })).toThrow(expect.objectContaining({ code: "EACCES" }));
  });
});
