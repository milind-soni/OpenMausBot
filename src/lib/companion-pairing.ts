interface CompanionPairingLinkOptions {
  address: string;
  port: number;
  code: string;
  token: string;
  name?: string;
  /** Every host the phone could dial later, best first. Carried alongside
   * `address` so the app can fall back when the paired host stops resolving
   * — a tailnet name is unreachable the moment the phone leaves the tailnet,
   * while the LAN address keeps working. Older mobile builds ignore it. */
  hosts?: string[];
}

/** How many fallback hosts a link will carry. The list is tiny in practice
 * (tailnet name, a LAN address or two, the mDNS name); the cap only keeps a
 * pathological interface list from bloating the QR code. */
const MAX_HOSTS = 8;

/**
 * A short-lived handoff from the trusted desktop pairing panel to the mobile
 * app. The code still has to be redeemed with the companion; putting it in
 * the link does not create or expose the long-lived device token.
 */
export function companionPairingLink({ address, port, code, token, name, hosts }: CompanionPairingLinkOptions): string | null {
  const host = address.trim();
  if (
    !host ||
    !/^\d{6}$/.test(code) ||
    !/^omb_pair_[A-Za-z0-9_-]{43}$/.test(token) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    return null;
  const dialableHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  const url = new URL("openmausbot://pair");
  url.searchParams.set("address", `${dialableHost}:${port}`);
  // The scanner uses the high-entropy token. The code remains in the link so
  // an older mobile build can still pair during a staggered desktop rollout.
  url.searchParams.set("token", token);
  url.searchParams.set("code", code);
  if (name?.trim()) url.searchParams.set("name", name.trim());
  // Comma-joined, which no hostname or IP literal can contain. Filtered
  // rather than refused: a bad candidate costs the phone one failed dial,
  // and dropping the whole link over it would break pairing entirely.
  const candidates = (hosts ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && !/[\s/?#,[\]]/.test(candidate))
    .slice(0, MAX_HOSTS);
  if (candidates.length) url.searchParams.set("hosts", candidates.join(","));
  return url.toString();
}
