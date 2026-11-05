// The `openconnector` MCP server entry the Apps card manages: the address of the OpenConnector single-file server
// on this computer (or one the person runs themselves). OpenConnector takes no credentials; an address that carries
// any is refused so a key never sits in config.
import { OPENCONNECTOR_DEFAULT_URL } from "../../shared/openconnector.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type OpenConnectorAddress = { ok: true; address: string } | { ok: false; error: string };

/** The host of an address, as the card shows it. */
export function openConnectorHost(address: string): string {
  try { return new URL(address.trim()).host; } catch { return address.trim(); }
}

export function isLoopbackAddress(address: string): boolean {
  try { return LOOPBACK.has(new URL(address).hostname); } catch { return false; }
}

/** https anywhere, plain http only to this computer (and never on a Cloud, whose own loopback is not the person's).
 * A managed connection must point at this computer: OpenMausBot only ever starts the process here. No user name,
 * password, query or hash, and nothing that looks like a key after the endpoint path. */
export function openConnectorAddress(input: string | null | undefined, options: { loopback: boolean; managed: boolean }): OpenConnectorAddress {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, address: OPENCONNECTOR_DEFAULT_URL };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Enter OpenConnector's address, starting with http:// or https://." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Enter OpenConnector's address, starting with http:// or https://." };
  }
  if (url.username || url.password) return { ok: false, error: "Leave any user name or password out of the OpenConnector address." };
  if (url.search || url.hash) return { ok: false, error: "Enter the OpenConnector address without anything after ? or #." };
  if (url.protocol === "http:" && !(options.loopback && LOOPBACK.has(url.hostname))) {
    return { ok: false, error: options.loopback
      ? "Use an https:// address. Plain http:// works only for OpenConnector on this computer."
      : "Use your OpenConnector server's https:// address." };
  }
  if (options.managed && !LOOPBACK.has(url.hostname)) {
    return { ok: false, error: "When OpenMausBot runs OpenConnector for you, its address must be on this computer (127.0.0.1)." };
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (/\/(?:mcp|sse)\/[^/]+$/u.test(path)) {
    return { ok: false, error: "That address has a key in it. OpenConnector takes no key — enter the server address alone." };
  }
  return { ok: true, address: `${url.origin}${path}` };
}
