// What Tailscale says about this computer, and the exact names and addresses a share on the tailnet answers to. Runs
// nothing and imports nothing, so the window's bundle can read it too.

const TAILSCALE_V6 = /^fd7a:115c:a1e0:/i;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const TAILNET_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.ts\\.net$`);

/** An address as a socket reports it, without the IPv4-mapped prefix, zone or brackets. */
export const bareAddress = (address) => String(address ?? "").trim().replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d)/i, "").replace(/%.*$/, "").toLowerCase();

function ipv4(address) {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  return octets.some((octet) => octet > 255) ? null : octets;
}

/** Tailscale's own ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. 100.64/10 is RFC 6598 shared space that carrier NAT
 * and other VPNs use too, so on its own it never proves a tailnet. */
export function inTailscaleRange(address) {
  const value = bareAddress(address);
  const v4 = ipv4(value);
  if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
  return TAILSCALE_V6.test(value);
}

/** A MagicDNS name, like `macmini.tail1234.ts.net`; a trailing dot is allowed. */
export function isTailnetName(host) {
  return TAILNET_NAME.test(String(host ?? "").trim().toLowerCase().replace(/\.$/, ""));
}

/** A host only a tailnet reaches: a MagicDNS name or an address in Tailscale's ranges. */
export const isTailnetHost = (host) => isTailnetName(host) || inTailscaleRange(host);

/** Addresses on Tailscale's own interface: `tailscale0` on Linux, "Tailscale" on Windows, and on macOS the utun that
 * carries a fd7a:115c:a1e0::/48 address. IPv4 first. */
export function tailnetInterfaceAddresses(interfaces) {
  const found = [];
  for (const [name, entries = []] of Object.entries(interfaces ?? {})) {
    const list = entries ?? [];
    if (!/^tailscale/i.test(name) && !list.some((entry) => TAILSCALE_V6.test(entry?.address ?? ""))) continue;
    for (const entry of list) {
      const address = bareAddress(entry?.address);
      if (inTailscaleRange(address) && !found.includes(address)) found.push(address);
    }
  }
  return found.sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
}

export const onTailnet = (interfaces) => tailnetInterfaceAddresses(interfaces).length > 0;

/**
 * One `tailscale status --json`, read: `state` is "ready" (signed in and connected), "signed-out", "not-running" or
 * "needs-approval"; `name` this computer's MagicDNS name; `addresses` its tailnet addresses; `https` whether the tailnet
 * hands out certificates (`CertDomains`, or the `https` capability in `Self.CapMap`), without which `tailscale serve`
 * waits on an enablement link. Null when the text is not that JSON.
 */
export function readTailscaleStatusJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const self = parsed.Self && typeof parsed.Self === "object" ? parsed.Self : {};
  const dns = typeof self.DNSName === "string" ? self.DNSName.trim().toLowerCase().replace(/\.$/, "") : "";
  const backend = typeof parsed.BackendState === "string" ? parsed.BackendState : "";
  const state = backend === "Running" ? "ready" : backend === "NeedsMachineAuth" ? "needs-approval" : backend === "Stopped" || backend === "Starting" || backend === "NoState" ? "not-running" : "signed-out";
  const addresses = (Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []).map(bareAddress).filter(inTailscaleRange);
  const certDomains = Array.isArray(parsed.CertDomains) && parsed.CertDomains.some((domain) => typeof domain === "string" && domain);
  const capability = self.CapMap && typeof self.CapMap === "object" && Object.hasOwn(self.CapMap, "https");
  return { state, name: isTailnetName(dns) ? dns : null, addresses: addresses.sort((a, b) => Number(a.includes(":")) - Number(b.includes(":"))), https: Boolean(certDomains || capability) };
}

const authority = (host, port) => (host.includes(":") ? `[${host}]` : host) + (port ? `:${port}` : "");

/** The address another computer opens: `https://<name>` when `tailscale serve` fronts this one with HTTPS, else
 * `http://<name>:<port>` (inside WireGuard, so encrypted despite the http). */
export function tailnetOrigin(name, port, https = false) {
  if (https) return port && port !== 443 ? `https://${name}:${port}` : `https://${name}`;
  return `http://${authority(name, port)}`;
}

/**
 * Security: the only Host headers a listener on the tailnet answers, exactly: its MagicDNS name and the addresses it is
 * bound to, each with its port. A page that rebinds its own name to a tailnet address sends that name, so it is refused.
 */
export function tailnetHosts({ name, addresses = [], port }) {
  const hosts = new Set();
  if (isTailnetName(name)) {
    const bare = name.toLowerCase().replace(/\.$/, "");
    hosts.add(authority(bare, port));
  }
  for (const address of addresses) {
    const value = bareAddress(address);
    if (value) hosts.add(authority(value, port));
  }
  return hosts;
}
