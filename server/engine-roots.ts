import { join } from "node:path";

/** The npm prefix engines are installed and updated into. */
export function npmEnginesPrefix(dataDir: string): string {
  return join(dataDir, "tools", "npm");
}

/** Antigravity's own runtime releases, one folder per platform. */
export function antigravityRuntimesRoot(dataDir: string): string {
  return join(dataDir, "tools", "antigravity-acp");
}

/** Every folder OpenMausBot installs engine code into. Only packages and releases live there, never a sign-in or a
 * setting, which is what lets the bot box show them to every turn (read-only). */
export function engineInstallRoots(dataDir: string): string[] {
  return [npmEnginesPrefix(dataDir), antigravityRuntimesRoot(dataDir)];
}
