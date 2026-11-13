import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../../config.ts";
import { resolveAcpClientPath } from "./client-path.ts";

describe("ACP client paths", () => {
  it("allows turn-selected profile reads without granting writes or other profile files", async () => {
    const cwd = join(DATA_DIR, "client-task");
    const profile = join(DATA_DIR, "profile");
    let skill = join(profile, "omb-skills", "hash");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(skill, "references"), { recursive: true });
    skill = realpathSync(skill);
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

  it.each(["root", "parent"])("rejects a staged %s replaced after staging", async (part) => {
    const base = join(DATA_DIR, "swapped-" + part);
    const cwd = join(base, "task");
    const parent = join(base, "omb-skills");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(parent, "hash"), { recursive: true });
    const root = realpathSync(join(parent, "hash"));
    const file = join(root, "secret.md");
    writeFileSync(file, "reviewed");
    await expect(resolveAcpClientPath(file, cwd, [root])).resolves.toBe(file);
    const outside = join(base, "outside");
    mkdirSync(part === "parent" ? join(outside, "hash") : outside, { recursive: true });
    writeFileSync(join(outside, ...(part === "parent" ? ["hash", "secret.md"] : ["secret.md"])), "private");
    const swapped = part === "parent" ? realpathSync(parent) : root;
    renameSync(swapped, swapped + "-original");
    symlinkSync(outside, swapped, process.platform === "win32" ? "junction" : "dir");
    await expect(resolveAcpClientPath(file, cwd, [root])).rejects.toThrow("expected location");
  });

  it("keeps symlinked workspace resolution unchanged", async () => {
    const real = join(DATA_DIR, "real-workspace");
    const linked = join(DATA_DIR, "linked-workspace");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "note.md"), "workspace");
    symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(resolveAcpClientPath(join(linked, "note.md"), linked)).resolves.toBe(realpathSync(join(real, "note.md")));
  });
});
