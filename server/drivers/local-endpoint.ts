// Whether an endpoint is on this machine or this network — the only case
// in which the owned runtime may run without an API key.
//
// A remote endpoint with no key would send every prompt to a host the user
// never authenticated with. A local one is the user's own llama.cpp, vLLM,
// LM Studio, or Ollama, which commonly need none. The distinction is made
// on the URL's host, never on a header or a probe.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isPrivateV4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}

function isPrivateV6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
}

export function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOOPBACK.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  return isPrivateV4(host) || isPrivateV6(host);
}
