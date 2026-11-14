// Where a mailbox's mail servers are, from its address alone, the way a mail program finds them: the domain's own
// autoconfig file, a few well-known hosts, Thunderbird's public list (by domain, then by the provider behind the domain's
// MX record), RFC 6186 SRV records, and last the usual names. A domain hosted under its own names (mail.<domain> on the
// provider's address, imap.<domain> an alias of the provider's server) is known by the names behind them: the aliases'
// targets and the MX address's reverse name. Only a list of places to try: nothing here sees a password, and the client
// (client.ts) sends it only over TLS to a host whose certificate is valid for that name.
import { resolve4, resolveCname, resolveMx, resolveSrv, reverse } from "node:dns/promises";

import type { EmailSignInHint } from "../../shared/email.ts";
import type { EmailServer } from "./store.ts";

export interface MailCandidates {
  imap: EmailServer[];
  smtp: EmailServer[];
  /** A found list says which name signs in; none says, so both are tried. */
  username?: "address" | "localpart";
  /** A provider whose sign-in needs more than the mailbox password. */
  provider?: PasswordRule;
}

/** `app-password`: an app password from the account's security settings; `no-password`: no password sign-in at all. */
export type PasswordRule = { rule: "app-password" | "no-password"; hint: EmailSignInHint };

export interface DiscoverDeps {
  /** The text at an https address, or null. */
  fetchText(url: string): Promise<string | null>;
  mx(domain: string): Promise<string[]>;
  srv(name: string): Promise<Array<{ name: string; port: number }>>;
  /** What a name is an alias (CNAME) of, if it is one. */
  cname(name: string): Promise<string[]>;
  /** The reverse (PTR) names of a host's addresses. */
  reverse(host: string): Promise<string[]>;
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

/** The places a well-known provider's mail is, by the address's domain or by a host of the provider behind it (its MX
 * record, an alias's target, the MX address's reverse name). `smtps`: its own help pages give TLS on 465 first. */
const KNOWN: ReadonlyArray<{ domain?: RegExp; host?: RegExp; imap: string; smtp: string; smtps?: true; provider?: PasswordRule }> = [
  { domain: /^(?:gmail|googlemail)\.com$/u, host: /\.google(?:mail)?\.com$/u, imap: "imap.gmail.com", smtp: "smtp.gmail.com",
    provider: { rule: "app-password", hint: { provider: "Google", app: "gmail", appPasswordUrl: "https://myaccount.google.com/apppasswords" } } },
  // Exchange Online has no password sign-in for reading, and turns it off for sending (by default from December 2026).
  { domain: /^(?:outlook|hotmail|live|msn)\.[a-z.]+$/u, host: /\.protection\.outlook\.com$/u, imap: "outlook.office365.com", smtp: "smtp.office365.com",
    provider: { rule: "no-password", hint: { provider: "Microsoft", app: "outlook" } } },
  { domain: /^(?:icloud|me|mac)\.com$/u, imap: "imap.mail.me.com", smtp: "smtp.mail.me.com",
    provider: { rule: "app-password", hint: { provider: "Apple", appPasswordUrl: "https://account.apple.com/account/manage" } } },
  { domain: /^yahoo\.[a-z.]+$/u, host: /\.yahoodns\.net$/u, imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com",
    provider: { rule: "app-password", hint: { provider: "Yahoo", appPasswordUrl: "https://login.yahoo.com/account/security" } } },
  { domain: /^gmx\.[a-z.]+$/u, host: /\.gmx\.net$/u, imap: "imap.gmx.net", smtp: "mail.gmx.net" },
  { domain: /^web\.de$/u, host: /\.web\.de$/u, imap: "imap.web.de", smtp: "smtp.web.de" },
  { domain: /^t-online\.de$/u, imap: "secureimap.t-online.de", smtp: "securesmtp.t-online.de" },
  { host: /(?:^|\.)world4you\.com$/u, imap: "imap.world4you.com", smtp: "smtp.world4you.com" },
  { host: /(?:^|\.)easyname\.(?:com|eu)$/u, imap: "imap.easyname.com", smtp: "smtp.easyname.com", smtps: true },
  { host: /(?:^|\.)(?:kundenserver\.de|ionos\.[a-z.]+)$/u, imap: "imap.ionos.de", smtp: "smtp.ionos.de" },
  { host: /(?:^|\.)strato\.de$/u, imap: "imap.strato.de", smtp: "smtp.strato.de" },
  { host: /(?:^|\.)zoho\.[a-z.]+$/u, imap: "imap.zoho.com", smtp: "smtp.zoho.com" },
  { host: /(?:^|\.)(?:fastmail\.com|messagingengine\.com)$/u, imap: "imap.fastmail.com", smtp: "smtp.fastmail.com" },
];

const imapOn = (host: string): EmailServer[] => [{ host, port: IMAPS, secure: true }, { host, port: IMAP_STARTTLS, secure: false }];
const smtpOn = (host: string, tlsFirst = false): EmailServer[] => {
  const both: EmailServer[] = [{ host, port: SUBMISSION, secure: false }, { host, port: SMTPS, secure: true }];
  return tlsFirst ? both.reverse() : both;
};

/** Where the outgoing server usually is, beside an incoming one that took the password: imap.x (or pop.x, mail.x) has
 * smtp.x and mail.x, and some hosts send from the incoming name itself. */
export function smtpBeside(incoming: string): EmailServer[] {
  const host = incoming.toLowerCase();
  const rest = /^(?:imap|imaps|pop|pop3|mail|secureimap)\d*\.(.+)$/u.exec(host)?.[1];
  const names = [...(rest && rest.includes(".") ? [`smtp.${rest}`, `mail.${rest}`] : []), host];
  return [...new Set(names)].filter(validHost).flatMap((name) => smtpOn(name));
}

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
      if (!answer.ok) {
        await answer.body?.cancel().catch(() => {});
        return null;
      }
      const reader = answer.body?.getReader();
      if (!reader) return "";
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let chars = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          const text = decoder.decode(value, { stream: !done });
          chars += text.length;
          if (chars > MAX_BODY) return null;
          if (text) chunks.push(text);
          if (done) return chunks.join("");
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch { return null; }
  },
  mx: async (domain) => (await resolveMx(domain).catch(() => [])).sort((a, b) => a.priority - b.priority).map((record) => record.exchange.toLowerCase()),
  srv: async (name) => (await resolveSrv(name).catch(() => [])).sort((a, b) => a.priority - b.priority).map((record) => ({ name: record.name.toLowerCase(), port: record.port })),
  cname: async (name) => resolveCname(name).catch(() => []),
  reverse: async (host) => (await Promise.all((await resolve4(host).catch(() => [])).slice(0, 2).map((ip) => reverse(ip).catch(() => [])))).flat(),
});

