#!/usr/bin/env node
/** Host-only Claude authentication helper for the full-task-scoped profile.
 *
 * Claude's bare mode accepts a Console/API credential only through
 * apiKeyHelper. This process asks CredVault to inject one configured logical
 * alias into a one-shot child and relays the value only to Claude's private
 * helper pipe. The value never enters the agent environment, argv, OpenMaus
 * logs, transcripts, telemetry, or the capability gateway.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function validAlias(value: string | undefined): string {
  const alias = value?.trim() ?? "";
  if (
    !/^[A-Za-z0-9_.\/-]{1,200}$/.test(alias) ||
    alias.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Claude API credential alias is invalid");
  return alias;
}

function injectedCredential(): string {
  const value = process.env.ANTHROPIC_API_KEY;
  if (typeof value !== "string" || value.length < 16 || /[\r\n\0]/.test(value)) {
    throw new Error("injected Claude API credential is unavailable");
  }
  return value;
}

export function claudeApiKeyHelperChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ELECTRON_RUN_AS_NODE: "1",
    ...(source.HOME ? { HOME: source.HOME } : {}),
    ...(source.USERPROFILE ? { USERPROFILE: source.USERPROFILE } : {}),
    ...(source.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: source.XDG_CONFIG_HOME } : {}),
  };
}

export function readClaudeApiKey(
  aliasValue: string | undefined,
  run: typeof spawnSync = spawnSync,
): string {
  const alias = validAlias(aliasValue);
  const self = fileURLToPath(import.meta.url);
  const result = run(
    "credvault",
    ["exec", alias, "ANTHROPIC_API_KEY", "--", process.execPath, self, "--emit-injected"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
      env: claudeApiKeyHelperChildEnv(),
    },
  );
  if (result.status !== 0 || result.error) throw new Error("CredVault Claude API credential injection failed");
  const value = result.stdout;
  if (typeof value !== "string" || value.length < 16 || /[\r\n\0]/.test(value)) {
    throw new Error("CredVault Claude API credential is unavailable");
  }
  return value;
}

export function isClaudeApiKeyHelperEntrypoint(
  argvPath: string | undefined = process.argv[1],
  modulePath: string = fileURLToPath(import.meta.url),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!argvPath) return false;
  try {
    const moduleRealPath = realpathSync(modulePath);
    const argvRealPath = realpathSync(resolve(argvPath));
    return platform === "win32"
      ? moduleRealPath.toLowerCase() === argvRealPath.toLowerCase()
      : moduleRealPath === argvRealPath;
  } catch {
    return false;
  }
}

function main(): number {
  try {
    process.stdout.write(process.argv[2] === "--emit-injected" ? injectedCredential() : readClaudeApiKey(process.argv[2]));
    return 0;
  } catch {
    // Never print the underlying keychain/parser error: implementations may
    // include credential material in exception text.
    process.stderr.write("OpenMaus Claude host authentication is unavailable.\n");
    return 1;
  }
}

if (isClaudeApiKeyHelperEntrypoint()) process.exitCode = main();
