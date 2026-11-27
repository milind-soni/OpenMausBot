import { BOT_TASKS_DEFAULTS, type BotTasksSettings } from "../../shared/bot-tasks.ts";
import type { AppConfig } from "../config.ts";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { readConfigFile } from "../config-backup.ts";
import type { VaultStore } from "../vault-store.ts";

/** The saved `botTasks` section with every default filled in. */
export function botTasksSettings(cfg: Pick<AppConfig, "botTasks">): BotTasksSettings {
  const saved = cfg.botTasks ?? {};
  return {
    enabled: saved.enabled ?? BOT_TASKS_DEFAULTS.enabled,
    githubSync: saved.githubSync ?? BOT_TASKS_DEFAULTS.githubSync,
    pollMinutes: saved.pollMinutes ?? BOT_TASKS_DEFAULTS.pollMinutes,
    repos: [...(saved.repos ?? BOT_TASKS_DEFAULTS.repos)],
    credential: saved.credential ?? BOT_TASKS_DEFAULTS.credential,
    requireEvidenceForDone: saved.requireEvidenceForDone ?? BOT_TASKS_DEFAULTS.requireEvidenceForDone,
    requireEvidenceForReview: saved.requireEvidenceForReview ?? BOT_TASKS_DEFAULTS.requireEvidenceForReview,
    allowOutboundComments: saved.allowOutboundComments ?? BOT_TASKS_DEFAULTS.allowOutboundComments,
    allowMerge: saved.allowMerge ?? BOT_TASKS_DEFAULTS.allowMerge,
  };
}

/** What the app is shown: the settings and whether a token is saved, never the token. */
export function botTasksStatus(cfg: Pick<AppConfig, "botTasks">, token: string | null): BotTasksSettings & { githubTokenSet: boolean } {
  return { ...botTasksSettings(cfg), githubTokenSet: Boolean(token) };
}

export function migrateBotTasksGithubToken(dataDir: string, vault: Pick<VaultStore, "botTasksGithubToken" | "setBotTasksGithubToken">): void {
  const path = join(dataDir, "config.json");
  const config = readConfigFile(path);
  if (config.state !== "ok") return;
  const settings = config.value.botTasks;
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || !Object.hasOwn(settings, "githubToken")) return;
  const token = typeof settings.githubToken === "string" ? settings.githubToken.trim() : "";
  if (token && !vault.botTasksGithubToken()) vault.setBotTasksGithubToken(token);
  delete settings.githubToken;
  if (settings.credential === "token") settings.credential = "vault";
  writeFileAtomic(path, JSON.stringify(config.value, null, 2), { mode: 0o600 });
}

export const repoAllowed = (settings: Pick<BotTasksSettings, "repos">, repo: string): boolean => settings.repos.some((allowed) => allowed.toLowerCase() === repo.toLowerCase());
