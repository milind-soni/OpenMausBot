// What the Browser panel's address bar opens for what a person typed: an
// address, or else a web search. Ported from t3code's resolveAddressBarInput
// (packages/shared/src/preview.ts, MIT, Copyright (c) 2026 T3 Tools Inc.).

const SEARCH_URL = "https://duckduckgo.com/?q=";
/** A bare host that is always an address: localhost, an IPv4 literal, or a bracketed IPv6 one. */
const ADDRESS_HOST = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
const BARE_HOST_PORT = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
/** A dev server on this machine speaks http, not https. */
const LOOPBACK_PREFIX = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;
/** Registered schemes that are never a bare host, so `tel:5551234` is not read as host and port. */
const NON_WEB_SCHEMES: ReadonlySet<string> = new Set([
  "about:", "blob:", "chrome:", "data:", "file:", "ftp:", "javascript:", "mailto:", "sms:", "ssh:", "tel:", "view-source:", "ws:", "wss:",
]);

function schemeOf(text: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(text)?.[1]?.toLowerCase().concat(":");
}

/** An http(s) URL for `text`, or null when it is not one. */
function webUrl(text: string): string | null {
  const candidate = text.includes("://") ? text : `${LOOPBACK_PREFIX.test(text) ? "http" : "https"}://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The URL to open for what was typed, or null for nothing typed or a scheme
 * the browser panel does not open (`ftp://`, `mailto:`). Text is an address
 * when it has a scheme, or no spaces and a host with a dot, a port, or that is
 * localhost or an IP; anything else is searched for. So "google" searches
 * rather than opening https://google/, which does not exist. */
export function resolveAddressBarInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return webUrl(text);
  if (!/\s/.test(text)) {
    const scheme = schemeOf(text);
    if (scheme !== undefined && (NON_WEB_SCHEMES.has(scheme) || !BARE_HOST_PORT.test(text))) {
      return scheme === "http:" || scheme === "https:" ? webUrl(text) : null;
    }
    const authority = (text.split(/[/?#]/, 1)[0] ?? "").replace(/^[^@]*@/, "");
    const host = authority.replace(/:\d+$/, "");
    const hasPort = host.length < authority.length;
    if (hasPort || ADDRESS_HOST.test(host) || /^[^.]+(?:\.[^.]+)+\.?$/.test(host)) {
      const url = webUrl(text);
      if (url) return url;
    }
  }
  return `${SEARCH_URL}${encodeURIComponent(text)}`;
}
