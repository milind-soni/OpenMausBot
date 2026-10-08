import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const DEFAULT_DIFF_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_REPORTED_FINDINGS = 20;

const TEST_FIXTURE_MARKER = "secret-scan: allow-test-fixture";
const TEST_FIXTURE_PATH = /(?:^|\/)(?:__fixtures__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;

const HIGH_SIGNAL_RULES = [
  ["private-key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  [
    "provider-key",
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|xox[baprs]-[A-Za-z0-9-]{20,255}|AIza[0-9A-Za-z_-]{30,255}|sk-(?:proj-)?[A-Za-z0-9_-]{20,255}|sk-ant-[A-Za-z0-9_-]{20,255}|xai-[A-Za-z0-9_-]{20,255}|hf_[A-Za-z0-9_-]{20,255}|npm_[A-Za-z0-9_-]{20,255}|glpat-[A-Za-z0-9_-]{20,255}|(?:sk|rk)_live_[A-Za-z0-9_-]{16,255})\b/g,
  ],
];

const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?key|secret|password|passwd|token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([^\s,;#}\]]+))/gi;

const EXACT_PLACEHOLDER =
  /^(?:change[-_ ]?me|example(?:[-_ ].*)?|placeholder|replace[-_ ]?me|redacted|dummy|fake|test(?:[-_ ].*)?|your[-_ ]?(?:api[-_ ]?)?(?:key|token|secret|password)|none|null|undefined|<[^>]+>)$/i;
const ENV_REFERENCE =
  /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}|(?:process|import\.meta)\.env\.[A-Z_][A-Z0-9_]*|env\.[A-Z_][A-Z0-9_]*)$/i;

export class SecretScanOperationalError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecretScanOperationalError";
  }
}

/** Sanitize control characters and cap a path before it reaches diagnostics. */
function safePath(value) {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? "?" : character;
    })
    .join("")
    .slice(0, 512);
}

/** Decode a Git diff path header and return its sanitized repository path. */
function diffPath(raw) {
  if (raw === "/dev/null") return null;
  let value = raw;
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      return "[non-standard git path]";
    }
  }
  return safePath(value.startsWith("b/") ? value.slice(2) : value);
}

/** Return whether a credential-like value is an allowed placeholder or reference. */
function isPlaceholder(value) {
  const normalized = value.trim();
  return (
    normalized.length === 0 ||
    EXACT_PLACEHOLDER.test(normalized) ||
    ENV_REFERENCE.test(normalized) ||
    /^(?:0+|x{6,}|[-_]+)$/i.test(normalized)
  );
}

/** Scan one added line. Findings intentionally contain no matched value. */
export function scanAddedLine(text, file, line) {
  if (TEST_FIXTURE_PATH.test(file) && text.includes(TEST_FIXTURE_MARKER)) return [];

  const rules = new Set();
  for (const [name, pattern] of HIGH_SIGNAL_RULES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) rules.add(name);
  }

  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const isUnquotedFunctionCall =
      match[4] !== undefined && /^[A-Za-z_$][\w$]*\s*\(\s*\)$/.test(value);
    if (!isPlaceholder(value) && !isUnquotedFunctionCall) rules.add("credential-assignment");
  }

  return [...rules].map((rule) => ({ file: safePath(file), line, rule }));
}

/**
 * Parse a unified diff incrementally. The byte cap bounds both total work and
 * the largest possible partial line; exceeding it is an operational failure.
 */
export async function scanDiffStream(stream, { maxBytes = DEFAULT_DIFF_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new SecretScanOperationalError("the diff byte cap is invalid");
  }

  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytes = 0;
  let file = null;
  let nextLine = 0;
  let inHunk = false;
  let remainingNewLines = 0;
  let addedLines = 0;
  const files = new Set();
  // Exact across all findings; cardinality is bounded by the 16 MiB input cap.
  const findingFiles = new Set();
  const findings = [];
  let totalFindings = 0;

  const consumeNewLine = () => {
    nextLine += 1;
    remainingNewLines -= 1;
    if (remainingNewLines <= 0) {
      inHunk = false;
      remainingNewLines = 0;
    }
  };

  const consume = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!inHunk && line.startsWith("+++ ")) {
      file = diffPath(line.slice(4));
      return;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      remainingNewLines = hunk[2] === undefined ? 1 : Number(hunk[2]);
      inHunk = remainingNewLines > 0;
      return;
    }
    if (!inHunk || !file) return;
    if (line.startsWith("+")) {
      addedLines += 1;
      files.add(file);
      const lineFindings = scanAddedLine(line.slice(1), file, nextLine);
      for (const finding of lineFindings) {
        totalFindings += 1;
        findingFiles.add(finding.file);
        if (findings.length < MAX_REPORTED_FINDINGS) findings.push(finding);
      }
      consumeNewLine();
    } else if (line.startsWith(" ")) {
      consumeNewLine();
    }
  };

  for await (const input of stream) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new SecretScanOperationalError(
        `git diff exceeded the ${maxBytes}-byte safety cap`,
      );
    }
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.end();
  if (pending) consume(pending);

  return {
    bytes,
    addedLines,
    files: files.size,
    findings,
    totalFindings,
    omittedFindings: totalFindings - findings.length,
    findingFiles: findingFiles.size,
  };
}

