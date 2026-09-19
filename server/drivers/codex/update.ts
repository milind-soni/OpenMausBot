// Version checks and the self-update command for the codex CLI.
import { existsSync } from "node:fs";

import type { ProviderSnapshot } from "../../contracts.ts";
import { STATIC_CODEX_MODELS } from "../codex-catalog.ts";
import { splitCliString } from "../../env-path.ts";

const ASTRA_MODEL_ID = "gpt-6-astra";
const ASTRA_MIN_CODEX_VERSION = [0, 153, 1] as const;

/** Whether an installed Codex predates the release that exposes GPT-6 Astra
 * through app-server. Unknown version formats stay quiet: a bad guess should
 * never nag someone whose custom build may already support the model. */
export function codexPredatesAstra(version: string): boolean {
  const value = version.trim();
  const match = /\bcodex-cli\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9a-z.-]+)?(?![\d.])\b/i.exec(value)
    ?? /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9a-z.-]+)?$/i.exec(value);
  if (!match) return false;
  const installed = match.slice(1, 4).map(Number);
  for (let i = 0; i < ASTRA_MIN_CODEX_VERSION.length; i += 1) {
    if (installed[i] !== ASTRA_MIN_CODEX_VERSION[i]) {
      return installed[i] < ASTRA_MIN_CODEX_VERSION[i];
    }
  }
  return false;
}

/** Ask the configured executable to update itself. This matters when the user
 * selected a non-PATH Codex: installing a second global copy would leave
 * OpenMausBot pointing at the old binary. */
export function codexUpdateCommand(cli: string, platform: NodeJS.Platform = process.platform): string {
  if (cli === "codex") return "codex update";
  const trimmed = cli.trim();
  // Match resolveCliSpawn's one tokenizer pass, including its exception for
  // real unquoted paths containing spaces. A wrapper's fixed arguments must
  // precede `update`, just as they precede `app-server` and `--version`.
  const tokens = trimmed.includes(" ") && existsSync(trimmed)
    ? [trimmed]
    : splitCliString(trimmed);
  const quote = platform === "win32"
    ? (token: string) => `'${token.replaceAll("'", "''")}'`
    : (token: string) => `'${token.replaceAll("'", `'\\''`)}'`;
  const command = (tokens.length > 0 ? tokens : [trimmed]).map(quote).join(" ");
  return platform === "win32" ? `& ${command} update` : `${command} update`;
}

export function codexAstraUpdate(
  version: string,
  models: typeof STATIC_CODEX_MODELS,
  cli: string,
): ProviderSnapshot["update"] | undefined {
  if (models.options.some((model) => model.id === ASTRA_MODEL_ID) || !codexPredatesAstra(version)) {
    return undefined;
  }
  return {
    title: "Update Codex for GPT-6 Astra",
    message:
      "This Codex version predates Astra support. Update it, then refresh models. Astra must also be available to your signed-in ChatGPT account.",
    command: codexUpdateCommand(cli),
  };
}
