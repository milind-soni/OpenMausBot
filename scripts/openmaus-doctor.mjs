import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8799";
const STATUS_PATHS = ["/api/status-capsule", "/api/status", "/api/capsule"];
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/i;

/**
 * Creates one normalized doctor check result.
 * @param {string} level Check severity.
 * @param {string} name Check name.
 * @param {string} message Human-readable check message.
 * @param {Record<string, unknown>} [details] Additional structured fields.
 * @returns {Record<string, unknown>} The normalized check result.
 */
function check(level, name, message, details = {}) {
  return { level, name, message, ...details };
}

/**
 * Validates and normalizes a local HTTP endpoint.
 * @param {string} value Endpoint URL to validate.
 * @returns {URL} The normalized loopback URL.
 * @throws {TypeError} If the value is not an HTTP loopback URL.
 */
function localEndpoint(value) {
  const url = new URL(value);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    !["localhost", "127.0.0.1", "::1"].includes(hostname)
  ) {
    throw new Error("endpoint must be an HTTP localhost URL");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * Reads and parses a fetch response body without exposing read or parse errors.
 * @param {Response} response Fetch response to read.
 * @returns {Promise<{value?: unknown, state?: string}>} Parsed body or a bounded error state.
 */
async function readResponse(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return { value: undefined, state: "response_error" };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: undefined };
  }
}

/**
 * Fetches and parses JSON with a bounded abort timeout.
 * @param {typeof fetch} fetcher Fetch implementation to call.
 * @param {string} url Request URL.
 * @param {number} timeoutMs Abort timeout in milliseconds.
 * @returns {Promise<Record<string, unknown>>} Fetch outcome and parsed response data.
 */
async function fetchJson(fetcher, url, timeoutMs) {
  let response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    return { kind: "unreachable" };
  }
  const body = await readResponse(response);
  return { kind: "response", response, ...body };
}

/**
 * Collects and validates digest fields from a status payload.
 * @param {Record<string, unknown> | null | undefined} value Status payload.
 * @param {string[]} names Accepted digest field names.
 * @returns {{invalid: boolean} | {values: string[]}} Digest validation result.
 */
function digestPair(value, names) {
  const values = names.map((name) => value?.[name]).filter((item) => item !== undefined && item !== null);
  if (values.some((item) => typeof item !== "string" || !DIGEST.test(item))) return { invalid: true };
  if (new Set(values.map((item) => item.toLowerCase())).size > 1) return { invalid: true };
  return { values };
}

/**
 * Validates the identity, readiness, and digest relationships in a status payload.
 * @param {unknown} value Status payload to inspect.
 * @returns {string | null} Failure reason, or null when the payload is valid.
 */
function inspectStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid JSON object";
  const app = value.app ?? value.identity?.app;
  if (app !== undefined && app !== "openmausbot") return "wrong app identity";
  if (value.ready !== undefined && value.ready !== true) return "ready=false";
  if (value.identity?.ready !== undefined && value.identity.ready !== true) return "ready=false";
  const source = digestPair(value, ["sourceSha256", "source_sha256"]);
  const build = digestPair(value, ["buildSha256", "build_sha256", "dualViewSha256", "dual_view_sha256"]);
  if (source.invalid || build.invalid) return "invalid source/build digest";
  if (source.values.length && build.values.length && source.values[0].toLowerCase() !== build.values[0].toLowerCase()) {
    return "source/build digest mismatch";
  }
  return null;
}

/**
 * Hashes a watched regular file and returns a doctor check.
 * @param {string} file File path to hash.
 * @param {string} label Display label for the check.
 * @returns {Promise<Record<string, unknown>>} File integrity check result.
 */
async function watchFileWithDigest(file, label) {
  const path = resolve(file);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return check("FAIL", "watch", `${label}: not a regular file`);
    const hash = createHash("sha256");
    await new Promise((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolvePromise);
    });
    const sha256 = hash.digest("hex");
    return check("PASS", "watch", `${label} sha256=${sha256}`, { sha256 });
  } catch {
    return check("FAIL", "watch", `${label}: unreadable`);
  }
}

/**
 * Runs the local endpoint and optional file-integrity diagnostics.
 * @param {object} [options] Doctor options.
 * @param {string} [options.endpoint] Local endpoint URL.
 * @param {string[]} [options.watches] Files to hash.
 * @param {typeof fetch} [options.fetcher] Fetch implementation to use.
 * @param {number} [options.timeoutMs] Request timeout in milliseconds.
 * @returns {Promise<{endpoint: string | null, checks: Record<string, unknown>[], exitCode: number}>} Doctor report.
 */
