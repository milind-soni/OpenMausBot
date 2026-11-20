// What a person types or pastes to reach a MausBot server: a pairing link, an address, an address and a code typed
// apart, or a code on its own. One reader for the desktop's Connect sheet, `openmausbot connect` and the MCP bridge.
import { isTailnetHost, isTailnetName } from "./tailnet.mjs";

export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;
const PAIRING_CREDENTIAL = /^omb_pair_[A-Za-z0-9_-]{43}$/;
/** The port `openmausbot serve` and the desktop app listen on. */
export const DEFAULT_PORT = 8799;
export const EXAMPLE_ADDRESS = `http://192.168.1.20:${DEFAULT_PORT}`;

const bareHost = (host) => String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

function ipv4(host) {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  return octets.some((octet) => octet > 255) ? null : octets;
}

export function isLoopbackHost(host) {
  const name = bareHost(host);
  const v4 = ipv4(name);
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" || (v4 !== null && v4[0] === 127);
}

/**
 * A host only this machine or a network the person runs can reach: loopback, RFC 1918, CGNAT 100.64/10 (Tailscale),
 * link-local, IPv6 unique-local, `*.ts.net`, `*.local`, `*.home.arpa` and single-label names. Plain http stays on
 * such a network; any other host is the open internet, where http would carry the session in clear.
 */
export function isPrivateHost(host) {
  const name = bareHost(host);
  if (!name) return false;
  const v4 = ipv4(name);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (/^\d+(\.\d+){0,3}$/.test(name)) return false;
  if (name.includes(":")) return name === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
  if (isLoopbackHost(name) || [".ts.net", ".local", ".home.arpa"].some((suffix) => name.endsWith(suffix))) return true;
  return !name.includes(".") && /^[a-z0-9-]+$/.test(name);
}

/** How a saved server is reached, for the line under its name. A MagicDNS name is Tailscale over http too: WireGuard
 * encrypts it. A bare 100.64/10 address may be carrier NAT or another VPN, so it is only a private address. */
export function serverTransport(origin) {
  const url = new URL(origin);
  if (isTailnetName(bareHost(url.hostname))) return "tailscale";
  if (url.protocol === "https:") return "https";
  return isLoopbackHost(url.hostname) ? "loopback" : "private-http";
}

/** An origin a client may talk to: https anywhere, http only on a private network. Everything else is refused. */
export function allowedServerOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isPrivateHost(url.hostname));
  } catch {
    return false;
  }
}

/**
 * Saved servers reached over plain http on a private network. Chromium treats their pages as insecure and hides the
 * microphone (navigator.mediaDevices) from them, so a Live call there could not start; the desktop app vouches for
 * these origins at launch. Loopback is already secure, and an http address on the open internet is never vouched for.
 */
export function plainHttpServerOrigins(environments) {
  const origins = new Set();
  for (const env of environments ?? []) {
    if (typeof env?.origin !== "string" || !allowedServerOrigin(env.origin)) continue;
    const url = new URL(env.origin);
    // Chromium splits the switch on commas: a host holding one would vouch for a different, public host too.
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !url.hostname.includes(",")) origins.add(url.origin);
  }
  return [...origins];
}

const INSECURE_AS_SECURE = "unsafely-treat-insecure-origin-as-secure";

/** Vouches for plainHttpServerOrigins, keeping any origin already given on the command line. Chromium reads the switch
 * only at launch (Electron 43), so a server saved later counts from the next start. */
export function vouchForPlainHttpServers(commandLine, environments) {
  const origins = plainHttpServerOrigins(environments);
  if (origins.length === 0) return;
  commandLine.appendSwitch(INSECURE_AS_SECURE, [commandLine.getSwitchValue(INSECURE_AS_SECURE), ...origins].filter(Boolean).join(","));
}

export function normalizePairingCode(input) {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "I");
}