const bare = (host: string) => host.toLowerCase().replace(/\.$/u, "");
/** A host without its first name: "mx.wh20.host.example" is "wh20.host.example". */
const parent = (host: string) => { const rest = host.slice(host.indexOf(".") + 1); return rest.includes(".") ? rest : host; };

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
  const alias = async (label: string) => (await deps.cname(`${label}.${domain}`).catch(() => [])).map(bare).filter(validHost);
  const mxHosts = deps.mx(domain).then((hosts) => hosts.map(bare).filter(validHost));
  const [own, wellKnown, listed, mx, imaps, submission, imapAlias, smtpAlias, mailAlias, mxNames] = await Promise.all([
    autoconfig(`https://autoconfig.${domain}/mail/config-v1.1.xml`),
    autoconfig(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`),
    list(domain),
    mxHosts,
    deps.srv(`_imaps._tcp.${domain}`),
    deps.srv(`_submission._tcp.${domain}`),
    alias("imap"), alias("smtp"), alias("mail"),
    mxHosts.then(async (hosts) => (await Promise.all(hosts.slice(0, 2).map((host) => deps.reverse(host).catch(() => [])))).flat().map(bare).filter(validHost)),
  ]);
  add(own); add(wellKnown);
  const aliases = [...imapAlias, ...smtpAlias, ...mailAlias];
  const behind = [...mx, ...aliases, ...mxNames];
  const known = KNOWN.filter((entry) => entry.domain?.test(domain) || behind.some((host) => entry.host?.test(host)));
  for (const entry of known) add({ imap: imapOn(entry.imap), smtp: smtpOn(entry.smtp, entry.smtps) });
  out.provider = known.find((entry) => entry.provider)?.provider;
  add(listed);
  // The domain's own aliases name the provider's servers, whose certificates are for those names.
  add({ imap: [...imapAlias, ...mailAlias].flatMap(imapOn), smtp: [...smtpAlias, ...mailAlias].flatMap((host) => smtpOn(host)) });
  const providers = [...new Set([...mx, ...aliases].flatMap((host) => [parent(host), baseDomain(host)]))].filter((base) => base !== domain && validHost(base)).slice(0, 4);
  if (!known.length) for (const found of await Promise.all(providers.map(list))) add(found);
  add({ imap: imaps.filter((record) => validHost(record.name)).map((record) => ({ host: record.name, port: record.port, secure: true })),
    smtp: submission.filter((record) => validHost(record.name)).map((record) => ({ host: record.name, port: record.port, secure: false })) });
  const guesses = [`imap.${domain}`, `mail.${domain}`, ...mx.slice(0, 1), ...providers.flatMap((base) => [`imap.${base}`, `mail.${base}`])];
  add({ imap: guesses.flatMap(imapOn), smtp: [`smtp.${domain}`, `mail.${domain}`, ...providers.flatMap((base) => [`smtp.${base}`, `mail.${base}`]), ...mx.slice(0, 1)].flatMap((host) => smtpOn(host)) });
  return out;
}
