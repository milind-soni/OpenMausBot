// Whether the person's own GitHub CLI has an account for github.com, from its hosts file alone: for a spawn that must
// decide at once whether to set git up, where a gh program on PATH says nothing about a sign-in. gh keeps the file in
// GH_CONFIG_DIR, else XDG_CONFIG_HOME/gh, else %AppData%/GitHub CLI on Windows, else ~/.config/gh. The token itself is
// often in the OS keyring and is not read here.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { hostsFileLogin } from "./gh-output.ts";

export function personalGhHostsFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.GH_CONFIG_DIR) return join(env.GH_CONFIG_DIR, "hosts.yml");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gh", "hosts.yml");
  if (platform === "win32" && env.AppData) return join(env.AppData, "GitHub CLI", "hosts.yml");
  return join(env.HOME || homedir(), ".config", "gh", "hosts.yml");
}

/** The login the person's own gh lists for github.com, or null. */
export function personalGhLogin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  try {
    return hostsFileLogin(readFileSync(personalGhHostsFile(env, platform), "utf8"));
  } catch {
    return null;
  }
}
