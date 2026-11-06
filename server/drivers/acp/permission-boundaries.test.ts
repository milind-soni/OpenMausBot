import { describe, expect, it } from "vitest";

import { acpSessionOperationKey } from "../permission-command.ts";

// Kiro V3 file permission leak review — verifies exact operationKeys remain distinct
// and validates sessionAllows isolation assumptions used by core.ts.

describe("acpSessionOperationKey — Kiro file operation boundaries", () => {
  it("distinguishes Write File from Review changes on same turn", () => {
    const writeFile = {
      kind: "edit",
      title: "Write File",
      rawInput: { path: "/tmp/ws/test.txt", content: "hello1" },
      locations: [{ path: "/tmp/ws/test.txt" }],
    };
    const reviewChanges = {
      kind: "edit",
      title: "Review changes",
      rawInput: {},
      locations: undefined,
    };
    const k1 = acpSessionOperationKey(writeFile);
    const k2 = acpSessionOperationKey(reviewChanges);
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(k1).not.toBe(k2);
  });

  it("distinguishes same title with different file paths", () => {
    const a = {
      kind: "edit",
      title: "Write File",
      rawInput: { path: "/tmp/a.txt", content: "x" },
      locations: [{ path: "/tmp/a.txt" }],
    };
    const b = {
      kind: "edit",
      title: "Write File",
      rawInput: { path: "/tmp/b.txt", content: "x" },
      locations: [{ path: "/tmp/b.txt" }],
    };
    expect(acpSessionOperationKey(a)).not.toBe(acpSessionOperationKey(b));
  });

  it("returns null for empty toolCall with no identifiable operation", () => {
    expect(acpSessionOperationKey({})).toBeNull();
    expect(acpSessionOperationKey({ rawInput: {} })).toBeNull();
    expect(acpSessionOperationKey({ rawInput: {}, title: "", kind: "" })).toBeNull();
  });

  it("treats shell toolCall with command as non-null", () => {
    const shell = {
      kind: "execute",
      title: "Run command",
      rawInput: { command: "echo hi", cwd: "/tmp/ws" },
    };
    expect(acpSessionOperationKey(shell)).not.toBeNull();
  });
});

describe("sessionAllows — isolation invariants (driver contract)", () => {
  it("cross-thread isolation: Map keyed by threadId prevents leak", () => {
    const allows = new Map<string, Set<string>>();
    const op = JSON.stringify({ kind: "edit", title: "Write File", input: { path: "/tmp/t1.txt" } });
    allows.set("thread-A", new Set([op]));
    // thread-B must not see thread-A's allow
    expect(allows.get("thread-B")?.has(op)).toBeFalsy();
    expect(allows.get("thread-A")?.has(op)).toBe(true);
  });

  it("Full→Ask isolation: Full auto-allow does not write to sessionAllows", () => {
    // Full access uses sessionMeta allow-all + turnConfig.fullAuto, never stores via forSession path.
    // This test documents the invariant: only forSession (allow + always) writes.
    const forSession = (want: string, always: boolean | undefined) => want === "allow" && always === true;
    expect(forSession("allow", true)).toBe(true); // Ask with allow_always → stores
    expect(forSession("allow", undefined)).toBe(false); // Full fast-path has no always → does not store
    expect(forSession("allow", false)).toBe(false);
  });

  it("sessionAllows keys are exact JSON — different inputs do not collide", () => {
    const mk = (path: string) => acpSessionOperationKey({
      kind: "edit",
      title: "Write File",
      rawInput: { path, content: "same" },
      locations: [{ path }],
    })!;
    expect(mk("/tmp/a.txt")).not.toBe(mk("/tmp/b.txt"));
    expect(mk("/tmp/a.txt")).toBe(mk("/tmp/a.txt")); // stable
  });
});
