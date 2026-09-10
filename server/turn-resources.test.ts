import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TurnResources, workspaceResource } from "./turn-resources.ts";

const a = { threadId: "a", generation: "1" };
const b = { threadId: "b", generation: "2" };

describe("thread resource ownership", () => {
  it("allows independent resources but holds the same screen across calls", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", b)).toBe(false);
    expect(leases.claim("browser:other", b)).toBe(true);
    leases.release(a);
    expect(leases.claim("computer:host", b)).toBe(true);
    leases.release(a);
    expect(leases.owns("computer:host", b)).toBe(true);
  });

  it("does not release a replacement generation", () => {
    const leases = new TurnResources();
    const next = { ...a, generation: "next" };
    expect(leases.claim("browser:one", a)).toBe(true);
    expect(leases.claim("browser:one", next)).toBe(false);
    leases.release(a);
    expect(leases.claim("browser:one", next)).toBe(true);
    leases.release(a);
    expect(leases.owns("browser:one", next)).toBe(true);
  });

  it("prevents parent/child project overlap and symlink aliases, not sibling folders", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-resources-"));
    try {
      mkdirSync(join(root, "project", "nested"), { recursive: true });
      mkdirSync(join(root, "project-other"));
      symlinkSync(join(root, "project"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(join(root, "project")), a)).toBe(true);
      expect(leases.claim(workspaceResource(join(root, "alias")), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project", "nested")), b)).toBe(false);
      expect(leases.claim(workspaceResource(root), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project-other")), b)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats differently cased paths as one workspace on case-insensitive volumes", ({ skip }) => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-case-"));
    try {
      const folder = join(root, "Project");
      const alias = join(root, "project");
      mkdirSync(folder);
      if (!existsSync(alias)) return skip();
      expect(workspaceResource(alias)).toBe(workspaceResource(folder));
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(folder), a)).toBe(true);
      expect(leases.claim(workspaceResource(alias), b)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
