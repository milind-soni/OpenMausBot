// The `postiz` MCP server entry the Apps card manages: Postiz Cloud's OAuth endpoint for a sign-in, or a Postiz server's
// key endpoint for an organisation API key. A saved key is sent only to the entry at the address it was saved for.
import { POSTIZ_CLOUD, POSTIZ_SERVER } from "../../shared/postiz.ts";
import type { StoredRemoteMcpServer } from "../mcp-registry.ts";

/** Postiz's MCP endpoint for clients that register themselves (RFC 7591) and sign in (Postiz 2.25: start.mcp.ts). */
const SIGN_IN_PATH = "/mcp-oauth-dynamic";
/** Postiz's MCP endpoint for an organisation API key sent as a bearer token. */
const KEY_PATH = "/mcp";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type PostizAddress = { ok: true; address: string } | { ok: false; error: string };

/** https anywhere, plain http only to this computer (and never on a Cloud, whose own loopback is not the person's).
 * A pasted MCP address is accepted for its server; one with the key in it is refused, so the key never sits in config. */
export function postizAddress(input: string | null | undefined, options: { loopback: boolean }): PostizAddress {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, address: postizCloud() };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Enter your Postiz server's address, starting with https://." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Enter your Postiz server's address, starting with https://." };
  if (url.username || url.password) return { ok: false, error: "Leave any user name or password out of the Postiz address." };
  if (url.search || url.hash) return { ok: false, error: "Enter the Postiz address without anything after ? or #." };
  if (url.protocol === "http:" && !(options.loopback && LOOPBACK.has(url.hostname))) {
    return { ok: false, error: options.loopback
      ? "Use an https:// address. Plain http:// works only for a Postiz server on this computer."
      : "Use your Postiz server's https:// address." };
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (/\/(?:mcp|sse)\/[^/]+$/u.test(path)) {
    return { ok: false, error: "That address has a key in it. Enter the server address alone, and paste the key in its own box." };
  }
  return { ok: true, address: `${url.origin}${path.replace(/\/mcp(?:-oauth(?:-[a-z]+)?)?$/u, "")}` };
}

/** Postiz Cloud, or the stand-in a test server was started with (https, or http on this computer). */
export function postizCloud(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMB_POSTIZ_CLOUD_URL?.trim();
  if (!override) return POSTIZ_CLOUD;
  try {
    const url = new URL(override);
    const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
    return allowed && !url.username && !url.password && !url.search && !url.hash ? `${url.origin}${url.pathname.replace(/\/+$/u, "")}` : POSTIZ_CLOUD;
  } catch {
    return POSTIZ_CLOUD;
  }
}

export const postizSignInUrl = () => `${postizCloud()}${SIGN_IN_PATH}`;
export const postizKeyUrl = (address: string) => `${address}${KEY_PATH}`;

/** The address a saved key belongs to. */
export function savedPostizAddress(postiz: { url?: string } | undefined): string {
  const saved = postizAddress(postiz?.url, { loopback: true });
  return saved.ok ? saved.address : postizCloud();
}

/** How the card set the entry up: Postiz Cloud's sign-in, the key endpoint at the saved address, or a key endpoint at
 * another address (the address changed and no key was saved for it yet). Null: a server named postiz it did not set up. */
export function postizEntryMethod(server: StoredRemoteMcpServer, postiz: { url?: string } | undefined): "sign-in" | "key" | "old-key" | null {
  if (server.type !== "http" || Object.values(server.headers).some((value) => value !== "") || server.oauth) return null;
  if (server.url === postizSignInUrl()) return "sign-in";
  if (server.url === postizKeyUrl(savedPostizAddress(postiz))) return "key";
  try {
    const url = new URL(server.url);
    return url.pathname.endsWith(KEY_PATH) && !url.search && !url.hash && !url.username && !url.password ? "old-key" : null;
  } catch {
    return null;
  }
}

/** The API key header for a turn's `postiz` server: only when it is the key endpoint the key was saved for. */
export function postizKeyHeaders(postiz: { key?: string; url?: string } | undefined, name: string, server: { url?: string }): Record<string, string> {
  const key = postiz?.key?.trim();
  if (name !== POSTIZ_SERVER || !key || server.url !== postizKeyUrl(savedPostizAddress(postiz))) return {};
  return { Authorization: `Bearer ${key}` };
}
