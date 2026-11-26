// What a template loses before it is published to a public repository: home-folder paths, the app's own data folders,
// email addresses, phone numbers, key- and token-shaped values, and the publisher's own names. Deterministic and
// idempotent: scrubbing scrubbed text changes nothing. No imports: the app scrubs before anything leaves the computer
// and the MausBot Admin scrubs again before it commits, from the same file, tested on the same vectors.

/** How many different values of each kind were taken out. */
export interface ScrubCounts {
  /** Home folders and the app's data folders. */
  paths: number;
  emails: number;
  phones: number;
  /** The publisher's own names: their computer's user name, and their profile name when it isn't their credit. */
  names: number;
  /** Key- and token-shaped values. A template holding one is never published, even scrubbed. */
  secrets: number;
}

export interface ScrubOptions {
  /** Whole words or phrases to replace with `<name>`; pass them through `personalNames` first. */
  names?: readonly string[];
}

export const SCRUB_MARKS = { path: "~", workspace: "<workspace>", email: "<email>", phone: "<phone>", name: "<name>", secret: "<secret>" } as const;

export const emptyScrubCounts = (): ScrubCounts => ({ paths: 0, emails: 0, phones: 0, names: 0, secrets: 0 });

export function addScrubCounts(a: ScrubCounts, b: ScrubCounts): ScrubCounts {
  return { paths: a.paths + b.paths, emails: a.emails + b.emails, phones: a.phones + b.phones, names: a.names + b.names, secrets: a.secrets + b.secrets };
}

/** The values taken out so far, by kind: the same address in two places counts once. */
type Found = { [kind in keyof ScrubCounts]: Set<string> };
const newFound = (): Found => ({ paths: new Set(), emails: new Set(), phones: new Set(), names: new Set(), secrets: new Set() });
const countsOf = (found: Found): ScrubCounts =>
  ({ paths: found.paths.size, emails: found.emails.size, phones: found.phones.size, names: found.names.size, secrets: found.secrets.size });
const take = (found: Found, kind: keyof ScrubCounts, value: string, mark: string) => { found[kind].add(value); return mark; };

// ---- Secrets -------------------------------------------------------------------------------------------------------

/** Only shapes that are unmistakably a credential, so instructions that talk about keys keep their words. */
const SECRET_SHAPES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxai-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{40,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bwhsec_[A-Za-z0-9_-]{20,}/g,
  /\bom[dg]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /\bbak_[A-Za-z0-9_-]{20,}/g,
];
/** The BEGIN line, the base64 lines under it and the END line when there is one: linear, with or without an END. */
const PRIVATE_KEY = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:\r?\n[A-Za-z0-9+/=]{16,})*(?:\r?\n-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g;
/** A bearer token with letters and digits in it: "Bearer YOUR_TOKEN" in a skill's example stays. */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})(?![A-Za-z0-9._~+/=-])/g;

function scrubSecrets(text: string, found: Found): string {
  let out = text.replace(PRIVATE_KEY, (match) => take(found, "secrets", match, SCRUB_MARKS.secret));
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match) => take(found, "secrets", match, SCRUB_MARKS.secret));
  return out.replace(BEARER, (match, lead: string, token: string) =>
    /\d/.test(token) && /[A-Za-z]/.test(token) ? `${lead}${take(found, "secrets", token, SCRUB_MARKS.secret)}` : match);
}

// ---- Paths ---------------------------------------------------------------------------------------------------------

const decodeURIComponentSafe = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/** A path separator, also as it is written inside a quoted YAML or JSON string (`\\`). */
const SEP = String.raw`(?:\\{1,2}|/)`;
/** One path segment without spaces. */
const SEG = String.raw`[^\s\\/'"\`<>()\[\]{}|,;:*?]+`;
/** A Windows user folder's name: one word, or "First Last" when a separator follows it. */
const WIN_NAME = String.raw`(?:[A-Za-z0-9._-]{1,32}(?: [A-Z][A-Za-z0-9._-]{0,31}){1,2}(?=${SEP})|[A-Za-z0-9._-]{0,63}[A-Za-z0-9_-])`;
/** Where a path starts: not inside a longer path or a web address (`example.com/home/about` keeps its path). */
const PATH_START = String.raw`(?:(?<=file://)|(?<![A-Za-z0-9_.~\-\\/]))`;
/** Folders under /Users and /home that belong to no one person. */
const SHARED_HOMES = new Set(["shared", "linuxbrew", "guest"]);

