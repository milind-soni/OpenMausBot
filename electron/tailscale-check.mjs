// Runs only when the person presses Turn on or Check again on the Tailscale route. Never opens or signs in the
// Tailscale app, and never logs Tailscale's raw output (it can carry auth keys and node names).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every CLI first, PATH included; the macOS app's own executable last, and only ever in CLI mode. */
export function tailscaleCandidates(home = os.homedir()) {
  return [
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/run/current-system/sw/bin/tailscale",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    path.join(home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"),
  ];
}

const onPath = (name, env) => (env.PATH ?? "").split(path.delimiter).filter(Boolean).some((dir) => fs.existsSync(path.join(dir, name)));

/** Looks for files only: nothing is run. */
export function tailscaleInstalled({ exists = fs.existsSync, env = process.env, home = os.homedir() } = {}) {
  return tailscaleCandidates(home).some((candidate) => (candidate === "tailscale" ? onPath(process.platform === "win32" ? "tailscale.exe" : "tailscale", env) : exists(candidate)));
}

/** The macOS app executable chooses GUI or CLI mode from its environment; CLI mode never opens the app.
 * https://tailscale.com/docs/reference/tailscale-cli?tab=macos */
export const tailscaleEnvironment = (env = process.env) => ({
  ...env,
  PATH: [env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter),
  TAILSCALE_BE_CLI: "1",
});

const runStatus = (cli) =>
  new Promise((resolve) => {
    execFile(cli, ["status", "--json"], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env: tailscaleEnvironment(), windowsHide: true },
      (error, stdout) => resolve({ missing: error?.code === "ENOENT", stdout: String(stdout ?? "") }));
  });

/** What one `tailscale status --json` says: ready with this computer's MagicDNS name, signed out (or not running), or
 * not installed. */
export function readTailscaleStatus(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "signed-out" };
  }
  const dns = parsed?.Self?.DNSName;
  const name = typeof dns === "string" ? dns.replace(/\.$/, "").toLowerCase() : "";
  if (parsed?.BackendState !== "Running" || !name.endsWith(".ts.net")) return { state: "signed-out" };
  return { state: "ready", name };
}

export async function checkTailscale({ run = runStatus, installed = () => tailscaleInstalled(), candidates = tailscaleCandidates() } = {}) {
  if (!installed()) return { state: "not-installed" };
  let seen = false;
  for (const cli of candidates) {
    const result = await run(cli);
    if (result.missing) continue;
    seen = true;
    const status = readTailscaleStatus(result.stdout);
    if (status.state === "ready") return status;
  }
  return { state: seen ? "signed-out" : "not-installed" };
}
