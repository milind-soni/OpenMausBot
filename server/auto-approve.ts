// Auto mode: when a bot may answer its own permission requests.
//
// Two ways in — the bot is in auto mode, or the user pressed "Always
// allow" for that one tool — and one way out: anything that reads as
// destructive stops and asks a human anyway.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { AccessProfile } from "./access-profile.ts";

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

// The full-task-scoped profile is intentionally much broader than the
// standard profile. These are its only two refusal classes. Ordinary scoped
// deletes, force pushes, hard resets, deploys and external writes are not in
// this list.
const CATASTROPHIC = [
  /\b(?:mkfs(?:\.[\w-]+)?|newfs(?:_[\w-]+)?)\b/i,
  /\bdiskutil\s+(?:erase|partition|apfs\s+deleteContainer|secureErase)\w*/i,
  /\bdd\s+[^|\n]*\bof=\s*['"]?\/dev\/(?:disk|rdisk|sd|nvme)/i,
  /\b(?:rm|unlink)\s+[^|\n]*-[a-z]*r[a-z]*f[a-z]*\s+(?:--\s+)?(?:['"]?(?:\/|~|\.\.?|\$HOME|\$\{HOME\}|\/Users(?:\/[^/\s'";]+)?|\/System|\/Library|\/Applications|\/Volumes|\/private)['"]?)(?:\s|$|[;&])/i,
  /\b(?:shutil\.rmtree|fs\.rmSync|fs\.rm)\s*\(\s*['"](?:\/|~|\.|\.\.|\/Users(?:\/[^/'"]+)?|\/System|\/Library|\/Applications)['"]/i,
  /\b(?:FileUtils\.)?rm_r[f]?\s*\(?\s*['"](?:\/|~|\.|\.\.|\/Users(?:\/[^/'"]+)?|\/System|\/Library|\/Applications)['"]/i,
  /\b(?:File::Path::)?remove_tree\s*\(?\s*['"](?:\/|~|\.|\.\.|\/Users(?:\/[^/'"]+)?|\/System|\/Library|\/Applications)['"]/i,
  /\b(?:shutdown|reboot|halt)\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/,
  /\bDROP\s+(?:DATABASE|SCHEMA)\b/i,
  /\b(?:terraform\s+destroy|pulumi\s+destroy)\b/i,
  /\bkubectl\s+delete\s+(?:namespace|cluster|customresourcedefinition)\b/i,
  /\bgh\s+(?:repo|api)\s+delete\b/i,
  /\b(?:gcloud\s+projects|aws\s+organizations|supabase\s+projects?)\s+delete\b/i,
  /\b(?:delete|destroy|remove|drop)[_\s-]*(?:entire[_\s-]*)?(?:repository|repo|account|project|organization|org|production[_\s-]*(?:database|datastore))\b/i,
  /\b(?:repository|repo|account|project|organization|org|production[_\s-]*(?:database|datastore))[_\s-]*(?:delete|destroy|remove|drop)\b/i,
  /\bfind\s+(?:\/|~|\$HOME|\$\{HOME\}|\/Users(?:\/[^/\s'"]+)?)\s+[^\n|;]*-delete\b/i,
  /\bRemove-Item\s+(?:['"]?[A-Z]:\\?['"]?|['"]?\\\\[^\s'"]+['"]?)\s+[^\n|;]*(?:-Recurse[^\n|;]*-Force|-Force[^\n|;]*-Recurse)\b/i,
  /\b(?:format\s+[A-Z]:|diskpart\b[^\n]*(?:clean|delete\s+(?:disk|volume)))\b/i,
  /\bln\s+-s\s+(?:\/|~|\$HOME|\$\{HOME\})\s+[^;&|]+[;&|]+[^\n]*\brm\s+[^\n]*-[a-z]*r[a-z]*f/i,
];

const CREDENTIAL_VALUE_DISCLOSURE = [
  /\b(?:credvault|cv|vault)\s+(?:get|read|resolve|reveal|show|export|dump|decrypt|print)\b/i,
  /\b(?:credvault-mcp|credvault-mcp-wrapped|mcp__credvault__)/i,
  /(?:^|[\s/'"])(?:\.credvault|\.config\/credvault|Library\/.*CredVault)(?:\/|[\s'"]|$)/i,
  /(?:^|[\s/'"])(?:Library\/Keychains|Library\/.*\/(?:Cookies|Login Data)|\.config\/(?:gcloud|gh|glab)|\.kube\/config)(?:\/|[\s'"]|$)/i,
  /\bsecurity\s+find-(?:generic|internet)-password\b/i,
  /(?:^|[\n;&|])\s*(?:\/usr\/bin\/)?printenv\b/im,
  /(?:^|[\n;&|])\s*(?:\/usr\/bin\/)?env\s*(?:$|[;&|])/im,
  /(?:^|[\n;&|])\s*(?:export\s+-p|declare\s+-x|set)\s*(?:$|[;&|])/im,
  /\b(?:Get-ChildItem|gci|dir)\s+Env:\\?/i,
  /\bps\s+(?:-[^\n]*e|[^\n]*\beww\b)/i,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\b/i,
  /\b(?:cat|sed|awk|perl|python\w*|node)\b[^\n]*(?:\.env(?:\.|\s|$)|\.ssh\/|\.aws\/credentials|\.netrc|\.npmrc|auth\.json|credentials?\.json)/i,
  /\b(?:get|read|resolve|reveal|show|export|dump|decrypt|print)[_\s-]*(?:secret|credential|credential[_\s-]*value|vault[_\s-]*value)\b/i,
  /\b(?:secret|credential|vault)[_\s-]*(?:get|read|resolve|reveal|show|export|dump|decrypt|print)\b/i,
  /\b(?:os\.environ|process\.env|Deno\.env|System\.getenv)\b/i,
  /\/proc\/(?:self|\d+)\/environ\b/i,
  /\b(?:launchctl\s+getenv|systemctl\s+show-environment)\b/i,
  /\bps\s+(?:auxe|e(?:ww|f)?|-[^\n]*e)\b/i,
  /\b(?:gh|glab)\s+auth\s+token\b|\bgcloud\s+auth\s+print-(?:access|identity)-token\b/i,
  /\b(?:pass|op)\s+(?:show|read|item\s+get)\b/i,
  /\b(?:secret-tool\s+lookup|kwallet-query\b[^\n]*(?:read-password|-r\b))/i,
  /\b(?:Keychain Access|chrome:\/\/(?:settings\/(?:passwords|cookies)|password-manager)|passwords\.google\.com|1Password|Bitwarden|LastPass|Dashlane)\b/i,
];

const CREDENTIAL_STORE_PATH = [
  /(?:^|[\s/'"\\])\.codex[\\/]auth\.json(?:[\s'"\\]|$)/i,
  /(?:^|[\s/'"\\])\.claude(?:\.json|[\\/](?:settings\.json|credentials?(?:\.json)?))(?:[\s'"\\]|$)/i,
  /(?:^|[\s/'"\\])\.(?:pi[\\/]agent[\\/]auth\.json|grok[\\/]auth\.json|gemini[\\/]oauth_creds\.json|factory[\\/](?:auth\.v2\.(?:file|loginkeychain|keyring)|settings\.json))(?:[\s'"\\]|$)/i,
  /(?:^|[\s/'"\\])opencode[\\/]auth\.json(?:[\s'"\\]|$)/i,
  /(?:^|[\s/'"\\])\.(?:aws[\\/]credentials|ssh[\\/](?:id_[^\s/'"\\]+|authorized_keys)|docker[\\/]config\.json|kube[\\/]config|netrc|npmrc|pypirc)(?:[\s'"\\]|$)/i,
  /(?:^|[\s/'"\\])\.config[\\/](?:credvault|gcloud|gh[\\/]hosts\.yml|glab-cli[\\/]config\.yml)(?:[\\/\s'"\\]|$)/i,
  /(?:^|[\s/'"\\])\.credvault(?:[\\/\s'"\\]|$)/i,
  /Library[\\/]Keychains(?:[\\/\s'"\\]|$)/i,
  /Library[\\/]Application Support[\\/](?:openmausbot[\\/]credentials\.bin|(?:Google[\\/]Chrome|Chromium|Microsoft Edge|BraveSoftware|Firefox|Safari|1Password|Bitwarden)[^\n]{0,180}[\\/](?:Cookies|Login Data|Web Data|logins\.json|key4\.db|Cookies\.binarycookies))(?:[\s'"\\]|$)/i,
  /\.openmausbot[\\/](?:config\.json|runtime[\\/]capability-gateway\.json)(?:[\s'"\\]|$)/i,
  /(?:^|[\s/'"\\])\.env(?:\.[^\s/'"\\]+)?(?:[\s'"\\]|$)/i,
  /[\\/]proc[\\/](?:self|\d+)[\\/]environ(?:[\s'"\\]|$)/i,
];

const MAX_SAFETY_TEXT = 100_000;
const MAX_SAFETY_VARIANTS = 128;
const MAX_SAFETY_ROUNDS = 4;
const MAX_STRUCTURED_SAFETY_VALUES = 32;

function printableText(text: string): string | null {
  if (!text.length || text.length > MAX_SAFETY_TEXT || text.includes("\u0000")) return null;
  const printable = [...text].filter((char) => /[\t\n\r\x20-\x7e]/.test(char)).length;
  return printable / Math.max(1, text.length) >= 0.9 ? text : null;
}

function printableDecoded(value: Buffer): string[] {
  if (!value.length || value.length > MAX_SAFETY_TEXT) return [];
  const decoded = new Set<string>();
  const utf8 = printableText(value.toString("utf8"));
  if (utf8) decoded.add(utf8);
  if (value.length % 2 === 0) {
    const little = printableText(value.toString("utf16le"));
    if (little) decoded.add(little);
    const swapped = Buffer.allocUnsafe(value.length);
    for (let i = 0; i < value.length; i += 2) {
      swapped[i] = value[i + 1]!;
      swapped[i + 1] = value[i]!;
    }
    const big = printableText(swapped.toString("utf16le"));
    if (big) decoded.add(big);
  }
  return [...decoded];
}

function codePointText(hex: string): string {
  const value = Number.parseInt(hex, 16);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function decodeEscapes(text: string): string {
  return text
    .replace(/%u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#x([0-9a-f]{2,6});?/gi, (_match, hex: string) => codePointText(hex))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, hex: string) => codePointText(hex))
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([0-7]{2,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function quotedValue(token: string): string {
  return decodeEscapes(token.slice(1, -1));
}

/** Fold only explicit string construction, not whitespace-separated shell
 * arguments. This catches Python/JS/Ruby/Perl `"rm " + "-rf " + "/"` and
 * shell-adjacent `'r''m'` without turning `echo "rm" "-rf" "/"` into a
 * deletion that command would never execute. */
function constructedStrings(text: string): string[] {
  const quoted = [...text.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)];
  const out: string[] = [];
  for (let start = 0; start < quoted.length; start += 1) {
    let joined = quotedValue(quoted[start]![0]);
    let end = quoted[start]!.index! + quoted[start]![0].length;
    for (let next = start + 1; next < quoted.length; next += 1) {
      const gap = text.slice(end, quoted[next]!.index!);
      if (!(gap === "" || /^\s*(?:\+|\.)\s*$/.test(gap))) break;
      joined += quotedValue(quoted[next]![0]);
      end = quoted[next]!.index! + quoted[next]![0].length;
      if (joined.length <= MAX_SAFETY_TEXT) out.push(joined);
    }
  }

  // argv arrays hide executable words behind commas:
  // subprocess.run(["rm", "-rf", "/"]) / spawn("rm", ["-rf", "/"]).
  for (const match of text.matchAll(/\[([^\]\n]{1,20000})\]/g)) {
    const prefix = text.slice(Math.max(0, match.index! - 500), match.index!);
    if (!/(?:subprocess\.(?:run|call|check_call|check_output|Popen)|child_process\.(?:spawn|spawnSync|execFile|execFileSync)|\b(?:spawn|spawnSync|execFile|execFileSync))\s*\([^)]*$/i.test(prefix)) continue;
    const values = [...match[1].matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)].map((item) => quotedValue(item[0]));
    const command = [...prefix.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)].at(-1);
    if (command) values.unshift(quotedValue(command[0]));
    if (values.length >= 2) out.push(values.join(" "));
  }
  for (const match of text.matchAll(/%w\[([^\]\n]{1,20000})\]/g)) out.push(match[1].trim());
  for (const match of text.matchAll(/%w\(([^)\n]{1,20000})\)/g)) out.push(match[1].trim());
  return out;
}

function numericCharacterStrings(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:String\.)?fromCharCode\s*\(([^)]{1,20000})\)/gi)) {
    const values = match[1].split(",").map((item) => Number(item.trim()));
    if (values.length && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0x10ffff)) {
      out.push(String.fromCodePoint(...values));
    }
  }
  for (const match of text.matchAll(/(?:chr\s*\(\s*\d{1,7}\s*\)\s*(?:\+|\.)\s*)+chr\s*\(\s*\d{1,7}\s*\)/gi)) {
    const values = [...match[0].matchAll(/chr\s*\(\s*(\d{1,7})\s*\)/gi)].map((item) => Number(item[1]));
    if (values.every((value) => value >= 0 && value <= 0x10ffff)) out.push(String.fromCodePoint(...values));
  }
  for (const match of text.matchAll(/(?:\[char\]\s*\d{1,7}\s*\+\s*)+\[char\]\s*\d{1,7}/gi)) {
    const values = [...match[0].matchAll(/\[char\]\s*(\d{1,7})/gi)].map((item) => Number(item[1]));
    if (values.every((value) => value >= 0 && value <= 0x10ffff)) out.push(String.fromCodePoint(...values));
  }
  return out;
}

function wrappedPayloads(text: string): string[] {
  const out: string[] = [];
  const wrappers = [
    /\b(?:ba|z|da|k)?sh\b[^\n;&|]{0,160}?-(?:c|lc)\s+(["'])([\s\S]{1,20000}?)\1/gi,
    /\b(?:python\w*|node|ruby|perl)\b[^\n;&|]{0,160}?-(?:c|e)\s+(["'])([\s\S]{1,20000}?)\1/gi,
    /\b(?:powershell|pwsh)\b[^\n;&|]{0,160}?-(?:command|c)\s+(["'])([\s\S]{1,20000}?)\1/gi,
    /\b(?:eval|exec|system|popen|execSync|spawnSync)\s*\(\s*(["'])([\s\S]{1,20000}?)\1/gi,
  ];
  for (const wrapper of wrappers) for (const match of text.matchAll(wrapper)) out.push(decodeEscapes(match[2]));
  return out;
}

function base64Decoded(token: string): string[] {
  const raw = token.replace(/^['"]|['"]$/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (raw.length < 8 || raw.length > MAX_SAFETY_TEXT * 2 || raw.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return [];
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  try {
    return printableDecoded(Buffer.from(padded, "base64"));
  } catch {
    return [];
  }
}

function hexDecoded(token: string): string[] {
  const raw = token.replace(/^0x/i, "");
  if (raw.length < 12 || raw.length > MAX_SAFETY_TEXT * 2 || raw.length % 2 || !/^[0-9a-f]+$/i.test(raw)) return [];
  try {
    return printableDecoded(Buffer.from(raw, "hex"));
  } catch {
    return [];
  }
}

interface SafetyAnalysis {
  variants: string[];
  opaqueExecution: boolean;
}

function analyzeSafetyText(text: string): SafetyAnalysis {
  const variants = new Set<string>([text.slice(0, MAX_SAFETY_TEXT)]);
  let saturated = text.length > MAX_SAFETY_TEXT;
  let decodedPayloads = 0;
  let encodedCandidates = 0;
  const add = (value: string | null | undefined): void => {
    if (!value || variants.has(value)) return;
    if (variants.size >= MAX_SAFETY_VARIANTS || value.length > MAX_SAFETY_TEXT) {
      saturated = true;
      return;
    }
    variants.add(value);
  };

  for (let round = 0; round < MAX_SAFETY_ROUNDS; round += 1) {
    const before = variants.size;
    for (const current of [...variants]) {
      if (/%(?:[0-9a-f]{2}|u[0-9a-f]{4})/i.test(current)) {
        try {
          add(decodeURIComponent(current));
          add(decodeURIComponent(current.replace(/\+/g, "%20")));
        } catch {}
      }
      add(decodeEscapes(current));
      for (const value of constructedStrings(current)) add(value);
      for (const value of numericCharacterStrings(current)) add(value);
      for (const value of wrappedPayloads(current)) add(value);

      for (const match of current.matchAll(/(?:^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{8,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/g)) {
        encodedCandidates += 1;
        const decoded = base64Decoded(match[1]);
        decodedPayloads += decoded.length ? 1 : 0;
        for (const value of decoded) add(value);
      }
      for (const match of current.matchAll(/(?:^|[^0-9a-f])((?:0x)?[0-9a-f]{12,})(?=$|[^0-9a-f])/gi)) {
        encodedCandidates += 1;
        const decoded = hexDecoded(match[1]);
        decodedPayloads += decoded.length ? 1 : 0;
        for (const value of decoded) add(value);
      }
    }
    if (variants.size === before) break;
  }

  const executionSink = /(?:\|\s*(?:ba|z|da|k)?sh\b|\b(?:ba|z|da|k)?sh\b[^\n;&|]{0,160}?-(?:c|lc)\b|\b(?:python\w*|node|ruby|perl)\b[^\n;&|]{0,160}?-(?:c|e)\b|\b(?:powershell|pwsh)\b[^\n;&|]{0,160}?-(?:encodedcommand|enc|command|c)\b|\b(?:eval|exec|system|popen|execSync|spawnSync)\s*\()/i.test(text);
  const encodedIndirection = /(?:base64\b[^\n;&|]{0,80}(?:-d|--decode)|\b(?:atob|fromhex|decodeURIComponent)\s*\(|Buffer\.from\b[^\n]{0,160}['"](?:base64|hex)['"]|\bxxd\s+-r\s+-p\b|-(?:encodedcommand|enc)\b|\\x[0-9a-f]{2}|%[0-9a-f]{2})/i.test(text);
  const opaqueVariableWrapper = /(?:\b(?:ba|z|da|k)?sh\b[^\n;&|]{0,160}?-(?:c|lc)|\b(?:python\w*|node|ruby|perl)\b[^\n;&|]{0,160}?-(?:c|e)|\b(?:eval|exec|system|popen|execSync|spawnSync)\s*\()\s*["']?\s*(?:\$\{?[A-Za-z_]|[A-Za-z_]\w*\s*\))/i.test(text);
  return {
    variants: [...variants],
    opaqueExecution: saturated || opaqueVariableWrapper || (executionSink && encodedIndirection && (encodedCandidates === 0 || decodedPayloads === 0)),
  };
}

/** Expand common command-obfuscation wrappers before classification. This is
 * intentionally bounded and deterministic; it covers shell/Python wrappers,
 * percent escapes, base64, hex, and JS/Python-style character escapes without
 * executing the candidate text. */
export function safetyTextVariants(text: string): string[] {
  return analyzeSafetyText(text).variants;
}

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

function matchSafety(rules: RegExp[], text: string): string | null {
  for (const variant of safetyTextVariants(text)) {
    const match = matchFirst(rules, variant);
    if (match) return match;
  }
  return null;
}

function commandTokens(text: string): string[] {
  return [...text.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]+/g)].map((match) =>
    match[0].replace(/^(?:"|')|(?:"|')$/g, ""),
  );
}

function resolveCandidatePath(candidate: string, cwd?: string): string | null {
  const clean = candidate.replace(/[),]+$/, "").trim();
  if (!clean) return null;
  // A glob expands children of its non-glob parent. Classify that parent so
  // broad targets such as /* and /Users/* cannot disappear from the guard,
  // while scoped targets such as build/* continue to resolve inside the cwd.
  // A basename-only glob has no written parent, so its parent is the cwd.
  const glob = clean.search(/[*?{}[\]]/);
  const target = glob === -1
    ? clean
    : clean.slice(0, glob).replace(/[^/\\]*$/, "") || ".";
  if (!target) return null;
  const base = cwd || process.cwd();
  const expanded = target
    .replace(/^~(?=\/|$)/, homedir())
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, homedir())
    .replace(/^\$(?:PWD|\{PWD\})(?=\/|$)/, base);
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
  try {
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  } catch {
    return absolute;
  }
}

function isWholeRepository(path: string): boolean {
  return existsSync(join(path, ".git"));
}

const BROAD_FILESYSTEM_ROOTS = (() => {
  const canonical = (candidate: string): string => {
    const absolute = resolve(candidate);
    try {
      return existsSync(absolute) ? realpathSync(absolute) : absolute;
    } catch {
      return absolute;
    }
  };
  return {
    canonical,
    roots: new Set([
      canonical("/"),
      canonical(homedir()),
      ...["/Applications", "/Library", "/System", "/Users", "/Volumes", "/etc", "/opt", "/private", "/tmp", "/usr", "/var"].map(canonical),
    ]),
  };
})();

function isBroadFilesystemRoot(path: string): boolean {
  const absolute = BROAD_FILESYSTEM_ROOTS.canonical(path);
  if (BROAD_FILESYSTEM_ROOTS.roots.has(absolute)) return true;
  if (/^\/Volumes\/[^/]+$/.test(absolute)) return true;
  return /^[A-Za-z]:[\\/]?$/.test(absolute) || /^\\\\[^\\]+\\[^\\]+[\\/]?$/.test(absolute);
}

/** Filesystem-aware half of the catastrophic boundary. Pattern matching can
 * recognize broad roots, but only resolution against the active cwd can tell
 * that `rm -rf .`, a worktree path, or a wrapped filesystem-tool argument is
 * the deletion of an entire repository rather than a scoped directory. */
export function targetsCatastrophicFilesystem(
  tool: string,
  text: string,
  cwd?: string,
  variants: readonly string[] = safetyTextVariants(text),
): boolean {
  const deletionTool = /(?:delete|remove|unlink|rmtree|rm)(?:_|-)?(?:directory|folder|tree|path|repo(?:sitory)?)?/i.test(tool);
  for (const variant of variants) {
    const candidates: string[] = [];
    for (const match of variant.matchAll(/\brm\s+([^\n;&|]+)/gi)) {
      const tokens = commandTokens(match[1]);
      if (!tokens.some((token) => /^-[^-]*r/i.test(token) || token === "--recursive")) continue;
      candidates.push(...tokens.filter((token) => !token.startsWith("-")));
    }
    for (const match of variant.matchAll(/(?:shutil\.rmtree|fs\.rmSync|fs\.rm)\s*\(\s*(["'][^"']+["'])/gi)) {
      candidates.push(match[1]);
    }
    if (deletionTool) {
      for (const match of variant.matchAll(/(?:"(?:path|target|directory|repo(?:sitory)?)"\s*:\s*)?(["'][^"']+["'])/gi)) {
        candidates.push(match[1]);
      }
    }
    for (const candidate of candidates) {
      const path = resolveCandidatePath(candidate.replace(/^['"]|['"]$/g, ""), cwd);
      if (path && (isWholeRepository(path) || isBroadFilesystemRoot(path))) return true;
    }
  }
  return false;
}

export function looksSensitive(text: string): boolean {
  return matchFirst(SENSITIVE, text) !== null;
}

export function looksCatastrophic(text: string, cwd?: string): boolean {
  const analysis = analyzeSafetyText(text);
  return analysis.opaqueExecution ||
    analysis.variants.some((variant) => matchFirst(CATASTROPHIC, variant) !== null) ||
    targetsCatastrophicFilesystem("shell", text, cwd, analysis.variants);
}

export function looksLikeCredentialValueDisclosure(text: string): boolean {
  return matchSafety(CREDENTIAL_VALUE_DISCLOSURE, text) !== null;
}

function structuredStringValues(summary: string): string[] {
  if (
    summary.length > MAX_SAFETY_TEXT ||
    (!summary.trim().startsWith("{") && !summary.trim().startsWith("["))
  ) return [];
  try {
    const pending: unknown[] = [JSON.parse(summary)];
    const values: string[] = [];
    let visited = 0;
    const append = (items: unknown[]): void => {
      const remaining = MAX_STRUCTURED_SAFETY_VALUES - visited - pending.length;
      if (remaining > 0) pending.push(...items.slice(0, remaining));
    };
    while (pending.length && visited < MAX_STRUCTURED_SAFETY_VALUES) {
      const value = pending.shift();
      visited += 1;
      if (typeof value === "string") {
        if (value.length <= MAX_SAFETY_TEXT) values.push(value);
      } else if (Array.isArray(value)) {
        append(value);
      } else if (value && typeof value === "object") {
        append(Object.values(value));
      }
    }
    return values;
  } catch {
    return [];
  }
}

function targetsCredentialStoreRead(
  tool: string,
  summary: string,
  variants: readonly string[] = safetyTextVariants(`${tool}\n${summary}`),
): boolean {
  const readTool = /(?:^|[:_.-])(?:read|cat|show|get|resolve|reveal|export|dump|decrypt|download|copy|open|view|query|search|list|load|fetch)(?:$|[:_.-])/i.test(tool);
  const nestedReadTool = /["'](?:tool|name)["']\s*:\s*["'][^"']*(?:read|cat|show|get|resolve|reveal|export|dump|decrypt|download|copy|open|view|query|search|list|load|fetch)[^"']*["']/i.test(summary);
  const readCommand = /\b(?:cat|head|tail|less|more|sed|awk|perl|python\w*|node|cp|rsync|scp|tar|zip|base64|xxd|strings|security|sqlite3)\b/i.test(summary);
  if (!readTool && !nestedReadTool && !readCommand) return false;
  return [...variants, ...structuredStringValues(summary)]
    .some((candidate) => matchFirst(CREDENTIAL_STORE_PATH, candidate) !== null);
}

export type FullTaskScopedHardDeny = "catastrophic-destruction" | "credential-value-disclosure";

export function fullTaskScopedHardDeny(
  tool: string,
  summary: string,
  context?: { cwd?: string },
): FullTaskScopedHardDeny | null {
  const combined = `${tool}\n${summary}`;
  const analysis = analyzeSafetyText(combined);
  if (
    analysis.opaqueExecution ||
    analysis.variants.some((variant) => matchFirst(CATASTROPHIC, variant) !== null) ||
    targetsCatastrophicFilesystem(tool, summary, context?.cwd, analysis.variants)
  ) {
    return "catastrophic-destruction";
  }
  if (
    analysis.variants.some((variant) => matchFirst(CREDENTIAL_VALUE_DISCLOSURE, variant) !== null) ||
    targetsCredentialStoreRead(tool, summary, analysis.variants)
  ) {
    return "credential-value-disclosure";
  }
  return null;
}

export function looksDestructive(text: string): boolean {
  return matchFirst(DESTRUCTIVE, text) !== null;
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal"]);

export function approvalKey(tool: string, summary: string, scope?: "local-computer"): string {
  const bare = tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (!COMMAND_TOOLS.has(bare)) return scope ? `${scope}:${tool}` : tool;
  // first bare word of the command, skipping env assignments and sudo
  const words = summary.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === "sudo")) i += 1;
  const program = (words[i] ?? "").split("/").pop()?.replace(/[^\w.-]/g, "") ?? "";
  const key = program ? `${tool}:${program}` : tool;
  return scope ? `${scope}:${key}` : key;
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
  accessProfile?: AccessProfile;
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  | "catastrophic-guard"
  | "credential-value-guard"
  | "no-grant";

export interface AutoVerdict {
  /** Chip text when the bot may answer itself, null when a human decides.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    /** Working directory used to resolve `.` and repository paths. */
    cwd?: string;
  },
): AutoVerdict {
  const fullTaskScoped = bot.accessProfile === "full-task-scoped";
  // the guards outrank the grants, so an "always allow" can never widen
  // into them
  const destructiveRules = fullTaskScoped ? CATASTROPHIC : DESTRUCTIVE;
  const sensitiveRules = fullTaskScoped ? CREDENTIAL_VALUE_DISCLOSURE : SENSITIVE;
  const match = fullTaskScoped ? matchSafety : matchFirst;
  const opaqueExecution = fullTaskScoped && analyzeSafetyText(`${tool}\n${summary}`).opaqueExecution;
  const destructive = opaqueExecution
    ? "opaque-execution-indirection"
    : fullTaskScoped && targetsCatastrophicFilesystem(tool, summary, context?.cwd)
      ? "catastrophic-filesystem-target"
      : match(destructiveRules, summary) ?? match(destructiveRules, tool);
  const sensitive = destructive ? null : match(sensitiveRules, summary) ?? match(sensitiveRules, tool);
  const destructiveSource = fullTaskScoped ? ("catastrophic-guard" as const) : ("destructive-guard" as const);
  const sensitiveSource = fullTaskScoped ? ("credential-value-guard" as const) : ("sensitive-guard" as const);
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const key = approvalKey(tool, summary, context?.scope);
  const grant =
    destructive || sensitive
      ? null
      : bot.alwaysAllow?.includes(key)
        ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow" as const, rule: key }
        : bot.autoApprove
          ? { approve: `auto-approved ${tool}`, source: "auto-mode" as const, rule: undefined }
          : null;
  if (context?.unattended && !fullTaskScoped) {
    // Auto mode is something a person switched on for turns they are present
    // for. A webhook turn begins with nobody watching, on a payload someone
    // else wrote, so it does not inherit that decision — the guard above is a
    // pattern list its own comment calls "not a security boundary", and it
    // must not stand in for a human at 3am. A guard that would have carded
    // anyway keeps its own name; the block is only the story when it is the
    // thing that changed the outcome.
    if (grant) return { approve: null, source: "unattended-block", rule: grant.rule };
    if (destructive) return { approve: null, source: destructiveSource, rule: destructive };
    if (sensitive) return { approve: null, source: sensitiveSource, rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && !fullTaskScoped && !bot.autoApprove) {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: destructiveSource, rule: destructive };
    if (sensitive) return { approve: null, source: sensitiveSource, rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (destructive) return { approve: null, source: destructiveSource, rule: destructive };
  if (sensitive) return { approve: null, source: sensitiveSource, rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    cwd?: string;
  },
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}
