/** A host only this machine or its own network reaches: loopback, RFC 1918, CGNAT 100.64/10 (Tailscale), link-local,
 * IPv6 unique-local (fc00::/7), `*.ts.net`, `*.local` and single-label names. Plain http to one of these stays on a
 * network the person runs; anything else is the open internet. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((part) => Number(part) > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) {
    return host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".ts.net") || host.endsWith(".local")) return true;
  return !host.includes(".") && /^[a-z0-9-]+$/.test(host);
}
