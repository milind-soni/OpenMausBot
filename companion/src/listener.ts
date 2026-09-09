// Where this computer can be reached, and what it is called there.
//
// The addresses a phone might dial, the tailnet one told apart from the rest,
// and the MagicDNS name read out of the Tailscale CLI. Nothing here binds
// anything: the sidecar owns its own sockets in index.ts, and this file only
// answers the question the pairing page has to print.
//
// It used to hold a `RemoteListener` as well — the socket the harness opened
// for a phone back when the companion lived inside it. Moving out made it a
// class with no callers, and a second implementation of a socket lifecycle
// nobody runs is a thing that rots. index.ts owns the listeners now.
import { execFile } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";

/** Interfaces that exist to tunnel, bridge or mesh traffic — utun (Tailscale
 * and every other VPN), vmnet/bridge (VMs, containers, internet sharing),
 * awdl/llw (AirDrop's side channels), feth/tap/tun. Their addresses stay in
 * the list, because the tailnet one is exactly what a phone off-network
 * dials — but a phone on the same wifi can reach none of them, so none of
 * them may come first. */
const VIRTUAL_INTERFACES = /^(utun|tun|tap|bridge|vmnet|awdl|llw|feth)/;

/** Lower sorts earlier. `en0`, `en1`, … are macOS's built-in wifi and
 * ethernet — the networks a phone is actually standing on. */
const interfaceRank = (name: string): number => {
  if (/^en\d+$/.test(name)) return 0;
  if (VIRTUAL_INTERFACES.test(name)) return 2;
  return 1;
};

/** Every IPv4 address a phone on the same network could dial, most reachable
 * first. Link-local (169.254/16) is dropped: it means DHCP failed and nothing
 * will reach us.
 *
 * Ranked, not merely collected: `networkInterfaces()` promises nothing about
 * order, callers put the first non-tailnet entry into the pairing QR, and on
 * a Mac with a VPN or a VM running the first entry can be a utun or bridge100
 * address the phone cannot route to. Real interfaces lead, tunnels and
 * bridges trail; the sort is stable, so enumeration order still breaks ties.
 * The parameter exists for tests — the interface table is the machine's. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const found: Array<{ rank: number; address: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      found.push({ rank: interfaceRank(name), address: entry.address });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((entry) => entry.address);
}

/** Tailscale hands its nodes an address in 100.64.0.0/10 — the CGNAT range
 * RFC 6598 set aside, which is why it never collides with a home network.
 *
 * Worth telling apart from a LAN address because it behaves completely
 * differently: it does not change when you join another wifi, it works from
 * anywhere the tailnet reaches, and it survives the guest network that
 * isolates its clients. For a companion it is the *better* address, and the
 * only one that keeps working when you leave the house. */
export function tailscaleAddress(addresses: string[] = lanAddresses()): string | null {
  for (const address of addresses) {
    const [first, second] = address.split(".").map(Number);
    if (first === 100 && second >= 64 && second <= 127) return address;
  }
  return null;
}

/** The machine's MagicDNS name, e.g. `macbook.tail1234.ts.net`.
 *
 * Worth having as well as the address, because a phone reaching a tailnet
 * over plain HTTP is on the wrong side of App Transport Security: iOS
 * exempts local networking, and 100.64/10 is CGNAT shared space rather than
 * one of the private ranges that exemption covers. A `ts.net` hostname can
 * be exempted by name, which an address cannot.
 *
 * Read when the listener comes up and cached — asking Tailscale is a
 * subprocess, so normal state reads stay cheap. An explicit setup action can
 * refresh this cache when Tailscale changes later. */
let cachedTailnetName: string | null = null;
let activeTailnetRefresh: Promise<void> | null = null;

/** The cached MagicDNS name, or null until `refreshTailnetName` finds one. */
export function tailnetName(): string | null {
  return cachedTailnetName;
}

