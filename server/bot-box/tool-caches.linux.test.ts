// The tool cache folder in a real box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home, CI's
// Linux runner). Elsewhere the suite says so and skips, like the box's own self-check.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { memberAudience } from "../audience.ts";
import { audienceHome } from "../engine-homes/layout.ts";
import { detectBox } from "./detect.ts";
import { bwrapArgs, planBox, type BoxRequest } from "./plan.ts";
import { toolCacheEnvironment } from "./tool-caches.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "omb-tool-caches-box-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home"), dataDir = join(home, ".openmausbot");
const ana = audienceHome(dataDir, memberAudience("p_ana")), ben = audienceHome(dataDir, memberAudience("p_ben"));
const cwd = join(dataDir, "task-workspaces", "bot-a", "t1");

/** A shell in a box whose HOME is `boxHome` (the server's, or an audience's engine home), with the tool cache variables. */
function runInBox(boxHome: string, script: string): { output: string; env: Record<string, string> } {
  const env = { PATH: "/usr/bin:/bin", HOME: boxHome, ...toolCacheEnvironment(boxHome, {}) };
  const request: BoxRequest = { command: "/bin/sh", args: [], cwd, env, ...(boxHome === home ? {} : { home: boxHome }) };
  const plan = planBox({ dataDir, home, codeRoots: [], engineRoots: [], bridges: [] }, request);
  const ran = spawnSync(detection.tools!.bwrap, [...bwrapArgs(plan), "--", "/bin/sh", "-c", script], { env, encoding: "utf8", timeout: 30_000 });
  return { output: `${ran.stdout}${ran.stderr}`, env };
}

describe.skipIf(!available)(`tool caches in a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  beforeAll(() => {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(dataDir, "cache", "node-compile"), { recursive: true });
    writeFileSync(join(dataDir, "cache", "node-compile", "entry"), "the app's own");
    for (const audience of [ana, ben]) mkdirSync(audience, { recursive: true });
    mkdirSync(join(ben, "cache", "npm"), { recursive: true });
    writeFileSync(join(ben, "cache", "npm", "index"), "ben's packages");
  });

  it("a personal Cloud's box writes each tool's cache under HOME/cache, and never sees the app's own cache folder", () => {
    const { output, env } = runInBox(home, [
      'for d in "$npm_config_cache" "$PIP_CACHE_DIR" "$UV_CACHE_DIR" "$HF_HUB_CACHE" "$BUN_INSTALL_CACHE_DIR"; do mkdir -p "$d" && printf ok > "$d/probe" || echo "CANNOT-WRITE $d"; done',
      `cat "${join(dataDir, "cache", "node-compile", "entry")}" 2>/dev/null || echo APP-CACHE-HIDDEN`,
    ].join("\n"));
    expect(output).not.toContain("CANNOT-WRITE");
    expect(output).toContain("APP-CACHE-HIDDEN");
    for (const name of ["npm_config_cache", "PIP_CACHE_DIR", "UV_CACHE_DIR", "HF_HUB_CACHE", "BUN_INSTALL_CACHE_DIR"]) {
      expect(env[name]!.startsWith(join(home, "cache"))).toBe(true);
      expect(readFileSync(join(env[name]!, "probe"), "utf8")).toBe("ok");
    }
  });

  it("a Team Cloud member's box has its own cache folder in its engine home, and cannot read another member's", () => {
    const { output, env } = runInBox(ana, [
      'mkdir -p "$npm_config_cache" && printf ok > "$npm_config_cache/probe" || echo CANNOT-WRITE',
      `cat "${join(ben, "cache", "npm", "index")}" 2>/dev/null || echo BEN-UNREADABLE`,
      `ls "${join(home, "cache")}" 2>/dev/null || echo SERVER-HOME-CACHE-ABSENT`,
    ].join("\n"));
    expect(output).not.toContain("CANNOT-WRITE");
    expect(output).toContain("BEN-UNREADABLE");
    expect(output).not.toContain("ben's packages");
    expect(output).toContain("SERVER-HOME-CACHE-ABSENT");
    expect(env.npm_config_cache).toBe(join(ana, "cache", "npm"));
    expect(existsSync(join(ana, "cache", "npm", "probe"))).toBe(true);
  });
});
