// Keeping secrets out of text that crosses a trust boundary: the native
// protocol log, tool titles, activity chips. The log keeps the shape (the
// name, the length) and loses the values.

/** Keep repeated redaction byte-for-byte stable. Persisted payloads can pass
 * through both a content scrub and the store-wide scrub; re-masking our own
 * marker would change its reported length (and any hash over the payload). */
const REDACTION_MARKER = /^«redacted \d+ chars»$/;

export const mask = (value: string) => (REDACTION_MARKER.test(value) ? value : `«redacted ${value.length} chars»`);

// High precision on purpose: a generic "long hex/base64" heuristic would
// rewrite real code in the transcript, so only shapes that are unmistakably
// credentials match.

const KEY_PREFIXES: RegExp[] = [
  /\bom[dg]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, // desktop device and model-only credentials
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // stripe secret and restricted keys
  /\bxai-[A-Za-z0-9_-]{20,}/g, // xai (grok)
  /\bgsk_[A-Za-z0-9]{40,}/g, // groq
  /\bcsk-[A-Za-z0-9]{32,}/g, // cerebras
  /\bLLM\|\d{6,}\|[A-Za-z0-9_-]{16,}/g, // meta model api
  /\bhf_[A-Za-z0-9]{30,}/g, // hugging face
  /\bpypi-AgE[A-Za-z0-9_-]{82,}/g, // pypi and testpypi api tokens (macaroons)
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bgl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g, // gitlab personal, deploy and runner tokens (routable ones carry .-parts)
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g, // slack app-level (socket mode) tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // aws access key id, long-term (AKIA) or temporary STS (ASIA)
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\bwhsec_[A-Za-z0-9_-]{20,}/g, // webhook secrets, alone or in an automation's address
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, // sendgrid api keys
  /\bbak_[A-Za-z0-9_-]{20,}/g, // Bot API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // jwt
];
const KEY_PREFIX_TESTS = KEY_PREFIXES.map((re) => new RegExp(re.source));
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** `-----BEGIN RSA PRIVA`: a header still being written, which may yet open a private key. */
const PARTIAL_KEY_HEADER = /-----BEGIN[A-Z ]*-{0,4}$/;

/** Where text still being written opens a private key it has not closed, or may be about to; -1 when it does neither.
 * A key's body is masked only once its END line is in, so streamed text waits from here. */
export function openPrivateKeyAt(text: string): number {
  PRIVATE_KEY_HEADER.lastIndex = 0;
  for (let header = PRIVATE_KEY_HEADER.exec(text); header; header = PRIVATE_KEY_HEADER.exec(text)) {
    if (!PRIVATE_KEY_END.test(text.slice(PRIVATE_KEY_HEADER.lastIndex))) return header.index;
  }
  return PARTIAL_KEY_HEADER.exec(text)?.index ?? -1;
}

/** Only shapes that are unmistakably a credential (a provider's key prefix, a private key block), never a name or a
 * placeholder: text holding one is a credential store, not instructions. */
export function holdsCredential(text: string): boolean {
  return PRIVATE_KEY_BLOCK.test(text) || KEY_PREFIX_TESTS.some((re) => re.test(text));
}
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
/** `Authorization: Basic dXNlcjpwYXNz`: the base64 is `user:password` in the clear. Only after an
 * Authorization header, so prose like "Basic configuration" stays. */
const BASIC_AUTH = /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9._~+/=-])/gi;
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match. */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
/** `X_KEY=value`, `xai-key=value`: an assignment to a name that ENDS in key
 * is a credential whatever the value looks like, so no length floor. The
 * separator before `key` is what keeps `hotkey=` and `keyboard=` out. */
const KEY_SUFFIX_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_-]*[_-]key)s?(=)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;
/** `--token abc`, `--password=abc`: the flag names a secret; the value is
 * whatever single token follows, never another flag. */
