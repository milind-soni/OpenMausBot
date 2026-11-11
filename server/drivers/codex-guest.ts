import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { codexSkillRoots } from "../imported-skills.ts";
import { deniedNativeSkills } from "../native-skill-choices.ts";

const plainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** A guest-driven turn's app-server: shell, unified exec and image reads (codex-cli 0.159.0
 * `features`) off, web search too. */
export const GUEST_CONFINED_CODEX_ARGS = [
  "-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.view_image=false", "-c", 'web_search="disabled"',
] as const;

export function codexShellDisabled(config: unknown): boolean {
  const features = plainRecord(plainRecord(config)?.features);
  return features?.shell_tool === false && features?.unified_exec === false && features?.view_image === false;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `-c skills.config=[…]` selecting each SKILL.md this bot switched off by absolute path: a `name` selector would also
 * match the same-named skills linked into the turn's `.agents/skills`. codex-cli (0.163.0–0.167.0) keeps
 * `[[skills.config]]` from config.toml in effect alongside it and reads the list once per turn. Throws
 * NativeSkillChoicesUnreadable. */
export function codexDisabledNativeSkillArgs(botId: string | undefined, env: Record<string, string | undefined>): string[] {
  if (!botId) return [];
  const denied = deniedNativeSkills(botId);
  const inRoots = codexSkillRoots(env.HOME ?? homedir(), env.CODEX_HOME).flatMap((root) => denied.names.map((name) => join(root, name, "SKILL.md")));
  const files = [...new Set([...inRoots, ...denied.origins])].filter(isFile);
  if (!files.length) return [];
  const tables = files.map((file) => `{path=${JSON.stringify(file)},enabled=false}`).join(",");
  return ["-c", `skills.config=[${tables}]`];
}

export function codexTurnConfigArgs(turn: { guestConfined?: boolean; botId?: string }, env: Record<string, string | undefined>): string[] {
  return [
    ...(turn.guestConfined ? GUEST_CONFINED_CODEX_ARGS : []),
    ...codexDisabledNativeSkillArgs(turn.botId, env),
  ];
}
