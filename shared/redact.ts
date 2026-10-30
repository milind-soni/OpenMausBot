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
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\bwhsec_[A-Za-z0-9_-]{20,}/g, // webhook secrets, alone or in an automation's address
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // jwt
];
const KEY_PREFIX_TESTS = KEY_PREFIXES.map((re) => new RegExp(re.source));
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Only shapes that are unmistakably a credential (a provider's key prefix, a private key block), never a name or a
 * placeholder: text holding one is a credential store, not instructions. */
export function holdsCredential(text: string): boolean {
  return PRIVATE_KEY_BLOCK.test(text) || KEY_PREFIX_TESTS.some((re) => re.test(text));
}
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
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
  out = out.replace(PEM_BLOCK, (_m, open: string, body: string, close: string) => `${open}\n${mask(body.trim())}\n${close}`);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(KEY_SUFFIX_ASSIGNMENT, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(SECRET_FLAG, (_m, flag: string, quote: string, value: string) => `${flag}${quote}${mask(value)}${quote}`);
  out = out.replace(URL_USERINFO, (_m, lead: string, secret: string, at: string) => `${lead}${mask(secret)}${at}`);
  return out;
}

