// Runs only when the person presses Turn on or Check again on the Tailscale route, and only Tailscale's command-line
// tool: never the macOS app's executable, so the app is never opened or signed in. Never logs Tailscale's raw output
// (it can carry auth keys and node names).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Tailscale's command-line tool where its installers put it, then PATH. */
export const TAILSCALE_CLI_PATHS = Object.freeze([
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/run/current-system/sw/bin/tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  "tailscale",
]);

const macApps = (home) => ["/Applications/Tailscale.app", path.join(home, "Applications", "Tailscale.app")];
const onPath = (name, env) => (env.PATH ?? "").split(path.delimiter).filter(Boolean).some((dir) => fs.existsSync(path.join(dir, name)));

/** Looks for files only: nothing is run. "app-only" is the macOS app without its command-line tool. */
export function tailscaleInstall({ exists = fs.existsSync, env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const cli = TAILSCALE_CLI_PATHS.some((candidate) => (candidate === "tailscale" ? onPath(platform === "win32" ? "tailscale.exe" : "tailscale", env) : exists(candidate)));
  if (cli) return "cli";
  return macApps(home).some((app) => exists(app)) ? "app-only" : "none";
}

/** The macOS app's command-line tool chooses CLI mode from its environment; keep it explicit.
 * https://tailscale.com/docs/reference/tailscale-cli?tab=macos */
export const tailscaleEnvironment = (env = process.env) => ({
  ...env,
  PATH: [env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter),
  TAILSCALE_BE_CLI: "1",
});

const runStatus = (cli) =>
  new Promise((resolve) => {
    execFile(cli, ["status", "--json"], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env: tailscaleEnvironment(), windowsHide: true },
      (error, stdout, stderr) => resolve({ missing: error?.code === "ENOENT", stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });

/** What one `tailscale status --json` says, in the row's words: ready (with this computer's MagicDNS name), signed out,
 * not running, or not allowed to ask. */
export function readTailscaleStatus(stdout, stderr = "") {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
  }
  if (!parsed) {
    const text = stderr.toLowerCase();
    if (/access denied|permission denied|operator|not permitted/.test(text)) return { state: "needs-permission" };
    return { state: "not-running" };
  }
  if (parsed.BackendState === "Stopped") return { state: "not-running" };
  const dns = parsed?.Self?.DNSName;
  const name = typeof dns === "string" ? dns.replace(/\.$/, "").toLowerCase() : "";
  if (parsed.BackendState !== "Running" || !name.endsWith(".ts.net")) return { state: "signed-out" };
  return { state: "ready", name };
}

export async function checkTailscale({ run = runStatus, install = () => tailscaleInstall(), candidates = TAILSCALE_CLI_PATHS } = {}) {
  const found = install();
  if (found === "none") return { state: "not-installed" };
  if (found === "app-only") return { state: "no-cli" };
  let last = { state: "not-installed" };
  for (const cli of candidates) {
    const result = await run(cli);
    if (result.missing) continue;
    last = readTailscaleStatus(result.stdout, result.stderr);
    if (last.state === "ready") return last;
    break;
  }
  return last;
}
