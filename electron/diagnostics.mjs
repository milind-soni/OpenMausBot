// One-click bug-report bundle: app facts, a safe config summary and the
// server.log tail, formatted for pasting into a public issue. Pure string
// work lives here so redaction stays unit-testable without Electron; main.mjs
// owns the fs and dialog plumbing. Safety is layered: the collector never
// reads secret fields at all (only the server's booleans-only config status),
// and everything that does get in is scrubbed again here before it lands on
// disk — so a future collector mistake still cannot leak a credential.
//
// CREDENTIAL_ENV_NAMES mirrors WORKSPACE_CREDENTIAL_ENV (server/config.ts).
// Duplicated because the desktop shell cannot import TypeScript; a test
// asserts the two lists never drift apart.
export const CREDENTIAL_ENV_NAMES = [
  "XAI_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
];

// Credential-shaped tokens (server/redact.ts parity): unmistakable formats
// are masked wherever they appear, keyed or not.
const CREDENTIAL_TOKEN_FORMATS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bak_[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
];
const KEY_VALUE_PAIR =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"',;)\]}]+)/gi;
const AUTHORIZATION =
  /\b(authorization)\s*[:=]\s*(?:"|')?([A-Za-z][A-Za-z0-9_-]*\s+[A-Za-z0-9._~+/=-]+)(?:"|')?/gi;
const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const PEM_BLOCK =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g;

const mask = (value) => `«redacted ${value.length} chars»`;
const unquote = (value) => value.replace(/^["']|["']$/g, "");

// Shared value grammar; String.raw keeps \s and \] intact when the pattern
// is embedded into the dynamically built env-name regexes below.
const VALUE_PART = String.raw`("[^"]*"|'[^']*'|[^\s"',;)\]}]+)`;

export function redactSecretsInLine(line) {
  let out = String(line ?? "");
  const alreadyMasked = (value) => String(value).includes("«redacted");
  for (const name of CREDENTIAL_ENV_NAMES) {
    out = out.replace(
      new RegExp(`\\b(${name})\\s*[:=]\\s*${VALUE_PART}`, "gi"),
      (_match, key, value) => `${key}=${mask(unquote(value))}`,
    );
  }
  out = out.replace(AUTHORIZATION, (_match, key, value) => `${key}=${mask(value)}`);
  out = out.replace(BEARER, (_match, lead, token) => `${lead}${mask(token)}`);
  out = out.replace(PEM_BLOCK, (_match, open, close) => `${open}«redacted private key»${close}`);
  out = out.replace(KEY_VALUE_PAIR, (_match, key, value) =>
    alreadyMasked(value) ? _match : `${key}=${mask(unquote(value))}`,
  );
  for (const format of CREDENTIAL_TOKEN_FORMATS) out = out.replace(format, (found) => mask(found));
  return out;
}

/** Decode a bounded log buffer without exporting the partial first line that
 * may begin before the read boundary. */
export function decodeLogTail(buffer, truncated = false) {
  if (!Buffer.isBuffer(buffer)) return { tail: "", bytes: 0 };
  let complete = buffer;
  if (truncated) {
    const newline = buffer.indexOf(0x0a);
    complete = newline < 0 ? buffer.subarray(0, 0) : buffer.subarray(newline + 1);
  }
  return { tail: complete.toString("utf8"), bytes: complete.length };
}

const APP_INFO_KEYS = ["version", "platform", "arch", "electron", "node", "packaged", "uptimeSeconds"];

// A config summary entry is publishable only when it carries no credential:
// Only booleans and finite numbers pass. Strings can contain names, paths,
// account identifiers, or other personal data even when the field name is
// not credential-shaped, so they never reach the file. Everything else
// (objects beyond flattening, arrays, nulls) is dropped too.
const isFiniteNumber = (value) => Number.isFinite(value) && Object.prototype.toString.call(value) === "[object Number]";

function summaryAllows(value) {
  if (Object.prototype.toString.call(value) === "[object Boolean]") return true;
  return isFiniteNumber(value);
}

function flattenSummary(input, prefix = "", depth = 0, out = {}) {
  if (!input || Object.prototype.toString.call(input) !== "[object Object]") return out;
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) continue;
    if (value && Object.prototype.toString.call(value) === "[object Object]" && depth < 3)
      flattenSummary(value, path, depth + 1, out);
    else out[path] = value;
  }
  return out;
}

export function buildDiagnosticsReport({
  appInfo = {},
  configSummary = {},
  logTail,
  now = new Date().toISOString(),
} = {}) {
  const lines = [];
  lines.push("OpenMausBot diagnostics");
  lines.push(`Generated: ${now}`);
  lines.push("");
  lines.push("## App");
  for (const key of APP_INFO_KEYS) {
    if (appInfo[key] === undefined || appInfo[key] === null) continue;
    lines.push(`${key}=${String(appInfo[key])}`);
  }
  lines.push("");
  lines.push("## Configuration");
  lines.push("# presence/count/mode only — credentials stay OS-encrypted and are never read");
  const summary = flattenSummary(configSummary);
  let shown = 0;
  for (const key of Object.keys(summary).sort()) {
    if (!summaryAllows(summary[key])) continue;
    lines.push(`${key}=${summary[key]}`);
    shown += 1;
  }
  if (!shown) lines.push("(no configuration summary available)");
  lines.push("");
  lines.push(logTail && logTail.trim() ? "## Server log tail — known credential patterns auto-masked" : "## Server log tail");
  if (logTail && logTail.trim()) {
    for (const line of redactSecretsInLine(logTail).split(/\r?\n/)) lines.push(line);
  } else {
    lines.push("(server log unavailable)");
  }
  lines.push("");
  return lines.join("\n");
}

export function diagnosticsFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `openmausbot-diagnostics-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`
  );
}
