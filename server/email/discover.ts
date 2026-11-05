// Where a mailbox's mail servers are, from its address alone, the way a mail program finds them: the domain's own
// autoconfig file, a few well-known hosts, Thunderbird's public list (by domain, then by the provider behind the domain's
// MX record), RFC 6186 SRV records, and last the usual names. Only a list of places to try: nothing here sees a password,
// and the client (client.ts) sends it only over TLS to a host whose certificate is valid for that name.
import { resolveMx, resolveSrv } from "node:dns/promises";

import type { EmailServer } from "./store.ts";

export interface MailCandidates {
  imap: EmailServer[];
  smtp: EmailServer[];
  /** A found list says which name signs in; none says, so both are tried. */
  username?: "address" | "localpart";
}

export interface DiscoverDeps {
  /** The text at an https address, or null. */
  fetchText(url: string): Promise<string | null>;
  mx(domain: string): Promise<string[]>;
  srv(name: string): Promise<Array<{ name: string; port: number }>>;
}

const IMAPS = 993, IMAP_STARTTLS = 143, SMTPS = 465, SUBMISSION = 587;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/u;
const FETCH_MS = 4_000;
const MAX_BODY = 256 * 1024;

const validHost = (host: string) => HOST.test(host);
/** The registrable part of an MX host, near enough: "mx3.mail.example.co.uk" is "example.co.uk". */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/u, "").split(".");
  const two = /^(?:co|com|net|org|ac|gv)\.[a-z]{2}$/u.test(parts.slice(-2).join("."));
  return parts.slice(two ? -3 : -2).join(".");
}

/** The places a well-known provider's mail is, by the address's domain or by the host of its MX record. */
const KNOWN: ReadonlyArray<{ domain?: RegExp; mx?: RegExp; imap: string; smtp: string }> = [
  { domain: /^(?:gmail|googlemail)\.com$/u, mx: /\.google(?:mail)?\.com$/u, imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  { domain: /^(?:outlook|hotmail|live|msn)\.[a-z.]+$/u, mx: /\.protection\.outlook\.com$/u, imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  { domain: /^(?:icloud|me|mac)\.com$/u, imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
  { domain: /^yahoo\.[a-z.]+$/u, mx: /\.yahoodns\.net$/u, imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  { domain: /^gmx\.[a-z.]+$/u, mx: /\.gmx\.net$/u, imap: "imap.gmx.net", smtp: "mail.gmx.net" },
  { domain: /^web\.de$/u, mx: /\.web\.de$/u, imap: "imap.web.de", smtp: "smtp.web.de" },
  { domain: /^t-online\.de$/u, imap: "secureimap.t-online.de", smtp: "securesmtp.t-online.de" },
  { mx: /(?:^|\.)world4you\.com$/u, imap: "imap.world4you.com", smtp: "smtp.world4you.com" },
  { mx: /(?:^|\.)(?:kundenserver\.de|ionos\.[a-z.]+)$/u, imap: "imap.ionos.de", smtp: "smtp.ionos.de" },
  { mx: /(?:^|\.)strato\.de$/u, imap: "imap.strato.de", smtp: "smtp.strato.de" },
  { mx: /(?:^|\.)zoho\.[a-z.]+$/u, imap: "imap.zoho.com", smtp: "smtp.zoho.com" },
  { mx: /(?:^|\.)(?:fastmail\.com|messagingengine\.com)$/u, imap: "imap.fastmail.com", smtp: "smtp.fastmail.com" },
];

const imapOn = (host: string): EmailServer[] => [{ host, port: IMAPS, secure: true }, { host, port: IMAP_STARTTLS, secure: false }];
const smtpOn = (host: string): EmailServer[] => [{ host, port: SUBMISSION, secure: false }, { host, port: SMTPS, secure: true }];

/** The servers in a Mozilla autoconfig file (config-v1.1.xml), TLS only, with `%EMAILDOMAIN%` filled in. */
export function parseAutoconfig(xml: string, domain: string): MailCandidates {
  const out: MailCandidates = { imap: [], smtp: [] };
  const tag = (block: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "iu").exec(block)?.[1] ?? "";
  for (const [, kind, type, block] of xml.matchAll(/<(incomingServer|outgoingServer)\s+type="(\w+)"\s*>([\s\S]*?)<\/\1>/giu)) {
    const wanted = kind!.toLowerCase() === "incomingserver" ? type!.toLowerCase() === "imap" : type!.toLowerCase() === "smtp";
    if (!wanted) continue;
    const host = tag(block!, "hostname").replaceAll("%EMAILDOMAIN%", domain).toLowerCase();
    const port = Number(tag(block!, "port"));
    const socket = tag(block!, "socketType").toUpperCase();
    if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65_535 || (socket !== "SSL" && socket !== "STARTTLS")) continue;
    (kind!.toLowerCase() === "incomingserver" ? out.imap : out.smtp).push({ host, port, secure: socket === "SSL" });
    const user = tag(block!, "username");
    if (!out.username && user === "%EMAILADDRESS%") out.username = "address";
    if (!out.username && user === "%EMAILLOCALPART%") out.username = "localpart";
  }
  return out;
}

export const liveDiscoverDeps = (allowed: (url: URL) => Promise<boolean>): DiscoverDeps => ({
  async fetchText(address) {
    const url = new URL(address);
    if (url.protocol !== "https:" || !await allowed(url).catch(() => false)) return null;
    try {
      const answer = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_MS), headers: { accept: "text/xml,application/xml" } });
      if (!answer.ok) return null;
      const text = await answer.text();
      return text.length > MAX_BODY ? null : text;
    } catch { return null; }
  },
  mx: async (domain) => (await resolveMx(domain).catch(() => [])).sort((a, b) => a.priority - b.priority).map((record) => record.exchange.toLowerCase()),
  srv: async (name) => (await resolveSrv(name).catch(() => [])).sort((a, b) => a.priority - b.priority).map((record) => ({ name: record.name.toLowerCase(), port: record.port })),
});

