import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../../config.ts";
import { resolveAcpClientPath } from "./client-path.ts";

describe("ACP client paths", () => {
  it("allows turn-selected profile reads without granting writes or other profile files", async () => {
    const cwd = join(DATA_DIR, "client-task");
    const profile = join(DATA_DIR, "profile");
    const skill = join(profile, "omb-skills", "hash");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(skill, "references"), { recursive: true });
    const file = join(skill, "references", "guide.md");
    writeFileSync(file, "reviewed");
    await expect(resolveAcpClientPath(file, cwd, [skill])).resolves.toBe(realpathSync(file));
    await expect(resolveAcpClientPath(file, cwd)).rejects.toThrow("outside");
    await expect(resolveAcpClientPath(join(profile, "acp_token.json"), cwd, [skill])).rejects.toThrow("outside");
    await expect(resolveAcpClientPath(join(skill + "-other", "SKILL.md"), cwd, [skill])).rejects.toThrow("outside");
    await expect(resolveAcpClientPath("relative", cwd, [skill])).rejects.toThrow("absolute");
    symlinkSync(cwd, join(skill, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveAcpClientPath(join(skill, "escape", "new.md"), cwd, [skill])).rejects.toThrow("outside");
  });
});