/** Every place the Tailscale CLI is plausibly installed, best first. */
export function tailscaleCandidates(home = homedir()): string[] {
  // Absolute paths first, PATH last: a process the desktop app forks inherits
  // whatever PATH the app was launched with, and an app opened from Finder
  // gets /usr/bin:/bin:/usr/sbin:/sbin — no Homebrew, no /usr/local. Relying
  // on the lookup alone works in a terminal and fails in the real app, which
  // is exactly the way round that is hardest to notice.
  return [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    join(home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"),
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/run/current-system/sw/bin/tailscale",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
    "tailscale",
  ];
}

/** How long the whole CLI hunt may take, across every candidate path. */
const TAILSCALE_BUDGET_MS = 5000;

/** PATH with the usual package-manager locations added back, for the bare
 * `tailscale` attempt. Costs nothing when PATH was already complete. */
export const searchPath = (): string =>
  [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(delimiter);

/** Ask the Tailscale CLI where it thinks we are.
 *
 * Every failure is survivable — not installed, not logged in, not running all
 * just mean "no name", and the address still works. But *silently* survivable
 * was the wrong call: a panel that says "turn on MagicDNS" to somebody who
 * has MagicDNS on is worse than no message, and there was no way to tell
 * which of these paths had been tried. `onAttempt` is how the caller can say.
 */
async function refreshTailnetNameOnce(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
  // A budget for the whole loop, not per probe. Seven candidates at five
  // seconds each is thirty-five seconds of startup in the case where several
  // hang — and they hang together, since the reason is usually the same one.
  // Nothing here is load-bearing: the address works without a name.
  const deadline = Date.now() + TAILSCALE_BUDGET_MS;
  for (const cli of tailscaleCandidates()) {
    const left = deadline - Date.now();
    if (left <= 0) {
      onAttempt?.(cli, "skipped — out of time looking for the Tailscale CLI");
      continue;
    }
    const name = await new Promise<string | null>((resolve) => {
      execFile(
        cli,
        ["status", "--json"],
        {
          timeout: Math.max(250, left),
          // SIGTERM is a request, and the budget above is only worth as much
          // as the thing that enforces it: a wedged CLI that ignores the
          // polite signal would sit there past the deadline it was supposed
          // to be bounded by. SIGKILL is not a request.
          killSignal: "SIGKILL",
          // `status --json` describes every peer in the tailnet, and the
          // default cap is 1 MiB — a large enough tailnet fails the probe with
          // ENOBUFS, which the code below reads as "no MagicDNS name" and
          // which looks from outside exactly like "Tailscale is not
          // installed". That is a wrong answer rather than a missing one.
          // Generous, and still a bound: the alternative is a subprocess
          // deciding how much memory this process uses.
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PATH: searchPath() },
        },
        (error, stdout) => {
          if (error) {
            onAttempt?.(cli, error.message.split("\n")[0]);
            return resolve(null);
          }
          try {
            const dns = JSON.parse(stdout)?.Self?.DNSName;
            // MagicDNS names are fully qualified, trailing dot and all
            const trimmed = typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null;
            onAttempt?.(cli, trimmed ? `ok: ${trimmed}` : "ran, but no MagicDNS name in status");
            resolve(trimmed);
          } catch {
            onAttempt?.(cli, "ran, but its output was not JSON");
            resolve(null);
          }
        },
      );
    });
    if (name) {
      cachedTailnetName = name;
      return;
    }
  }
  cachedTailnetName = null;
}

/** Coalesce startup and user-triggered probes so a slower failure cannot
 * overwrite a successful MagicDNS result from another concurrent probe. */
export function refreshTailnetName(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
  if (activeTailnetRefresh) return activeTailnetRefresh;
  let refresh: Promise<void>;
  refresh = refreshTailnetNameOnce(onAttempt).finally(() => {
    if (activeTailnetRefresh === refresh) activeTailnetRefresh = null;
  });
  activeTailnetRefresh = refresh;
  return refresh;
}
