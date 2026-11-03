// A Mac app opened from the Dock or Finder gets launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the person's
// shell PATH, so Homebrew's tools and ~/.local/bin are missing from a lent terminal's commands.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MARK = "__OMB_PATH__";

/** -l -i: Homebrew, nvm and friends live in rc files that only an interactive login shell reads; the mark isolates
 * $PATH from what those files print. */
export function probeShellPath({ shell = process.env.SHELL || "/bin/zsh" } = {}) {
  return new Promise(resolve => {
    execFile(shell, ["-l", "-i", "-c", `printf "${MARK}%s" "$PATH"`], { timeout: 5000 }, (error, stdout) => {
      const found = error ? null : new RegExp(`${MARK}([^\\n]*)`).exec(String(stdout));
      resolve(found?.[1] || null);
    });
  });
}

let shellPath;

/** The person's shell PATH first, then the app's own, then the usual install folders; read from the shell once. */
export async function commandPath({ platform = process.platform, env = process.env, home = os.homedir(), probe, exists = existsSync } = {}) {
  if (platform === "win32") return env.PATH;
  const fromShell = probe ? await probe() : await (shellPath ??= probeShellPath());
  // POSIX joins: this list is only for macOS and Linux, whatever the host that computes it.
  const known = ["/opt/homebrew/bin", "/usr/local/bin", path.posix.join(home, ".local", "bin")].filter(dir => exists(dir));
  return [...new Set([fromShell, env.PATH].flatMap(list => list?.split(":") ?? []).concat(known).filter(Boolean))].join(":");
}