export async function runDoctor({ endpoint = DEFAULT_ENDPOINT, watches = [], fetcher = fetch, timeoutMs = 2_000 } = {}) {
  const checks = [];
  let base;
  try {
    base = localEndpoint(endpoint);
    checks.push(check("PASS", "endpoint", `local endpoint ${base.origin}`));
  } catch {
    checks.push(check("FAIL", "endpoint", "endpoint must be an HTTP localhost URL"));
    return { endpoint: null, checks, exitCode: 2 };
  }

  const health = await fetchJson(fetcher, `${base.origin}/api/health`, timeoutMs);
  if (health.kind === "unreachable") {
    checks.push(check("FAIL", "health", "unreachable endpoint", { state: "unreachable" }));
  } else if (!health.response.ok) {
    checks.push(check("FAIL", "health", `HTTP ${health.response.status}`, { state: "http_error", status: health.response.status }));
  } else if (health.state === "response_error") {
    checks.push(check("FAIL", "health", "response body unreadable", { state: "response_error" }));
  } else if (health.value === undefined) {
    checks.push(check("FAIL", "health", "invalid JSON", { state: "invalid_json" }));
  } else if (!health.value || typeof health.value !== "object" || Array.isArray(health.value)) {
    checks.push(check("FAIL", "health", "invalid JSON object", { state: "invalid_shape" }));
  } else if (health.value.app !== "openmausbot") {
    checks.push(check("FAIL", "health", "wrong app identity", { state: "wrong_identity" }));
  } else if (health.value.ready === false) {
    checks.push(check("WARN", "health", "app identity is valid but ready=false", { state: "degraded", pid: health.value.pid ?? null }));
  } else {
    checks.push(check("PASS", "health", "OpenMausBot identity confirmed", { state: "ready", pid: health.value.pid ?? null }));
  }

  let statusSeen = false;
  for (const path of STATUS_PATHS) {
    const result = await fetchJson(fetcher, `${base.origin}${path}`, timeoutMs);
    if (result.kind === "unreachable") continue;
    if (result.response.status === 404) continue;
    statusSeen = true;
    if (!result.response.ok) checks.push(check("FAIL", "status", `${path}: HTTP ${result.response.status}`, { path, state: "http_error", status: result.response.status }));
    else if (result.state === "response_error") checks.push(check("FAIL", "status", `${path}: response body unreadable`, { path, state: "response_error" }));
    else if (result.value === undefined) checks.push(check("FAIL", "status", `${path}: invalid JSON`, { path, state: "invalid_json" }));
    else {
      const problem = inspectStatus(result.value);
      checks.push(problem ? check("FAIL", "status", `${path}: ${problem}`, { path, state: "invalid_effect" }) : check("PASS", "status", `${path}: identity/readiness/digests valid`, { path, state: "valid" }));
    }
    break;
  }
  if (!statusSeen) checks.push(check("INFO", "status", "status/capsule endpoint unavailable", { state: "unknown" }));
  for (const [index, file] of watches.entries()) checks.push(await watchFileWithDigest(file, `watch #${index + 1}`));

  const exitCode = checks.some((item) => item.level === "FAIL") ? 2 : checks.some((item) => item.level === "WARN") ? 1 : 0;
  return { endpoint: base.origin, checks, exitCode };
}

/**
 * Parses command-line options for the doctor CLI.
 * @param {string[]} argv Command-line arguments.
 * @returns {{endpoint: string, watches: string[], json: boolean, quiet: boolean}} Parsed options.
 * @throws {Error} If an argument is unknown or output modes conflict.
 */
export function parseArgs(argv) {
  const options = { endpoint: DEFAULT_ENDPOINT, watches: [], json: false, quiet: false };
  const nextValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--endpoint") {
      options.endpoint = nextValue(i, arg);
      i += 1;
    } else if (arg === "--watch") {
      options.watches.push(nextValue(i, arg));
      i += 1;
    }
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else throw new Error("unknown argument");
  }
  if (options.json && options.quiet) throw new Error("--json and --quiet cannot be combined");
  return options;
}

/**
 * Renders a doctor report as JSON or human-readable text.
 * @param {{checks: Array<{level: string, name: string, message: string}>}} report Doctor report.
 * @param {object} [options] Output options.
 * @param {boolean} [options.json] Render machine-readable JSON.
 * @param {boolean} [options.quiet] Hide passing and informational checks.
 * @returns {string} Rendered report.
 */
export function renderReport(report, { json = false, quiet = false } = {}) {
  if (json) return JSON.stringify(report);
  const rows = report.checks.filter((item) => !quiet || item.level === "FAIL" || item.level === "WARN");
  return rows.length ? rows.map((item) => `${item.level} ${item.name}: ${item.message}`).join("\n") : "OK";
}

/**
 * Runs the command-line doctor entry point.
 * @returns {Promise<void>} Resolves after setting the process exit code.
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL args: ${error instanceof Error ? error.message : "invalid arguments"}`);
    process.exitCode = 2;
    return;
  }
  const report = await runDoctor(options);
  console.log(renderReport(report, options));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
