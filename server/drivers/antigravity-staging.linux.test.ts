import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detectBox } from "../bot-box/detect.ts";
import { bwrapArgs, planBox } from "../bot-box/plan.ts";
import { stageAntigravitySkills } from "./antigravity-skills.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, mkdtempSync: vi.fn(fs.mkdtempSync) };
});
const originalMkdtemp = (await vi.importActual<typeof import("node:fs")>("node:fs")).mkdtempSync;
const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const roots: string[] = [];
afterEach(() => {
  vi.mocked(mkdtempSync).mockReset().mockImplementation(originalMkdtemp);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(detection.box !== "bwrap")("Antigravity profile staging in real bubblewrap", () => {
  it("blocks profile-root replacement between validation and staging publication", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-profile-staging-"));
    roots.push(root);
    const home = join(root, "home");
    const dataDir = join(home, ".openmausbot");
    const profile = join(dataDir, "providers", "antigravity", "account");
    const skills = join(profile, "omb-skills");
    const outside = join(home, "escaped");
    const cwd = join(dataDir, "task-workspaces", "bot", "thread");
    const source = join(dataDir, "workspaces", "bot", "skills", "reviewed");
    for (const folder of [skills, outside, cwd, source]) mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(source, "SKILL.md");
    writeFileSync(file, "Reviewed instructions");
    const plan = planBox({ home, dataDir, codeRoots: [], engineRoots: [], bridges: [] }, {
      command: process.execPath, args: [], cwd, env: { HOME: home, GEMINI_HOME: profile },
      net: "shared", ro: [skills, process.execPath],
    });
    const attack = `
      const fs = require("node:fs");
      const [root, outside] = process.argv.slice(1);
      try {
        fs.renameSync(root, root + "-original");
        fs.symlinkSync(outside, root, "dir");
        console.log("replaced");
      } catch (error) { console.log(error.code); }
    `;
    vi.mocked(mkdtempSync).mockClear().mockImplementationOnce((prefix, options) => {
      expect(String(prefix)).toBe(join(realpathSync(skills), ".stage-"));
      const probe = spawnSync(detection.tools!.bwrap, [
        ...bwrapArgs(plan), "--", process.execPath, "-e", attack, skills, outside,
      ], { encoding: "utf8", timeout: 10_000 });
      expect(probe.status, probe.stderr).toBe(0);
      expect(["EBUSY", "EROFS", "EACCES", "EPERM"]).toContain(probe.stdout.trim());
      return originalMkdtemp(prefix, options);
    });
    const staged = stageAntigravitySkills({
      threadId: "thread", cwd, text: "Read " + JSON.stringify(file), skillFiles: [file],
    }, profile);
    expect(vi.mocked(mkdtempSync)).toHaveBeenCalledTimes(1);
    expect(readFileSync(staged.skillFiles![0]!, "utf8")).toBe("Reviewed instructions");
    expect(readdirSync(outside)).toEqual([]);
  });
});
