import { disabledNativeSkillNames } from "../native-skill-choices.ts";

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

/** `-c skills.config=[…]` so Codex skips native skills this bot switched off, without touching ~/.codex/skills.
 * It replaces any skills.config in ~/.codex/config.toml for that turn; the Skills page hint says so. */
export function codexDisabledNativeSkillArgs(botId: string | undefined): string[] {
  const names = disabledNativeSkillNames(botId ?? "");
  if (!names.length) return [];
  const tables = names.map((name) => `{name=${JSON.stringify(name)},enabled=false}`).join(",");
  return ["-c", `skills.config=[${tables}]`];
}

/** Guest confinement and per-bot native skill disables for one Codex turn. */
export function codexTurnConfigArgs(turn: { guestConfined?: boolean; botId?: string }): string[] {
  return [
    ...(turn.guestConfined ? GUEST_CONFINED_CODEX_ARGS : []),
    ...codexDisabledNativeSkillArgs(turn.botId),
  ];
}
