// Serving over a tailnet: find the Tailscale CLI, read this machine's
// MagicDNS name, and ask Tailscale to terminate HTTPS for the server.
// Nothing here logs Tailscale's raw stderr: it can contain auth keys and
// node names, so failures are classified into a closed set of reasons.
import { execFile } from "node:child_process";

import { searchPath, tailscaleCandidates } from "../companion/src/listener.ts";

export interface TailscaleStatus {
  cli: string;
  /** MagicDNS name without the trailing dot, e.g. mini.tail1234.ts.net */
  dnsName: string | null;
  /** Tailnet IPs (100.64/10 and the IPv6 one) */
  addresses: string[];
  backendState: string;
}

export type TailscaleFailure =
  | "not-installed"
  | "not-logged-in"
  | "not-running"
  | "no-magicdns"
  | "needs-operator"
  | "https-not-enabled"
  | "unknown";

/** Turn Tailscale's stderr into a reason without repeating it. */
export function classifyTailscaleStderr(text: string): TailscaleFailure {
  const t = text.toLowerCase();
  if (/not logged in|logged out|needs login|please log in/.test(t)) return "not-logged-in";
  if (/is tailscale running|tailscaled is not running|connection refused|failed to connect to local tailscaled/.test(t)) return "not-running";
  if (/access denied|permission denied|operator|must be root|not permitted/.test(t)) return "needs-operator";
  if (/https is not enabled|enable https|cert|tls certs/.test(t)) return "https-not-enabled";
  if (/magicdns/.test(t)) return "no-magicdns";
  return "unknown";
}

/** What to do about it, for a person. */
export function explainTailscaleFailure(reason: TailscaleFailure): string {
  switch (reason) {
    case "not-installed":
      return "Tailscale is not installed: https://tailscale.com/download";
    case "not-logged-in":
      return "Tailscale is installed but not signed in: run `tailscale up` (or sign in from the Tailscale app)";
    case "not-running":
      return "Tailscale is not running: start it, then try again";
    case "no-magicdns":
      return "this machine has no MagicDNS name: enable MagicDNS in the tailnet's DNS settings";
    case "needs-operator":
      return "Tailscale refused: on Linux run `sudo tailscale set --operator=$USER` once, then try again";
    case "https-not-enabled":
      return "HTTPS certificates are off for this tailnet: enable them in the admin console (DNS → HTTPS Certificates)";
    default:
      return "Tailscale reported an error; run `tailscale status` and `tailscale serve status` to see it";
  }
}

function run(cli: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      cli,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: searchPath() } },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0;
        resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
      },
    );
  });
}

/** Parse `tailscale status --json`. Exported for tests. */
export function parseTailscaleStatus(cli: string, stdout: string): TailscaleStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const self = Reflect.get(Object(parsed), "Self");
  const dns = Reflect.get(Object(self), "DNSName");
  const ips = Reflect.get(Object(self), "TailscaleIPs");
  const state = Reflect.get(Object(parsed), "BackendState");
  return {
    cli,
    dnsName: typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null,
    addresses: Array.isArray(ips) ? ips.filter((v): v is string => typeof v === "string") : [],
    backendState: typeof state === "string" ? state : "unknown",
  };
}

/** Find a working Tailscale CLI and read its status. */
export async function tailscaleStatus(): Promise<{ status: TailscaleStatus } | { failure: TailscaleFailure }> {
  let sawCli = false;
  for (const cli of tailscaleCandidates()) {
    const result = await run(cli, ["status", "--json"], 5_000);
    if (!result.ok && !result.stdout && result.code === null) continue; // not found or timed out
    sawCli = true;
    const status = parseTailscaleStatus(cli, result.stdout);
    if (status) {
      if (status.backendState === "NeedsLogin") return { failure: "not-logged-in" };
      if (status.backendState !== "Running") return { failure: "not-running" };
      return { status };
    }
    if (result.stderr) return { failure: classifyTailscaleStderr(result.stderr) };
  }
  return { failure: sawCli ? "unknown" : "not-installed" };
}

/** `tailscale serve --bg --https=<httpsPort> http://127.0.0.1:<localPort>`:
 * Tailscale terminates TLS with its own certificate and forwards with the
 * forwarded headers the server expects. Returns the public origin. */
export async function tailscaleServe(
  status: TailscaleStatus,
  localPort: number,
  httpsPort = 443,
): Promise<{ origin: string } | { failure: TailscaleFailure }> {
  if (!status.dnsName) return { failure: "no-magicdns" };
  const result = await run(status.cli, ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], 20_000);
  if (!result.ok) return { failure: classifyTailscaleStderr(result.stderr || result.stdout) };
  return { origin: httpsPort === 443 ? `https://${status.dnsName}` : `https://${status.dnsName}:${httpsPort}` };
}

export async function tailscaleServeOff(status: TailscaleStatus, httpsPort = 443): Promise<void> {
  await run(status.cli, ["serve", `--https=${httpsPort}`, "off"], 10_000);
}
