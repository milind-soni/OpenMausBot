// What the engine card offers when a newer stable Codex CLI is out: the update command for the configured executable.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { cloudHomeConfigured } from "../cloud-home.ts";
import type { ProviderSnapshot } from "../contracts.ts";
import { enginesBinDir, enginesPrefix, npmInstallArgs } from "../engine-install.ts";
import { findCliCandidates, splitCliString } from "../env-path.ts";
import { pinnedNpmVersion } from "../engine-versions.ts";
import { codexVersionBehind, readLatestCodexRelease } from "./codex-release.ts";

const CODEX_NPM_PACKAGE = "@openai/codex";

function shellQuote(token: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `'${token.replaceAll("'", "''")}'` : `'${token.replaceAll("'", `'\\''`)}'`;
}

/** Ask the configured executable to update itself, so a non-PATH Codex is the one updated. */
export function codexUpdateCommand(cli: string, platform: NodeJS.Platform = process.platform): string {
  if (cli === "codex") return "codex update";
  const trimmed = cli.trim();
  const tokens = trimmed.includes(" ") && existsSync(trimmed)
    ? [trimmed]
    : splitCliString(trimmed);
  const command = (tokens.length > 0 ? tokens : [trimmed]).map((token) => shellQuote(token, platform)).join(" ");
  return platform === "win32" ? `& ${command} update` : `${command} update`;
}

/** The install the app runs for `codex` from its own npm folder (found ahead of the person's PATH): `codex update` would
 * update npm's global copy instead, so the command installs the release into the app's folder. */
export function codexAppCopyUpdateCommand(version: string, prefix = enginesPrefix(), platform: NodeJS.Platform = process.platform): string {
  const args = npmInstallArgs(prefix, CODEX_NPM_PACKAGE, version);
  return ["npm", ...args.map((arg) => /^[\w.=-]+$/u.test(arg) ? arg : shellQuote(arg, platform))].join(" ");
}

function runsAppCopy(cli: string): boolean {
  if (cli !== "codex") return false;
  const found = findCliCandidates(cli)[0];
  return found !== undefined && dirname(found) === enginesBinDir();
}

export async function codexReleaseUpdate(version: string, cli: string, onCloud = cloudHomeConfigured()): Promise<ProviderSnapshot["update"] | undefined> {
  const latest = await readLatestCodexRelease();
  if (!latest || !codexVersionBehind(version, latest)) return undefined;
  // My Cloud's Codex comes with the image, in a folder nobody can write to, and updates with the Cloud: nothing to offer there.
  if (onCloud) return undefined;
  const pinned = pinnedNpmVersion("codex");
  const needsTerminal = pinned !== undefined && codexVersionBehind(pinned, latest);
  return {
    title: `Update Codex to ${latest}`,
    message: needsTerminal
      ? `A newer stable Codex CLI is available (installed: ${version}). The app installer supplies tested version ${pinned}. To install ${latest}, use the terminal command below, then refresh models. Model availability also depends on your signed-in account.`
      : `A newer stable Codex CLI is available (installed: ${version}). Update it, then refresh models. Model availability also depends on your signed-in account.`,
    command: runsAppCopy(cli) ? codexAppCopyUpdateCommand(latest) : codexUpdateCommand(cli),
    ...(needsTerminal ? { serverInstall: false as const } : {}),
  };
}
