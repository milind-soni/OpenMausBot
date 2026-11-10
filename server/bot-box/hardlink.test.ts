import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bwrapArgs, planBox, type BoxPlan, type Mount } from "./plan.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const plan = (mounts: Mount[]): BoxPlan => ({ mounts, options: [], net: "shared", writable: [], botId: null });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-hardlink-"));
  roots.push(root);
  const home = join(root, "home"), dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "mcp.json"), alias = join(home, "alias.json");
  writeFileSync(file, "original");
  return { home, dataDir, file, alias, codeRoots: [], engineRoots: [], bridges: [] };
}

describe.skipIf(process.platform === "win32")("read-only file hardlinks", () => {
  it.each([false, true])("refuses multiply-linked read-only files, including optional grants (%s)", (optional) => {
    const f = fixture();
    linkSync(f.file, f.alias);
    expect(() => bwrapArgs(plan([{ kind: "ro", source: f.file, target: f.file, optional }]))).toThrow(/multiply-linked read-only file: .*; grant a separate single-link copy instead\./);
  });

  it.each(["file", "alias"] as const)("refuses an explicit read-only %s with a writable HOME alias", (source) => {
    const f = fixture();
    linkSync(f.file, f.alias);
    expect(() => planBox(f, { command: "/bin/sh", args: [], env: {}, ro: [f[source]] })).toThrow(/multiply-linked read-only file: .*; grant a separate single-link copy instead\./);
  });

  it("refuses a read-only source hardlinked after planning", () => {
    const f = fixture();
    const given = planBox(f, { command: "/bin/sh", args: ["--mcp-config", f.file], env: {} });
    linkSync(f.file, f.alias);
    expect(() => bwrapArgs(given)).toThrow(/multiply-linked read-only file: .*; grant a separate single-link copy instead\./);
  });

  it("preserves writable file grants", () => {
    const f = fixture();
    linkSync(f.file, f.alias);
    expect(bwrapArgs(plan([{ kind: "bind", source: f.file, target: f.file }]))).toEqual(["--bind", f.file, f.file]);
  });
});