/** A path through the app's data folder (`.openmausbot`, `.openmausbot-profiles`, …) to `workspaces/<bot>` or
 * `task-workspaces/<bot>/<conversation>`, up to 3 folders between them. */
const WORKSPACE = new RegExp(
  `(?:${PATH_START}(?:[A-Za-z]:${SEP}[Uu]sers${SEP}${WIN_NAME}|~|\\$HOME|%USERPROFILE%|[A-Za-z]:)?(?:${SEP}${SEG}){0,8}?)?` +
  `${SEP}\\.openmausbot[A-Za-z0-9._-]*(?:${SEP}${SEG}){0,3}?${SEP}(?:task-workspaces${SEP}[A-Za-z0-9_-]+(?:${SEP}[A-Za-z0-9_-]{8,})?|workspaces${SEP}[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])`,
  "g",
);
/** A home under a mounted disk or a WSL view of Windows: `/Volumes/<disk>/Users/x`, `/mnt/c/Users/x`. */
const MOUNT = String.raw`(?:/Volumes/[^/\r\n'"\`<>]{1,64}|/mnt/[A-Za-z])?`;
const MAC_LINUX_HOME = new RegExp(`${PATH_START}${MOUNT}/(Users|home)/((?:[A-Za-z0-9._-]|%20){0,63}[A-Za-z0-9_-])(?![A-Za-z0-9_-]|%20)`, "g");
/** A home on another machine or a WSL distribution: a UNC path to `Users` or `home`, such as `\\server\Users\x` or `\\wsl$\Ubuntu\home\x`. */
const UNC_HOME = new RegExp(String.raw`(?<![A-Za-z0-9_\\])\\{2,4}[A-Za-z0-9.$_-]{1,64}\\{1,2}(?:[A-Za-z0-9._$-]{1,64}\\{1,2})?(Users|home)\\{1,2}(${WIN_NAME})(?![A-Za-z0-9_-])`, "gi");
/** A home folder written percent-encoded, as a link or a query holds it: `%2FUsers%2Fx`, `C%3A%5CUsers%5Cx`. */
const ENCODED_HOME = /(?:[A-Za-z]%3A)?%(?:2F|5C)(Users|home)%(?:2F|5C)((?:[A-Za-z0-9._-]|%20){1,64}?)(?=%(?:2F|5C)|[^A-Za-z0-9._%-]|$)/gi;
const WINDOWS_HOME = new RegExp(`(?<![A-Za-z0-9_])[A-Za-z]:${SEP}[Uu]sers${SEP}(${WIN_NAME})(?![A-Za-z0-9_-])`, "g");

function scrubPaths(text: string, found: Found): string {
  let out = text.replace(WORKSPACE, (match) => take(found, "paths", match, SCRUB_MARKS.workspace));
  const home = (match: string, name: string) => {
    const lower = decodeURIComponentSafe(name).trim().toLowerCase();
    return SHARED_HOMES.has(lower) || lower === "public" || lower === "default" ? match : take(found, "paths", match, SCRUB_MARKS.path);
  };
  out = out.replace(ENCODED_HOME, (match, _root: string, name: string) => home(match, name));
  out = out.replace(UNC_HOME, (match, _root: string, name: string) => home(match, name));
  out = out.replace(WINDOWS_HOME, (match, name: string) => {
    const lower = name.toLowerCase();
    return SHARED_HOMES.has(lower) || lower === "public" || lower === "default" ? match : take(found, "paths", match, SCRUB_MARKS.path);
  });
  return out.replace(MAC_LINUX_HOME, (match, _root: string, name: string) =>
    SHARED_HOMES.has(name.toLowerCase()) ? match : take(found, "paths", match, SCRUB_MARKS.path));
}

// ---- Emails and phone numbers --------------------------------------------------------------------------------------

