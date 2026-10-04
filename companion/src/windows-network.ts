// Whether Windows will let a phone on this Wi-Fi reach the sidecar at all.
//
// Windows Defender Firewall drops inbound connections on a network Windows
// calls Public unless a rule allows the program there, and Windows 11 calls a
// newly joined Wi-Fi Public. The per-user installer adds no rule, and the
// "allow access" prompt Windows shows when the sidecar first listens is easy
// to dismiss or to answer for Private networks only. Then every address a
// phone tries on a Public network times out, however right the address in the
// QR is. Changing the rule needs an administrator; this file only finds the
// Public network, so the Wi-Fi pairing panel can say what to change.
import { execFile } from "node:child_process";

/** One line per connected network: "<InterfaceAlias>\t<NetworkCategory>".
 * The alias is the adapter name `os.networkInterfaces()` reports ("Wi-Fi",
 * "Ethernet 2"); the category is Public, Private or DomainAuthenticated.
 * Output is UTF-8 so a localized alias survives the pipe. No quote
 * characters: the script travels as one argv entry, and Windows' quoting
 * rules then have nothing inside it to escape. */
const SCRIPT =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + [char]9 + $_.NetworkCategory }";

/** The adapters Windows has on a Public network, from the lines `SCRIPT`
 * prints. Anything unreadable is simply not Public: this only ever adds a
 * hint, so a wrong "no" costs nothing and a wrong "yes" would mislead. */
export function publicNetworkAliases(output: string): Set<string> {
  const aliases = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.lastIndexOf("\t");
    if (tab > 0 && line.slice(tab + 1).trim() === "Public") aliases.add(line.slice(0, tab));
  }
  return aliases;
}

const getNetConnectionProfile = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { timeout: 5_000, killSignal: "SIGKILL", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** How old an answer may be before the next read asks Windows again. Someone
 * who switches the network to Private sees the hint go within this long. */
const MAX_AGE_MS = 15_000;

/** A read that never waits: it returns the last answer and, when that is
 * stale, asks Windows again in the background. Asking is a PowerShell
 * process, so a state request must not block on it; the pairing panel polls
 * every second and picks the answer up on its next read. Off Windows it never
 * asks and the set stays empty. */
export function createPublicNetworkCheck({
  platform = process.platform,
  run = getNetConnectionProfile,
  now = Date.now,
  maxAgeMs = MAX_AGE_MS,
}: {
  platform?: NodeJS.Platform;
  run?: () => Promise<string>;
  now?: () => number;
  maxAgeMs?: number;
} = {}): () => ReadonlySet<string> {
  let known: ReadonlySet<string> = new Set();
  let checkedAt = Number.NEGATIVE_INFINITY;
  let asking = false;
  return () => {
    if (platform !== "win32" || asking || now() - checkedAt < maxAgeMs) return known;
    asking = true;
    run()
      .then(
        (output) => { known = publicNetworkAliases(output); },
        () => { known = new Set(); },
      )
      .finally(() => {
        checkedAt = now();
        asking = false;
      });
    return known;
  };
}

/** The sidecar's one check, read by `companionState`. */
export const publicNetworks = createPublicNetworkCheck();