const SECRET_FLAG = /(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))(["']?)(?!-)([A-Za-z0-9._~+/=-]+)\2/gi;
/** `scheme://user:secret@host` — the password in a URL's userinfo. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:)([^\s/@'"«»]+)(@)/gi;

// A saved website password has no shape: it is known by value. The server
// registers a scrubber for the values it holds, and every redaction below
// runs it first. Nothing registers one in a client, where this is a no-op.

/** What a held secret becomes wherever it would have appeared. */
export const HELD_SECRET_MASK = "••••••";

interface HeldSecretScrubber {
  scrub: (text: string) => string;
  /** The length of the longest value it holds, in any form, that a stream could cut partway (see
   * `longestSplittableForm`); 0 when it holds none. */
  longest: () => number;
  /** Whether text holds a piece of a held value whose tail `longest` counts only up to its first piece
   * (server/held-pieces.ts): a stream stops there. */
  begun?: (text: string) => boolean;
}

const heldSecretScrubbers = new Set<HeldSecretScrubber>();

/** Register a scrubber for held secret values, with the length of the longest one a stream could cut partway; returns
 * its removal. A stream holds back that many characters whatever they are, so such a value is masked whole and nothing
 * about it shows before. */
export function addHeldSecretScrubber(scrub: (text: string) => string, longest: () => number, begun?: (text: string) => boolean): () => void {
  const entry: HeldSecretScrubber = { scrub, longest, ...(begun ? { begun } : {}) };
  heldSecretScrubbers.add(entry);
  return () => { heldSecretScrubbers.delete(entry); };
}

export function scrubHeldSecrets(text: string): string {
  if (!text || heldSecretScrubbers.size === 0) return text;
  let out = text;
  for (const { scrub } of heldSecretScrubbers) out = scrub(out);
  return out;
}

/** The length of the longest held value a stream could cut partway; Infinity when a scrubber cannot say (a stream then
 * holds everything back). */
export function heldSecretLongest(): number {
  let longest = 0;
  for (const scrubber of heldSecretScrubbers) {
    const length = typeof scrubber.longest === "function" ? scrubber.longest() : Infinity;
    longest = Math.max(longest, Number.isNaN(length) ? Infinity : length);
  }
  return longest;
}

/** Printable ASCII with no whitespace: a stream never cuts inside a run of it (shared/stream-hold.ts), so a value made
 * only of it is whole whenever any of it is sent, and is masked whole. */
const UNSPLITTABLE = /^[\x21-\x7e]*$/;

/** Whether `text` holds a piece of a held value (see `HeldSecretScrubber.begun`). */
export function heldSecretBegun(text: string): boolean {
  for (const { begun } of heldSecretScrubbers) if (begun?.(text)) return true;
  return false;
}

/** The longest of `forms` that a stream could cut partway (one with whitespace or a character outside printable
 * ASCII), for a scrubber's `longest`; forms of printable ASCII alone need no held-back tail. */
export function longestSplittableForm(forms: Iterable<string>): number {
  let longest = 0;
  for (const form of forms) if (form.length > longest && !UNSPLITTABLE.test(form)) longest = form.length;
  return longest;
}

export function redactSecretsInText(text: string): string {
  if (!text) return text;
  // Held values first: a short one-time code is still a secret.
  const held = scrubHeldSecrets(text);
  if (held.length < 8) return held;
  let out = held;
  out = out.replace(PEM_BLOCK, (_m, open: string, body: string, close: string) => `${open}\n${mask(body.trim())}\n${close}`);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(BASIC_AUTH, (_m, lead: string, creds: string) => `${lead}${mask(creds)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(KEY_SUFFIX_ASSIGNMENT, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(SECRET_FLAG, (_m, flag: string, quote: string, value: string) => `${flag}${quote}${mask(value)}${quote}`);
  out = out.replace(URL_USERINFO, (_m, lead: string, secret: string, at: string) => `${lead}${mask(secret)}${at}`);
  return out;
}

/** Security invariant: a sentence's params are scrubbed like the English they fill, so a secret survives in neither. */
export function redactParams<T extends Record<string, string | number>>(params: T): T {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === "string" ? redactSecretsInText(value) : value])) as T;
}