/** Also with a full-width ＠ or `%40`, and with letters of any script (an internationalised domain). */
const EMAIL = /(?<![\p{L}\p{N}._%+-])([\p{L}\p{N}._+-]{1,64}?)(?:@|＠|%40)((?:[\p{L}\p{N}-]{1,63}\.)+(\p{L}{2,24}))(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])/gu;
/** Addresses nobody owns, and `name@2x.png`-style file names. */
const FILE_ENDINGS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "pdf", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss",
  "json", "md", "py", "rb", "go", "rs", "java", "sh", "txt", "htm", "html", "xml", "yml", "yaml", "toml", "lock", "zip", "tar", "gz", "wasm", "map"]);
const keepEmail = (local: string, domain: string, ending: string) => {
  const host = domain.toLowerCase(), user = local.toLowerCase();
  return FILE_ENDINGS.has(ending.toLowerCase()) || user === "git" || /^no-?reply$/.test(user) || host.endsWith("noreply.github.com")
    || /(?:^|\.)example\.(?:com|org|net)$/.test(host) || /\.(?:example|test|invalid|localhost)$/.test(host);
};

/** `+` and a country code, then groups split by a space, dot or dash (8 to 15 digits in all). */
const PHONE_INTERNATIONAL = /(?<![A-Za-z0-9_+/=%.-])\+\d{1,4}(?:[ .-]?\(\d{1,4}\))?(?:[ .-]\d{1,8}){1,5}(?![A-Za-z0-9_]|[.-]\d)/g;
/** `+` and 10 to 15 digits with nothing between them. */
const PHONE_BARE = /(?<![A-Za-z0-9_+/=%.-])\+\d{10,15}(?![A-Za-z0-9_]|[.-]\d)/g;
/** (415) 555-0132, 415-555-0132, 415.555.0132. */
const PHONE_NANP = /(?<![A-Za-z0-9_.+-])(?:\(\d{3}\)\s?|\d{3}[-.])\d{3}[-.]\d{4}(?![A-Za-z0-9_]|[.-]\d)/g;
/** 020 7946 0958, 0800-123-4567: a trunk 0 and three groups. */
const PHONE_TRUNK = /(?<![A-Za-z0-9_.+-])0\d{2,4}[ -]\d{3,4}[ -]\d{3,4}(?![A-Za-z0-9_]|[ .-]\d)/g;
/** Without a `+`, only spaced groups a timestamp or an id never has: 415 555 0132, (415) 555 0132, 98765 43210. */
const PHONE_SPACED = /(?<![A-Za-z0-9_.+:/-])(?:\(?[2-9]\d{2}\)? \d{3} \d{4}|[6-9]\d{4} \d{5})(?![A-Za-z0-9_]|[ .:-]\d)/g;
const digitCount = (value: string) => value.replace(/\D/g, "").length;

function scrubContacts(text: string, found: Found): string {
  let out = text.replace(EMAIL, (match, local: string, domain: string, ending: string) =>
    keepEmail(local, domain, ending) ? match : take(found, "emails", `${local}@${domain}`.toLowerCase(), SCRUB_MARKS.email));
  const phone = (match: string) => take(found, "phones", match.replace(/\D/g, ""), SCRUB_MARKS.phone);
  out = out.replace(PHONE_INTERNATIONAL, (match: string) => digitCount(match) < 8 || digitCount(match) > 15 ? match : phone(match));
  out = out.replace(PHONE_BARE, phone);
  out = out.replace(PHONE_NANP, phone);
  out = out.replace(PHONE_SPACED, phone);
  return out.replace(PHONE_TRUNK, (match: string) => digitCount(match) < 10 ? match : phone(match));
}

// ---- The publisher's own names -------------------------------------------------------------------------------------

/** Names too common to replace everywhere: a Cloud home's user, a role, a word the template's text needs. */
const COMMON_NAMES = new Set(["root", "admin", "administrator", "user", "users", "guest", "ubuntu", "debian", "fedora", "centos", "node", "runner",
  "app", "apps", "home", "mac", "macbook", "owner", "default", "test", "tester", "dev", "developer", "ec2-user", "pi", "vagrant", "docker", "omb",
  "mausbot", "openmausbot", "shared", "public", "community", "work", "team", "bot", "bots", "agent", "system", "linuxbrew", "codespace", "vscode",
  "coder", "jovyan", "server", "local", "cloud", "workspace", "email", "phone", "secret", "name", "person", "human", "mausbot user"]);

