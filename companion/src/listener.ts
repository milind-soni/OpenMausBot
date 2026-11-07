// Where this computer can be reached and what it is called there. Binds nothing.
import { execFile } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";

/** Interfaces that tunnel, bridge, virtualize or mesh. Their addresses stay
 * listed (the tailnet one is what an off-network phone dials, and a Hyper-V
 * external switch moves the PC's real address onto "vEthernet (…)") but never
 * first. Matched by name, case-insensitively, because that is all Node reports:
 * - macOS: utun (every VPN, Tailscale), bridge/vmnet (VMs, internet
 *   sharing), awdl/llw (AirDrop), feth, anpi.
 * - Linux: docker0, br-<id> (Docker networks), veth, virbr (libvirt),
 *   vboxnet, cni/flannel/lxc/lxd, tun/tap, wg, zt (ZeroTier), tailscale0.
 * - Windows names adapters rather than numbering them: "vEthernet (WSL)",
 *   "vEthernet (Default Switch)", "VirtualBox Host-Only Network", "VMware
 *   Network Adapter VMnet8", "Tailscale", "ZeroTier One", anything with VPN
 *   or Bluetooth in its name. */
const VIRTUAL_INTERFACE =
  /^(utun|tun|tap|bridge|br-|vmnet|vboxnet|virbr|veth|docker|cni|flannel|lxc|lxd|zt|wg|tailscale|awdl|llw|feth|anpi)|vethernet|virtual|vmware|hyper-v|wsl|zerotier|vpn|loopback|bluetooth/i;

/** The networks a phone is actually standing on: macOS en0/en1, Linux
 * eth0/enp3s0/eno1/wlan0/wlp2s0, Windows "Wi-Fi", "Ethernet 2", and the
 * German/Chinese "WLAN". */
const PHYSICAL_INTERFACE = /^(en|eth|wl)[a-z0-9]*$|^(wi-?fi|wlan|ethernet)\b/i;

/** Lower sorts earlier: physical, then unrecognized (a localized Windows name,
 * a hotspot), then virtual. Virtual is checked first so "vEthernet" is never
 * mistaken for "Ethernet". */
const interfaceRank = (name: string): number => {
  if (VIRTUAL_INTERFACE.test(name)) return 2;
  if (PHYSICAL_INTERFACE.test(name)) return 0;
  return 1;
};

/** Link-local (169.254/16) is dropped: DHCP failed. Ranked because
 * `networkInterfaces()` promises no order and callers put the first
 * non-tailnet entry into the pairing QR; the sort is stable. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  return lanInterfaces(interfaces).map((entry) => entry.address);
}

/** The name is what Windows calls the adapter ("Wi-Fi"), used to ask whether
 * Windows has that network down as Public. */
export function lanInterfaces(interfaces = networkInterfaces()): Array<{ name: string; address: string }> {
  const found: Array<{ rank: number; name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      found.push({ rank: interfaceRank(name), name, address: entry.address });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map(({ name, address }) => ({ name, address }));
}

/** Tailscale addresses are in 100.64.0.0/10, the CGNAT range RFC 6598 set
 * aside; unlike a LAN address it keeps working away from home. */
export function tailscaleAddress(addresses: string[] = lanAddresses()): string | null {
  for (const address of addresses) {
    const [first, second] = address.split(".").map(Number);
    if (first === 100 && second >= 64 && second <= 127) return address;
  }
  return null;
}

/** e.g. `macbook.tail1234.ts.net`. Plain HTTP to a tailnet address hits App
 * Transport Security: iOS exempts local networking, but 100.64/10 is CGNAT
 * shared space, not one of the private ranges that exemption covers. A
 * `ts.net` hostname can be exempted by name. Cached: asking is a subprocess. */
let cachedTailnetName: string | null = null;
let activeTailnetRefresh: Promise<void> | null = null;

export function tailnetName(): string | null {
  return cachedTailnetName;
}

export function tailscaleCandidates(home = homedir()): string[] {
  // Absolute paths first: an app opened from Finder gets
  // /usr/bin:/bin:/usr/sbin:/sbin, no Homebrew and no /usr/local.
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

/** For the whole CLI hunt, across every candidate path. */
const TAILSCALE_BUDGET_MS = 5000;

export const searchPath = (): string =>
  [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(delimiter);

/** The macOS app executable chooses GUI or CLI mode from its environment.
 * Finder-launched sidecars have no shell hints, so explicitly request the CLI.
 * https://tailscale.com/docs/reference/tailscale-cli?tab=macos */
export const tailscaleEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: searchPath(),
  TAILSCALE_BE_CLI: "1",
});

/** Every failure just means "no name"; `onAttempt` reports which paths were
 * tried, so "turn on MagicDNS" is not said to someone who has it on. */
async function refreshTailnetNameOnce(
  onAttempt?: (cli: string, outcome: string) => void,
): Promise<void> {
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
          // A wedged CLI may ignore SIGTERM past the deadline.
          killSignal: "SIGKILL",
          // `status --json` lists every peer; the default 1 MiB cap fails a
          // large tailnet with ENOBUFS, which would read as "not installed".
          maxBuffer: 16 * 1024 * 1024,
          env: tailscaleEnvironment(),
          windowsHide: true,
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
            onAttempt?.(cli, /Tailscale GUI failed to start/i.test(stdout)
              ? "exited successfully in GUI mode instead of CLI mode"
              : "exited successfully, but status output was not JSON");
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
