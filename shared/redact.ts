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
  /\bntn_[A-Za-z0-9]{46}(?![A-Za-z0-9_-])/g, // notion integration tokens
  /\bpplx-[A-Za-z0-9]{48}(?![A-Za-z0-9_-])/g, // perplexity api keys
  /\bwhsec_[A-Za-z0-9_-]{20,}/g, // webhook secrets, alone or in an automation's address
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, // sendgrid api keys
  /\bbak_[A-Za-z0-9_-]{20,}/g, // Bot API keys
];
const KEY_PREFIX_TESTS = KEY_PREFIXES.map((re) => new RegExp(re.source));
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// A JWT: `eyJ` at a word boundary, then three runs of base64url of 8 or more, joined by dots, ending at a word boundary
// (`/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/`). Found by a scan, not that pattern: the pattern
// read from every `eyJ` in a long run of base64url to the run's end, so its work grew with the square of the text. Every
// `eyJ` in one run reaches the same dot, so a run that fails for one fails for all after it, and the scan moves past it.
const JWT_RUN = /[A-Za-z0-9_-]*/y;
const WORD = /[A-Za-z0-9_]/;
const runEnd = (text: string, from: number) => { JWT_RUN.lastIndex = from; JWT_RUN.test(text); return JWT_RUN.lastIndex; };
/** Each JWT in the text as [start, end), in order. */
function* jwtSpans(text: string): Generator<[number, number]> {
  for (let from = 0; ;) {
    const at = text.indexOf("eyJ", from);
    if (at < 0) return;
    if (at > 0 && WORD.test(text[at - 1]!)) { from = at + 1; continue; }
    const first = runEnd(text, at);
    if (first - at - 3 < 8 || text[first] !== ".") { from = Math.max(first, at + 1); continue; }
    const second = runEnd(text, first + 1);
    if (second - first - 1 < 8 || text[second] !== ".") { from = first; continue; }
    let third = runEnd(text, second + 1);
    // The last part ends at a word boundary: trailing dashes are not part of it.
    while (third > second + 1 && text[third - 1] === "-") third -= 1;
    if (third - second - 1 < 8) { from = first; continue; }
    yield [at, third];
    from = third;
  }
}
function maskJwts(text: string): string {
  let out = "", last = 0;
  for (const [start, end] of jwtSpans(text)) { out += text.slice(last, start) + mask(text.slice(start, end)); last = end; }
  return last === 0 ? text : out + text.slice(last);
}

// A private key block: its BEGIN line, the body up to the first END line after it, and that END line. Found by a scan for
// the same reason as a JWT: a lazy pattern read from every BEGIN with no END to the end of the text. With no END after one
// BEGIN there is none after any later one, so the scan stops.
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
function maskPemBlocks(text: string): string {
  let out = "", last = 0;
  for (PEM_BEGIN.lastIndex = 0; ;) {
    const begin = PEM_BEGIN.exec(text);
    if (!begin) break;
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    const end = PEM_END.exec(text);
    if (!end) break;
    out += `${text.slice(last, begin.index)}${begin[0]}\n${mask(text.slice(PEM_BEGIN.lastIndex, end.index).trim())}\n${end[0]}`;
    last = PEM_END.lastIndex;
    PEM_BEGIN.lastIndex = last;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Only shapes that are unmistakably a credential (a provider's key prefix, a private key block), never a name or a
 * placeholder: text holding one is a credential store, not instructions. */
export function holdsCredential(text: string): boolean {
  return PRIVATE_KEY_BLOCK.test(text) || KEY_PREFIX_TESTS.some((re) => re.test(text)) || !jwtSpans(text).next().done;
}
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
/** `Authorization: Basic dXNlcjpwYXNz`: the base64 is `user:password` in the clear. Only after an
 * Authorization header, so prose like "Basic configuration" stays. */
const BASIC_AUTH = /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9._~+/=-])/gi;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match.
 *
 * The name before the secret word is not part of the match, only that no letter or digit comes right before the word
 * (`MY_SERVICE_API_KEY`, `x-token`): a match that began at the name read every word boundary in a long run of name
 * characters (a base64url blob, `a-b-c-…`) to the run's end and back, and one 400 KB tool output held the server's only
 * thread about ten seconds, a few MB for minutes. The output is the same: the name is left as it was. */
const KEY_VALUE =
  /(?<![A-Za-z0-9])((?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
/** `X_KEY=value`, `xai-key=value`: an assignment to a name that ENDS in key
 * is a credential whatever the value looks like, so no length floor. The
 * separator before `key` is what keeps `hotkey=` and `keyboard=` out. Only the `_key`/`-key` end is matched, after any
 * name character, for the reason KEY_VALUE's name is not. */
const KEY_SUFFIX_ASSIGNMENT = /(?<=[A-Za-z0-9_-])([_-]key)s?(=)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;
/** `--token abc`, `--password=abc`: the flag names a secret; the value is
 * whatever single token follows, never another flag. */
const SECRET_FLAG = /(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))(["']?)(?!-)([A-Za-z0-9._~+/=-]+)\2/gi;
/** `scheme://user:secret@host` — the password in a URL's userinfo. At most the scheme's last 32 characters are matched
 * (a longer one keeps the rest as it was), with no word boundary before it, for the reason KEY_VALUE's name is not. */
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@'"]+:)([^\s/@'"«»]+)(@)/gi;

// A saved website password has no shape: it is known by value. The server
// registers a scrubber for the values it holds, and every redaction below
// runs it first. Nothing registers one in a client, where this is a no-op.

/** What a held secret becomes wherever it would have appeared. */
export const HELD_SECRET_MASK = "••••••";

const heldSecretScrubbers = new Set<(text: string) => string>();

/** Register a scrubber for held secret values; returns its removal. */
export function addHeldSecretScrubber(scrub: (text: string) => string): () => void {
  heldSecretScrubbers.add(scrub);
  return () => { heldSecretScrubbers.delete(scrub); };
}

export function scrubHeldSecrets(text: string): string {
  if (!text || heldSecretScrubbers.size === 0) return text;
  let out = text;
  for (const scrub of heldSecretScrubbers) out = scrub(out);
  return out;
}

export function redactSecretsInText(text: string): string {
  if (!text) return text;
  // Held values first: a short one-time code is still a secret.
  const held = scrubHeldSecrets(text);
  if (held.length < 8) return held;
  let out = held;
  out = maskPemBlocks(out);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = maskJwts(out);
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
