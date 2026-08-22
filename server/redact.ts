// Keeping secrets out of the native protocol log.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header. Those logs sit in ~/.openmausbot/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.

/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authorization",
  "auth_token",
  "cookie",
  "credential",
  "dsn",
];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only
 * treat it as a credential when it stands alone or is a suffix, which is how
 * every real one is spelled (API_KEY, consumer-key, xai_key). */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

const mask = (value: string) => `«redacted ${value.length} chars»`;

// ── content-shaped secrets ────────────────────────────────────────────
// What a bot's own reply, a tool title, or a permission card can carry —
// and, since the rebuild replays activity into every handed-over context,
// what would otherwise become permanent. High precision on purpose: a
// generic "long hex/base64" heuristic would rewrite real code in the
// transcript, so only shapes that are unmistakably credentials match.

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // jwt
];
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
const SECRET_HEADER = /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)([^\r\n"']{4,})/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+:[^\s/@]+)@/gi;
const DATA_URL = /\b(data:(?:image\/[^;,\s]+|application\/octet-stream);base64,)([A-Za-z0-9+/=\r\n]{16,})/gi;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match. */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;

export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, (_m, open: string, body: string, close: string) => `${open}\n${mask(body.trim())}\n${close}`);
  out = out.replace(DATA_URL, (_m, prefix: string, body: string) => `${prefix}«binary omitted ${body.length} chars»`);
  out = out.replace(SECRET_HEADER, (_m, lead: string, value: string) => `${lead}${mask(value.trim())}`);
  out = out.replace(URL_USERINFO, (_m, scheme: string, userinfo: string) => `${scheme}${mask(userinfo)}@`);
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  return out;
}

/** Deep copy with credential VALUES replaced. Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]). Anything unrecognised is copied as-is. */
export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
  if (depth > 12 || input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => {
      // ACP env entries: {name: "OMB_COMMS_TOKEN", value: "…"}
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        return isSecretName(entry.name) ? { ...entry, value: mask(entry.value) } : entry;
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    // any other string may still CONTAIN a credential (a command line, a
    // header value, a bot's reply) — the content pass catches those
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}

/** Replace exact protected values that have no recognizable token prefix.
 * This is the second redaction pass used at capability/telemetry boundaries:
 * key-shaped redaction catches structure, while this catches an arbitrary
 * canary or provider value copied into an otherwise innocuous text field. */
export function redactKnownValues(input: unknown, protectedValues: Iterable<string>, depth = 0): unknown {
  const values = [...new Set([...protectedValues].filter((value) => value.length >= 6))].sort(
    (a, b) => b.length - a.length,
  );
  const visit = (value: unknown, level: number): unknown => {
    if (typeof value === "string") {
      let output = value;
      for (const secret of values) output = output.split(secret).join(`«redacted ${secret.length} chars»`);
      return output;
    }
    if (level > 12 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => visit(item, level + 1));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, visit(item, level + 1)]),
    );
  };
  return visit(input, depth);
}

/** Values already present in the host process under credential-shaped names.
 * Names and values remain in memory only; callers must never serialize this
 * set or place it in a child process wholesale. */
export function protectedEnvironmentValues(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    Object.entries(env).flatMap(([name, value]) =>
      isSecretName(name) && typeof value === "string" && value.length >= 6 ? [value] : [],
    ),
  );
}
