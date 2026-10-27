// What the engine card offers when a newer stable Codex CLI is out: the update command for the configured executable.
import { existsSync } from "node:fs";
import type { ProviderSnapshot } from "../contracts.ts";
import { splitCliString } from "../env-path.ts";
import { codexVersionBehind, readLatestCodexRelease } from "./codex-release.ts";

/** Ask the configured executable to update itself, so a non-PATH Codex is the one updated. */
export function codexUpdateCommand(cli: string, platform: NodeJS.Platform = process.platform): string {
  if (cli === "codex") return "codex update";
  const trimmed = cli.trim();
  const tokens = trimmed.includes(" ") && existsSync(trimmed)
    ? [trimmed]
    : splitCliString(trimmed);
  const quote = platform === "win32"
    ? (token: string) => `'${token.replaceAll("'", "''")}'`
    : (token: string) => `'${token.replaceAll("'", `'\\''`)}'`;
  const command = (tokens.length > 0 ? tokens : [trimmed]).map(quote).join(" ");
  return platform === "win32" ? `& ${command} update` : `${command} update`;
}

export async function codexReleaseUpdate(version: string, cli: string): Promise<ProviderSnapshot["update"] | undefined> {
  const latest = await readLatestCodexRelease();
  if (!latest || !codexVersionBehind(version, latest)) return undefined;
  return {
    title: `Update Codex to ${latest}`,
    message: `A newer stable Codex CLI is available (installed: ${version}). Update it, then refresh models. Model availability also depends on your signed-in account.`,
    command: codexUpdateCommand(cli),
  };
}
