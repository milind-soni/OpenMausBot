// Which VPS host a bot's computer lives on: the app-wide SSH alias, or the bot's own.
import { isValidSshAlias, vpsSshAlias, type AppConfig, type VpsConfig } from "./config.ts";

/** A named server's own limits, each falling back to the default server's; unset ones are left out (4 GB and 2 cores apply). */
export function vpsLimits(cfg: AppConfig, alias?: string | null): Pick<VpsConfig, "memoryGb" | "cpus"> {
  const own = alias ? cfg.vpsServers?.find((server) => server.sshAlias === alias) : undefined;
  const memoryGb = own?.memoryGb ?? cfg.vps?.memoryGb;
  const cpus = own?.cpus ?? cfg.vps?.cpus;
  return { ...(memoryGb ? { memoryGb } : {}), ...(cpus ? { cpus } : {}) };
}

/** A bot's own SSH alias wins over the default; both are validated the same way. */
export function vpsSshAliasForBot(cfg: AppConfig, bot: { vpsAlias?: string } | null | undefined): string | null {
  return isValidSshAlias(bot?.vpsAlias) ? bot.vpsAlias : vpsSshAlias(cfg);
}

/** A config scoped to one bot's VPS alias, shaped for the vps-computer calls. */
export function vpsConfigForBot(cfg: AppConfig, bot: { vpsAlias?: string } | null | undefined): AppConfig {
  const sshAlias = vpsSshAliasForBot(cfg, bot);
  return sshAlias ? { vps: { sshAlias, ...vpsLimits(cfg, sshAlias) } } : {};
}

/** Every alias this installation can hold VPS computers on: the default first, then each bot's own. */
export function vpsAliasesInPlay(cfg: AppConfig, bots: ReadonlyArray<{ vpsAlias?: string }>): string[] {
  const aliases = new Set<string>();
  const primary = vpsSshAlias(cfg);
  if (primary) aliases.add(primary);
  for (const bot of bots) {
    if (isValidSshAlias(bot.vpsAlias)) aliases.add(bot.vpsAlias);
  }
  return [...aliases];
}
