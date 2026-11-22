import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeUserMcpEnabled, mcpCallTimeoutMinutes, type AppConfig } from "./config.ts";
import { correctiveRounds } from "./host/loop-guard.ts";

export function claudeUserSkillsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.claudeUserSkills === true;
}

/** A folder whose `.claude/skills` links to the person's own `~/.claude/skills`, for Claude Code's `--add-dir`: each skill
 * loads as it is on disk, scripts and references included, and edits arrive live. Null when there is nothing to link.
 * A skill the project in `cwd` ships under the same name stays the project's. */
export function claudeUserSkillsDir(dataDir: string, home = homedir(), cwd?: string): string | null {
  const source = join(home, ".claude", "skills");
  try {
    if (!statSync(source).isDirectory()) return null;
  } catch {
    return null;
  }
  const shadowed = projectSkillNames(cwd).filter((name) => existsSync(join(source, name)));
  if (cwd && shadowed.length > 0) return claudeUserSkillsDirWithout(dataDir, source, cwd, shadowed);
  const root = join(dataDir, "claude-user-skills");
  const link = join(root, ".claude", "skills");
  try {
    if (resolve(readlinkSync(link)) === resolve(source)) return root;
  } catch {}
  try {
    mkdirSync(join(root, ".claude"), { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {}
    symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
    return root;
  } catch {
    return null;
  }
}

/** The skill names the project in `cwd` ships in its own `.claude/skills`. */
function projectSkillNames(cwd: string | undefined): string[] {
  if (!cwd) return [];
  try {
    return readdirSync(join(cwd, ".claude", "skills")).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/** Removes a link and only the link: a Windows junction is removed as a folder, and a real folder with anything in it
 * is left alone. */
function dropLink(path: string): void {
  try {
    if (!lstatSync(path).isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    try {
      rmdirSync(path);
    } catch {}
  }
}

/** Claude Code keeps both when a project skill and a skill under `--add-dir` share a name, so the bot sees each twice. A
 * project with such a skill gets a folder of its own, one link per personal skill and the shadowed names left out, so
 * the project's version wins as it does in a terminal. */
function claudeUserSkillsDirWithout(dataDir: string, source: string, cwd: string, shadowed: string[]): string | null {
  const root = join(dataDir, "claude-user-skills", "for", createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12));
  const dir = join(root, ".claude", "skills");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const wanted = new Set(readdirSync(source).filter((name) => !name.startsWith(".") && !shadowed.includes(name)));
    for (const entry of readdirSync(dir)) {
      let target = "";
      try {
        target = readlinkSync(join(dir, entry));
      } catch {}
      if (!wanted.has(entry) || resolve(target) !== resolve(join(source, entry))) dropLink(join(dir, entry));
    }
    for (const name of wanted) {
      try {
        lstatSync(join(dir, name));
      } catch {
        symlinkSync(join(source, name), join(dir, name), process.platform === "win32" ? "junction" : "dir");
      }
    }
    return root;
  } catch {
    return null;
  }
}

/** The links and their folders, once the switch is off; only the links themselves, never what they point to. */
export function forgetClaudeUserSkillsDir(dataDir: string): void {
  const root = join(dataDir, "claude-user-skills");
  dropLink(join(root, ".claude", "skills"));
  const perProject = join(root, "for");
  let projects: string[] = [];
  try {
    projects = readdirSync(perProject);
  } catch {}
  for (const project of projects) {
    const skills = join(perProject, project, ".claude", "skills");
    let entries: string[] = [];
    try {
      entries = readdirSync(skills);
    } catch {}
    for (const entry of entries) dropLink(join(skills, entry));
    for (const folder of [skills, join(perProject, project, ".claude"), join(perProject, project)]) {
      try {
        rmdirSync(folder);
      } catch {}
    }
  }
  for (const folder of [perProject, join(root, ".claude"), root]) {
    try {
      rmdirSync(folder);
    } catch {}
  }
}

/** The fields of an engine turn that come from Settings. */
export function settingsTurnFields(cfg: AppConfig, dataDir: string, restrictsMcp: boolean, home = homedir(), cwd?: string): {
  mcpFromUserConfig: boolean;
  userSkillsDir?: string;
  mcpCallTimeoutMs: number;
  toolErrorCorrectiveRounds: number;
} {
  const userSkillsDir = claudeUserSkillsEnabled(cfg) ? claudeUserSkillsDir(dataDir, home, cwd) : null;
  if (!claudeUserSkillsEnabled(cfg)) forgetClaudeUserSkillsDir(dataDir);
  return {
    mcpFromUserConfig: claudeUserMcpEnabled(cfg) && !restrictsMcp,
    ...(userSkillsDir ? { userSkillsDir } : {}),
    mcpCallTimeoutMs: mcpCallTimeoutMinutes(cfg) * 60_000,
    toolErrorCorrectiveRounds: correctiveRounds(cfg),
  };
}
