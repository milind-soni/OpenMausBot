import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectBox } from "./detect.ts";
import { bwrapArgs, planBox } from "./plan.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(detection.box !== "bwrap")("read-only file hardlinks in real bubblewrap", () => {
  it.each([false, true])("protects an explicit read-only file from a writable HOME alias (hardlink: %s)", (hardlink) => {
    const root = mkdtempSync(join(tmpdir(), "omb-ro-hardlink-"));
    roots.push(root);
    const home = join(root, "home"), dataDir = join(root, "data");
    mkdirSync(home);
    mkdirSync(dataDir);
    const file = join(dataDir, "mcp.json"), alias = join(home, "mcp-alias.json");
    writeFileSync(file, "original");
    if (hardlink) linkSync(file, alias);
    else writeFileSync(alias, "separate file");
    const makePlan = () => planBox({ home, dataDir, codeRoots: [], engineRoots: [], bridges: [] }, {
      command: "/bin/sh", args: [], env: { HOME: home }, net: "shared", ro: [file],
    });
    let args: string[];
    try { args = bwrapArgs(makePlan()); } catch (error) {
      expect(hardlink).toBe(true);
      expect((error as Error).message).toMatch(/multiply-linked read-only file: .*; grant a separate single-link copy instead\./);
      expect(readFileSync(file, "utf8")).toBe("original");
      return;
    }
    const probe = spawnSync(detection.tools!.bwrap, [...args, "--", "/bin/sh", "-c",
      'if (echo direct > "$1") 2>/dev/null; then echo writable; else echo read-only; fi; echo changed > "$2"; cat "$1"',
      "probe", file, alias,
    ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10_000 });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe("read-only\noriginal");
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(readFileSync(alias, "utf8")).toBe("changed\n");
  });
});