function spawnGit(args, cwd) {
  return spawn("git", args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Capture bounded Git stdout or convert resolution failures to scanner errors. */
async function captureGit(args, cwd, maxBytes = 4 * 1024) {
  const child = spawnGit(args, cwd);
  const chunks = [];
  let bytes = 0;
  let spawnError = null;
  const closed = new Promise((resolveClose) => {
    child.once("close", (closeCode, signal) => resolveClose({ code: closeCode, signal }));
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  for await (const chunk of child.stdout) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      child.kill();
      throw new SecretScanOperationalError("git returned an unexpectedly large revision");
    }
    chunks.push(chunk);
  }
  const { code } = await closed;
  if (spawnError || code !== 0) throw new SecretScanOperationalError("git could not resolve the requested base");
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Validate a user-supplied Git revision without allowing option injection. */
function validateBaseRef(value) {
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new SecretScanOperationalError("the base revision is invalid");
  }
  const ref = String(value);
  if (
    ref.length < 1 ||
    ref.length > 256 ||
    ref.startsWith("-") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]*$/.test(ref)
  ) {
    throw new SecretScanOperationalError("the base revision is invalid");
  }
  return ref;
}

/** Build the bounded Git diff arguments for staged or merge-base scanning. */
async function diffArgsForMode(mode, cwd) {
  const common = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--unified=0",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  if (mode.type === "staged") return [...common, "--cached", "--"];

  const base = validateBaseRef(mode.ref);
  const baseCommit = await captureGit(
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    cwd,
  );
  const mergeBase = await captureGit(["merge-base", baseCommit, "HEAD"], cwd);
  if (!/^[0-9a-f]{40,64}$/i.test(mergeBase)) {
    throw new SecretScanOperationalError("git returned an invalid merge base");
  }
  return [...common, `${mergeBase}..HEAD`, "--"];
}

/** Scan added lines in a repository diff and return redacted findings. */
export async function scanRepository({
  cwd = process.cwd(),
  mode = { type: "staged" },
  maxBytes = DEFAULT_DIFF_MAX_BYTES,
} = {}) {
  const args = await diffArgsForMode(mode, cwd);
  const child = spawnGit(args, cwd);
  let spawnError = null;
  const closed = new Promise((resolveClose) => {
    child.once("close", (closeCode, signal) => resolveClose({ code: closeCode, signal }));
  });
  child.once("error", (error) => {
    spawnError = error;
  });

  try {
    const report = await scanDiffStream(child.stdout, { maxBytes });
    const { code } = await closed;
    if (spawnError || code !== 0) throw new SecretScanOperationalError("git diff failed");
    return { ...report, mode: mode.type === "staged" ? "staged" : `base:${mode.ref}` };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error instanceof SecretScanOperationalError
      ? error
      : new SecretScanOperationalError("git diff could not be scanned");
  }
}

/** Parse the supported command-line options for the secret scanner. */
function parseCliArgs(argv) {
  if (argv.length === 0) return { mode: { type: "staged" } };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  if (argv.length === 2 && argv[0] === "--base") {
    return { mode: { type: "base", ref: validateBaseRef(argv[1]) } };
  }
  throw new SecretScanOperationalError("usage: check-secrets [--base <revision>]");
}

/** Execute the scanner CLI and return its process exit code. */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = console.log,
  stderr = console.error,
} = {}) {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      stdout(
        `Usage: check-secrets [--base <revision>] (default: staged diff; branch mode: merge-base..HEAD; 16 MiB fail-closed cap; at most ${MAX_REPORTED_FINDINGS} findings printed)`,
      );
      return 0;
    }
    const report = await scanRepository({ cwd, mode: parsed.mode });
    if (report.totalFindings === 0) {
      stdout(`Secret scan passed (${report.mode}): ${report.addedLines} added line(s) scanned.`);
      return 0;
    }
    for (const finding of report.findings) {
      stderr(`${finding.file}:${finding.line} potential secret (${finding.rule}); value redacted`);
    }
    const omitted =
      report.omittedFindings > 0
        ? ` ${report.omittedFindings} additional finding(s) omitted from output;`
        : "";
    stderr(
      `Secret scan blocked: ${report.totalFindings} finding(s) in ${report.findingFiles} file(s);${omitted} remove or replace them, then retry.`,
    );
    return 1;
  } catch (error) {
    const message = error instanceof SecretScanOperationalError ? error.message : "unexpected scanner failure";
    stderr(`Secret scan failed: ${message}. No file contents were printed.`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
