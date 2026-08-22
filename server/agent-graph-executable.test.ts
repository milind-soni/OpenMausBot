import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { graphExecutableIdentity, graphExecutableReady } from "./agent-graph-executable.ts";

describe("agent graph executable identity", () => {
  it("changes when an exact executable is replaced at the same path", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-graph-cli-"));
    const cli = join(root, "provider");
    writeFileSync(cli, "#!/bin/sh\necho one\n");
    chmodSync(cli, 0o755);
    const before = graphExecutableIdentity(cli);
    writeFileSync(cli, "#!/bin/sh\necho two\n");
    chmodSync(cli, 0o755);
    expect(graphExecutableIdentity(cli)).not.toBe(before);
  });

  it("binds a symlink and its target while rejecting missing or non-executable files", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-graph-cli-link-"));
    const target = join(root, "provider-real");
    const link = join(root, "provider-link");
    writeFileSync(target, "#!/bin/sh\necho provider\n");
    chmodSync(target, 0o755);
    symlinkSync(target, link);
    expect(graphExecutableIdentity(link)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(graphExecutableReady(join(root, "missing"))).toBe(false);
    if (process.platform !== "win32") {
      chmodSync(target, 0o644);
      expect(graphExecutableReady(link)).toBe(false);
    }
  });
});