/** The names worth replacing in a template: trimmed, not an address, not a common word, not the credit itself. A single
 * word needs 4 characters; longest first, so a full name goes before a part of it. */
export function personalNames(candidates: ReadonlyArray<string | null | undefined>, credit?: string): string[] {
  const kept = new Map<string, string>();
  const creditKey = credit?.trim().replace(/\s+/g, " ").toLowerCase();
  for (const raw of candidates) {
    const name = raw?.trim().replace(/\s+/g, " ") ?? "";
    const key = name.toLowerCase();
    if (name.length < 3 || name.length > 64 || /[@\r\n<>]/.test(name) || COMMON_NAMES.has(key) || key === creditKey) continue;
    if (!name.includes(" ") && name.length < 4) continue;
    if (!/[\p{L}]/u.test(name)) continue;
    kept.set(key, name);
  }
  return [...kept.values()].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A full name anywhere in the text. One word (a user name, a first name) may also be an ordinary word, so it goes only
 * where it is a handle or a folder: after `@`, `~`, `/` or `\`, or before `/`, `\` or `@`. Never inside a longer word
 * or an identifier: `jane-helper` keeps its name. */
function scrubNames(text: string, names: readonly string[], found: Found): string {
  let out = text;
  for (const name of names) {
    const words = name.split(" ").map(escapeRegExp).join("\\s+");
    const alone = `(?<![\\p{L}\\p{N}_-])${words}(?![\\p{L}\\p{N}_-])`;
    const pattern = name.includes(" ") ? alone : `(?<=[@~/\\\\])${words}(?![\\p{L}\\p{N}_-])|${alone}(?=[/\\\\@])`;
    out = out.replace(new RegExp(pattern, "giu"), () => take(found, "names", name.toLowerCase(), SCRUB_MARKS.name));
  }
  return out;
}

// ---- Text and trees ------------------------------------------------------------------------------------------------

/** One text with every rule applied, in a fixed order: secrets, paths, emails and phone numbers, then names. Only the
 * matched spans change; code fences, Markdown and YAML around them stay as they were. */
export function scrubText(text: string, options: ScrubOptions = {}): { text: string; counts: ScrubCounts } {
  const found = newFound();
  return { text: scrubInto(text, options, found), counts: countsOf(found) };
}

/** Bidirectional overrides and isolates (text that reads differently than it shows) and control characters other than
 * tab and line breaks: they go before anything else is looked at, so none can hide a match. */
const hidden = (code: number) => (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)
  || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

function withoutHidden(text: string): string {
  let out = "", from = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (!hidden(text.charCodeAt(at))) continue;
    out += text.slice(from, at);
    from = at + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

function scrubInto(text: string, options: ScrubOptions, found: Found): string {
  if (!text) return text;
  let out = scrubSecrets(withoutHidden(text), found);
  out = scrubPaths(out, found);
  out = scrubContacts(out, found);
  return options.names?.length ? scrubNames(out, options.names, found) : out;
}

/** A key, an id or a skill's name: the person's names are never taken out of one, which would break it. */
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Every string in a JSON-like value, scrubbed, in a copy. Picture bytes (`avatar.data`) and the files beside a skill
 * (`files[].content`) are left as they are. */
export function scrubTree<T>(value: T, options: ScrubOptions = {}): { value: T; counts: ScrubCounts } {
  const found = newFound();
  const walk = (node: unknown, key: string, parentKey: string): unknown => {
    if (typeof node === "string") {
      if ((key === "data" && parentKey === "avatar") || (key === "content" && parentKey === "files[]")) return node;
      return scrubInto(node, IDENTIFIER.test(node) ? { ...options, names: [] } : options, found);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, `${key}[]`, key));
    if (node && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([name, item]) => [name, walk(item, name, key)]));
    }
    return node;
  };
  return { value: walk(value, "", "") as T, counts: countsOf(found) };
}
