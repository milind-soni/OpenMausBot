// Content classes for the redaction boundary (#1670). The credential pass
// in redact.ts is unconditional and remains the primary control; these span
// classifiers cover what a credential pattern can never see — personal data
// and internal infrastructure — so a bot configured for them cannot paste
// them onward. Same philosophy as redact.ts: high precision only, because
// over-redaction breaks real tasks. Anything ambiguous stays unclassified.
// shared/ files cannot value-import each other: the app tsc build rejects .ts
// value imports and Node, which runs these files directly, cannot resolve a
// .js specifier to a .ts file. So this mirrors the two-line mask from
// redact.ts; the parity test in content-class.test.ts fails if the two ever
// drift, keeping repeated redaction byte-for-byte stable across scrubs.
const REDACTION_MARKER = /^«redacted \d+ chars»$/;
const mask = (value: string) => (REDACTION_MARKER.test(value) ? value : `«redacted ${value.length} chars»`);

/** Classes a bot can be configured to redact beyond credentials.
 * "credentials" is never loosenable and "public" needs no enforcement, so
 * neither appears here. */
export type ContentClass = "personal" | "internal";

// ── personal data ─────────────────────────────────────────────────────
// An email address is unmistakable. Phone numbers match only shapes that
// cannot be a date, an id, or a version: NANP 3-3-4 with real separators,
// or a leading + country code. SSNs are 3-2-4, a grouping no date or
// version uses. Cards are a 13-19 digit run that passes Luhn — the
// checksum makes false positives negligible. A candidate can fuse a card
// with an adjacent digit group ("4111…1111 1234" is 20 digits as one
// match), so cards are validated window-by-window inside the candidate,
// never as the candidate's whole digit string.
const EMAIL = /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
const PHONE_NANP = /(?:\+1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;
const PHONE_INTL = /\+\d{1,3}(?:[\s.-]?\d){7,13}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_CANDIDATE = /\b\d[\d -]{11,25}\d\b/g;

// ── internal infrastructure ───────────────────────────────────────────
// RFC1918/loopback/link-local IPv4 (validated octet-by-octet), IPv6
// unique-local (fc00::/7), link-local (fe80::/10), ::1 and IPv4-mapped
// private addresses, and hostnames under private-only suffixes. A public
// IP or domain never matches. IPv6 is classified from the parsed
// address, never from a fragment: "fd00:1" inside the global address
// 2606:4700::fd00:1 is not unique-local.
const IPV4_CANDIDATE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// Any maximal hex/colon blob with at least two colons — every IPv6
// spelling, including a trailing dotted-quad tail. Whether the blob is a
// complete address, and whether that address is internal, is the
// parser's call; matching only an internal-looking prefix was the bug.
const IPV6_CANDIDATE = /(?<![0-9A-Fa-f:.])(?=[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:)[0-9A-Fa-f:]+(?:\.\d{1,3}){0,3}(?![0-9A-Fa-f:.])/g;
const INTERNAL_HOST = /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.(?:internal|local|lan|corp|home)\b/g;

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function luhnPasses(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** One exact IPv6 literal as eight hextets, or null when the token is
 * not a complete address (times, MACs, truncated fragments). Accepts one
 * "::" compression and a trailing dotted-quad IPv4 tail. */
function parseIpv6Address(token: string): Uint16Array | null {
  let body = token;
  if (token.includes(".")) {
    const lastColon = token.lastIndexOf(":");
    if (lastColon === -1) return null;
    const octets = token.slice(lastColon + 1).split(".");
    if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
    const high = (Number(octets[0]) << 8) | Number(octets[1]);
    const low = (Number(octets[2]) << 8) | Number(octets[3]);
    body = `${token.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const sections = body.split("::");
  if (sections.length > 2) return null;
  const groups: number[][] = [];
  for (const section of sections) {
    const parsed: number[] = [];
    if (section !== "") {
      for (const hextet of section.split(":")) {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(hextet)) return null;
        parsed.push(parseInt(hextet, 16));
      }
    }
    groups.push(parsed);
  }
  const explicit = groups.reduce((count, group) => count + group.length, 0);
  if (sections.length === 2 ? explicit > 7 : explicit !== 8) return null;
  const out = new Uint16Array(8);
  let cursor = 0;
  for (const group of groups[0]) out[cursor++] = group;
  if (sections.length === 2) {
    cursor = 8 - groups[1].length;
    for (const group of groups[1]) out[cursor++] = group;
  }
  return out;
}

/** Whether a parsed address belongs to this machine's own networks:
 * unique-local fc00::/7, link-local fe80::/10, ::1, and IPv4-mapped
 * addresses carrying a private IPv4 value. */
function isInternalIpv6(groups: Uint16Array): boolean {
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if (groups[7] === 1 && groups.slice(0, 7).every((group) => group === 0)) return true;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return isPrivateIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
  }
  return false;
}

/** Merged union of every Luhn-valid 13-19 digit window inside one card
 * candidate. Two overlapping cards can share a tail ("0006 4111 ... 1111"
 * hides "4111 1111 ... 1111"), so collecting each valid window and merging
 * overlaps keeps the shared digits masked instead of stranding them after
 * the first match. */
function cardSpans(candidate: string): Array<[number, number]> {
  const groups: Array<[number, number, number]> = [];
  const digits = /\d+/g;
  for (let match = digits.exec(candidate); match !== null; match = digits.exec(candidate)) {
    groups.push([match.index, match.index + match[0].length, match[0].length]);
  }
  const spans: Array<[number, number]> = [];
  for (let start = 0; start < groups.length; start += 1) {
    for (let end = start; end < groups.length; end += 1) {
      let total = 0;
      for (let i = start; i <= end; i += 1) total += groups[i][2];
      if (total > 19) break;
      if (total >= 13 && luhnPasses(candidate.slice(groups[start][0], groups[end][1]).replace(/\D/g, ""))) {
        spans.push([groups[start][0], groups[end][1]]);
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

function maskCardCandidate(candidate: string): string {
  const spans = cardSpans(candidate);
  if (spans.length === 0) return candidate;
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += candidate.slice(cursor, start) + mask(candidate.slice(start, end));
    cursor = end;
  }
  return out + candidate.slice(cursor);
}

/** Module regexes carry /g state; every use goes through these resets. */
function matchesAny(text: string, patterns: RegExp[], accept: (match: string) => boolean = () => true): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    let found = false;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (accept(match[0])) {
        found = true;
        break;
      }
    }
    pattern.lastIndex = 0;
    return found;
  });
}

function maskPersonal(text: string): string {
  let out = text.replace(EMAIL, (m) => mask(m));
  out = out.replace(PHONE_NANP, (m) => mask(m));
  out = out.replace(PHONE_INTL, (m) => mask(m));
  out = out.replace(SSN, (m) => mask(m));
  return out.replace(CARD_CANDIDATE, maskCardCandidate);
}

function maskInternal(text: string): string {
  let out = text.replace(IPV4_CANDIDATE, (m) => (isPrivateIpv4(m) ? mask(m) : m));
  out = out.replace(IPV6_CANDIDATE, (m) => {
    const groups = parseIpv6Address(m);
    return groups !== null && isInternalIpv6(groups) ? mask(m) : m;
  });
  return out.replace(INTERNAL_HOST, (m) => mask(m));
}

const hasPersonal = (text: string) =>
  matchesAny(text, [EMAIL, PHONE_NANP, PHONE_INTL, SSN]) ||
  matchesAny(text, [CARD_CANDIDATE], (m) => cardSpans(m).length > 0);
const hasInternal = (text: string) =>
  matchesAny(text, [IPV4_CANDIDATE], isPrivateIpv4) ||
  matchesAny(text, [IPV6_CANDIDATE], (m) => {
    const groups = parseIpv6Address(m);
    return groups !== null && isInternalIpv6(groups);
  }) ||
  matchesAny(text, [INTERNAL_HOST]);

export interface ContentClassRedaction {
  text: string;
  /** Classes detected in the payload but not in the enforced list: they
   * crossed the boundary unredacted by explicit configuration, which the
   * caller must audit (#1670's escape hatch). Empty when nothing detected
   * or when every detected class was enforced. */
  passed: ContentClass[];
}

/** Mask the enforced classes and report classes that were detected but
   * allowed through. Detection for the report runs on the incoming text,
   * so loosened classes are always audited even though their spans are
   * left intact. */
export function redactContentClasses(text: string, enforced: readonly ContentClass[]): ContentClassRedaction {
  if (!text) return { text, passed: [] };
  const passed: ContentClass[] = [];
  let out = text;
  if (enforced.includes("personal")) out = maskPersonal(out);
  else if (hasPersonal(text)) passed.push("personal");
  if (enforced.includes("internal")) out = maskInternal(out);
  else if (hasInternal(text)) passed.push("internal");
  return { text: out, passed };
}