/** Every place to try for this address, likeliest first, each once. */
export async function discoverMailServers(address: string, deps: DiscoverDeps): Promise<MailCandidates> {
  const domain = address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
  const out: MailCandidates = { imap: [], smtp: [] };
  const add = (found: Partial<MailCandidates>) => {
    const fresh = (list: EmailServer[], more: EmailServer[] = []) => list.push(...more.filter((server) => !list.some((seen) => seen.host === server.host && seen.port === server.port)));
    fresh(out.imap, found.imap);
    fresh(out.smtp, found.smtp);
    out.username ??= found.username;
  };
  if (!validHost(domain)) return out;
  const autoconfig = async (url: string) => {
    const xml = await deps.fetchText(url);
    return xml ? parseAutoconfig(xml, domain) : { imap: [], smtp: [] };
  };
  const list = (name: string) => autoconfig(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(name)}`);
  const [own, wellKnown, listed, mx, imaps, submission] = await Promise.all([
    autoconfig(`https://autoconfig.${domain}/mail/config-v1.1.xml`),
    autoconfig(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`),
    list(domain),
    deps.mx(domain),
    deps.srv(`_imaps._tcp.${domain}`),
    deps.srv(`_submission._tcp.${domain}`),
  ]);
  add(own); add(wellKnown);
  const known = KNOWN.filter((entry) => entry.domain?.test(domain) || mx.some((host) => entry.mx?.test(host.replace(/\.$/u, ""))));
  for (const entry of known) add({ imap: imapOn(entry.imap), smtp: smtpOn(entry.smtp) });
  add(listed);
  const providers = [...new Set(mx.map(baseDomain))].filter((base) => base !== domain && validHost(base)).slice(0, 2);
  if (!known.length) for (const found of await Promise.all(providers.map(list))) add(found);
  add({ imap: imaps.filter((record) => validHost(record.name)).map((record) => ({ host: record.name, port: record.port, secure: true })),
    smtp: submission.filter((record) => validHost(record.name)).map((record) => ({ host: record.name, port: record.port, secure: false })) });
  const guesses = [`imap.${domain}`, `mail.${domain}`, ...mx.slice(0, 1).filter(validHost), ...providers.flatMap((base) => [`imap.${base}`, `mail.${base}`])];
  add({ imap: guesses.flatMap(imapOn), smtp: [`smtp.${domain}`, `mail.${domain}`, ...providers.flatMap((base) => [`smtp.${base}`, `mail.${base}`]), ...mx.slice(0, 1).filter(validHost)].flatMap(smtpOn) });
  return out;
}