export function formatPairingCode(code) {
  return normalizePairingCode(code).match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * A pairing code as typed: `{ kind: "code", code }` (formatted XXXX-XXXX-XXXX), the high-entropy credential a QR may
 * carry, nothing, or the wrong kind of secret with what it is: an emailed sign-in code (8 digits), a code from an older
 * MausBot (6 digits), a script key (`omb_sess_…`), or not a code at all.
 */
export function readPairingCode(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "empty" };
  if (value.startsWith("omb_sess_")) return { kind: "wrong", problem: "scriptKey" };
  if (value.startsWith("omb_pair_")) return PAIRING_CREDENTIAL.test(value) ? { kind: "credential", credential: value } : { kind: "wrong", problem: "notACode" };
  const digits = value.replace(/[\s-]/g, "");
  if (/^\d{8}$/.test(digits)) return { kind: "wrong", problem: "emailCode" };
  if (/^\d{6}$/.test(digits)) return { kind: "wrong", problem: "oldCode" };
  const code = normalizePairingCode(value);
  if (code.length !== PAIRING_CODE_LENGTH || [...code].some((symbol) => !PAIRING_CODE_ALPHABET.includes(symbol))) return { kind: "wrong", problem: "notACode" };
  return { kind: "code", code: formatPairingCode(code) };
}

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** `{ address, secret }` from an `openmausbot://pair` link; only one naming a server's own http(s) origin. */
function appLink(url) {
  const address = url.searchParams.get("address") ?? "";
  if (!/^https?:\/\//i.test(address)) return null;
  return { address, secret: url.searchParams.get("code") ?? url.searchParams.get("token") };
}

function secretOf(url) {
  const fromHash = /(?:^|[#&])code=([^&]*)/.exec(url.hash)?.[1];
  if (fromHash !== undefined) return decoded(fromHash);
  return url.searchParams.get("code");
}

/**
 * Reads the Connect sheet's two fields (or `connect URL --code CODE`). On success: the origins to try in order (a bare
 * private address tries https, then http), and the code or QR credential when one was given. On failure: `problem`,
 * one of empty, codeOnly (with the `code` to move into the code field), emailCode, oldCode, scriptKey, notACode,
 * publicHttp (with `host`), phoneLink and notAnAddress.
 */
export function parseServerInput(addressInput, codeInput = "") {
  let text = String(addressInput ?? "").trim();
  if (!text) return { ok: false, problem: "empty" };
  const asCode = readPairingCode(text);
  if (asCode.kind === "code") return { ok: false, problem: "codeOnly", code: asCode.code };
  if (asCode.kind === "wrong" && asCode.problem !== "notACode") return { ok: false, problem: asCode.problem };
  if (/[\s\\]/.test(text)) return { ok: false, problem: "notAnAddress" };
  let secret = null;
  if (/^openmausbot:/i.test(text)) {
    let link;
    try {
      link = appLink(new URL(text));
    } catch {
      link = null;
    }
    if (!link) return { ok: false, problem: "phoneLink" };
    text = link.address;
    secret = link.secret;
  }
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(schemed ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: "notAnAddress" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return { ok: false, problem: "notAnAddress" };
  if (!["/", "", "/pair", "/pair/"].includes(url.pathname)) return { ok: false, problem: "notAnAddress" };
  const fromLink = secret ?? secretOf(url);
  const carried = url.hash || url.searchParams.has("code") || secret !== null;
  const typed = String(codeInput ?? "").trim();
  if (!typed && carried && !fromLink?.trim()) return { ok: false, problem: "notACode" };
  const read = readPairingCode(typed || fromLink || "");
  if (read.kind === "wrong") return { ok: false, problem: read.problem };
  const privateHost = isPrivateHost(url.hostname);
  if (url.protocol === "http:" && schemed && !privateHost) return { ok: false, problem: "publicHttp", host: url.host };
  const https = `https://${url.host}`, http = `http://${url.host}`;
  // A tailnet name typed alone may be a computer sharing itself on the tailnet, which listens on its own port.
  const shared = !schemed && !url.port && isTailnetHost(bareHost(url.hostname)) ? [`http://${url.host}:${DEFAULT_PORT}`] : [];
  const candidates = schemed ? [url.origin] : privateHost ? [https, http, ...shared] : [https];
  return {
    ok: true,
    candidates,
    code: read.kind === "code" ? read.code : null,
    credential: read.kind === "credential" ? read.credential : null,
  };
}

/** The page that finishes pairing on the server itself, with the code in the fragment so it never reaches a log. */
export function pairingPageUrl(origin, secret) {
  return secret ? `${origin}/pair#code=${encodeURIComponent(secret)}` : origin;
}
