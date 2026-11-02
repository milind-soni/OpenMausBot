// A macOS app launched from Finder inherits a bare PATH (no ~/.local/bin, /opt/homebrew/bin or nvm/volta/asdf shims),
// so every agent CLI spawn goes through augmentedPath().
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";

function nvmBinDirs(): string[] {
  try {
    const base = join(homedir(), ".nvm", "versions", "node");
    return readdirSync(base)
      .filter((v) => v.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(base, v, "bin"));
  } catch {
    return [];
  }
}

/** A sealed test fixture sees only its own PATH, OMB_EXTRA_PATH, app-managed dirs and its temporary home, never this machine's CLIs or keychain. */
export function sealedFixture(): boolean {
  return process.env.OMB_TEST_SEALED_PATH === "1";
}

function knownDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"), // claude installer default
    join(home, ".npm-global", "bin"), // npm prefix ~/.npm-global (claude, opencode)
    join(home, ".kimi-code", "bin"), // kimi-code installer
    join(home, ".grok", "bin"), // x.ai installer
    join(home, ".opencode", "bin"), // opencode installer
    join(home, ".claude", "local"), // claude "local install"
    ...(sealedFixture() ? [] : [
      "/opt/homebrew/bin", // brew, Apple silicon
      "/usr/local/bin", // brew Intel / classic installs
    ]),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"), // mise installer
    join(home, ".deno", "bin"),
    join(home, "bin"),
    ...nvmBinDirs(),
  ];
}

/** Windows never pushes PATH changes into a live process, so CLIs installed after launch are found by scanning install dirs. */
function windowsKnownDirs(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  return [
    join(appData, "npm"), // npm -g shims: claude, codex
    join(home, ".kimi-code", "bin"), // recover Kimi installs after a GUI launch too
    join(home, ".grok", "bin"), // x.ai installer
    join(localAppData, "agy", "bin"), // Antigravity installer
    // Cursor installer: cursor-agent.* and its `agent` copies
    join(localAppData, "cursor-agent"),
    join(home, ".local", "bin"), // claude native installer
    join(home, ".claude", "local"),
    join(home, "bin"), // Factory droid installer (%USERPROFILE%\bin)
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin"),
    join(programFiles, "Docker", "Docker", "resources", "bin"), // Docker Desktop installer
    join(programFiles, "RedHat", "Podman"), // Podman installer, also run by Podman Desktop
  ];
}

let cached: string | null = null;
let probed = false;
let loginShellPath: string | null = null;

// App-managed dirs (its own npm prefix) go first, so an engine installed there wins over an older copy.
const registeredDirs: string[] = [];

export function registerPathDir(dir: string): void {
  if (registeredDirs.includes(dir)) return;
  registeredDirs.unshift(dir);
  resetPathCache();
}

// App-installed standalone builds go last: a copy the person installs themselves, anywhere, takes over.
const fallbackDirs: string[] = [];

export function registerFallbackPathDir(dir: string): void {
  if (fallbackDirs.includes(dir)) return;
  fallbackDirs.push(dir);
  resetPathCache();
}

/** `probed` resets too, or a rescan would drop rc-file PATH entries and never probe the login shell again. */
export function resetPathCache(): void {
  cached = null;
  probed = false;
}

export function augmentedPath(): string {
  if (cached === null) {
    const fallback = fallbackDirs.filter((d) => existsSync(d));
    cached = mergePaths([
      ...registeredDirs.filter((d) => existsSync(d)),
      ...(process.env.OMB_EXTRA_PATH ? process.env.OMB_EXTRA_PATH.split(delimiter) : []),
      ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
      // Keep the last login-shell result while a rescan re-probes, or rc-only CLIs vanish for the response that triggered it.
      ...(loginShellPath ? loginShellPath.split(delimiter) : []),
      ...(process.platform === "win32" ? windowsKnownDirs() : knownDirs()).filter((d) => existsSync(d)),
    ].filter((d) => !fallback.includes(d)).concat(fallback));
  }
  if (!probed && !process.env.VITEST && !sealedFixture() && process.platform !== "win32") {
    probed = true;
    probeLoginShellPath();
  }
  return cached;
}

function mergePaths(parts: string[]): string {
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

function probeLoginShellPath(): void {
  const shell = process.env.SHELL || "/bin/zsh";
  // -l -i: nvm and friends live in .zshrc/.bashrc, which only interactive shells read; a marker isolates $PATH from rc noise.
  execFile(
    shell,
    ["-l", "-i", "-c", 'printf "__OMB_PATH__%s" "$PATH"'],
    { timeout: 5000 },
    (err, stdout) => {
      if (err || !stdout) return;
      const m = /__OMB_PATH__([^\n]*)/.exec(stdout);
      if (!m || !m[1]) return;
      loginShellPath = m[1];
      // Fallback dirs stay last, behind what the person's shell adds.
      const fallback = fallbackDirs.filter((d) => existsSync(d));
      cached = mergePaths([...(cached ?? "").split(delimiter).filter((d) => !fallback.includes(d)), ...m[1].split(delimiter), ...fallback]);
    },
  );
}

export function resetPathCacheForTests(): void {
  cached = null;
  probed = false;
  loginShellPath = null;
  registeredDirs.length = 0;
  fallbackDirs.length = 0;
}

/** Windows CLIs keep state under USERPROFILE; a HOME leaking in from a POSIX-flavoured shell is not it. */
export function userHome(env: Record<string, string | undefined> = process.env): string {
  return process.platform === "win32"
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || env.USERPROFILE || homedir();
}

export function harnessHome(name: string, env: Record<string, string | undefined> = process.env): string {
  return join(userHome(env), `.${name}`);
}

/** Every copy of `name` on `path` (the app's PATH unless given), in the order a lookup would find them. */
export function findCliCandidates(name: string, path: string = augmentedPath()): string[] {
  if (!name || /[\n\r]/.test(name)) return [];
  if (/[/\\]/.test(name) || /^[a-zA-Z]:/.test(name)) return [name];
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const out: string[] = [];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

// Windows: libuv ignores PATHEXT, Node refuses to spawn a .cmd without shell:true since CVE-2024-27980, and there is no #!.
// shell:true is out (cmd would mangle the JSON drivers pass in argv), so npm .cmd shims resolve to what they wrap, node
// shebang scripts to `node <script>`, and a PowerShell -File .cmd to powershell.exe plus its sibling .ps1. An unknown
// shim stays the .cmd rather than cross the no-shell security boundary.

export interface ResolvedSpawn {
  command: string;
  args: string[];
}

/** A mini tokenizer, never a shell: quotes group segments; no escapes, no substitution, nothing evaluated. */
export function splitCliString(cli: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cli.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function whichWin(cli: string, env?: NodeJS.ProcessEnv): string | null {
  const exts = ((env ?? process.env).PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // npm installs both `claude` (a sh script) and `claude.cmd`; an extensionless name is not runnable on Windows.
  const probe = (base: string) => {
    const order = extname(base) ? [base, ...exts.map((e) => base + e)] : [...exts.map((e) => base + e), base];
    return order.find(isFile) ?? null;
  };
  if (/[\\/]/.test(cli) || /^[a-zA-Z]:/.test(cli)) return probe(cli);
  const path = env ? (env.PATH ?? env.Path ?? "") : augmentedPath();
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const hit = probe(join(dir, cli));
    if (hit) return hit;
  }
  return null;
}

/** In a packaged app process.execPath is Electron and must never be mistaken for node.exe. */
function nodeExe(near: string, env?: NodeJS.ProcessEnv): string | null {
  const local = join(near, "node.exe");
  if (isFile(local)) return local;
  const onPath = whichWin("node.exe", env);
  if (onPath && extname(onPath).toLowerCase() === ".exe") return onPath;
  return (process.versions as Record<string, string | undefined>).electron ? null : process.execPath;
}

const POWERSHELL_NAMES = new Set(["powershell.exe", "pwsh.exe"]);
const POWERSHELL_COMMAND_SWITCHES = new Set(["c", "command", "e", "ec", "enc", "encodedcommand"]);

/** `-Command` / `-c` / `-EncodedCommand` (and `/c`) run before `-File`, so that line is not a script launch. */
function isPowerShellCommandSwitch(token: string): boolean {
  let name = token.startsWith("-") || token.startsWith("/") ? token.slice(1) : token;
  const colon = name.indexOf(":");
  if (colon >= 0) name = name.slice(0, colon);
  return POWERSHELL_COMMAND_SWITCHES.has(name.toLowerCase());
}

function windowsSystemRoot(env?: NodeJS.ProcessEnv): string {
  const source = env ?? process.env;
  return source.SystemRoot || source.WINDIR || process.env.SystemRoot || process.env.WINDIR || "";
}

/** Only `%SystemRoot%` and `%WINDIR%` expand, and only in the executable token. */
function expandWindowsRoot(token: string, env?: NodeJS.ProcessEnv): string {
  const root = windowsSystemRoot(env);
  return token.replace(/%SystemRoot%/gi, () => root).replace(/%WINDIR%/gi, () => root);
}

function powerShellExecutable(token: string, env?: NodeJS.ProcessEnv): string | null {
  const expanded = expandWindowsRoot(token, env);
  if (!POWERSHELL_NAMES.has(basename(expanded).toLowerCase())) return null;
  if (/[\\/]/.test(expanded) || /^[a-zA-Z]:/.test(expanded)) {
    return extname(expanded).toLowerCase() === ".exe" && isFile(expanded) ? expanded : null;
  }
  const hit = whichWin(expanded, env);
  return hit && extname(hit).toLowerCase() === ".exe" ? hit : null;
}

/** `%SCRIPT_DIR%` and `%~dp0` are the shim directory. A remaining `%VAR%`, `..`, or another directory does not count. */
function siblingPowerShellScript(operand: string, shimDir: string): string | null {
  const prefix = /^(?:%SCRIPT_DIR%|%~dp0)\\?/i.exec(operand);
  if (!prefix && /%[^%]+%/.test(operand)) return null;
  const rest = prefix ? operand.slice(prefix[0].length) : operand;
  if (/%[^%]+%/.test(rest)) return null;
  const absolute = /^[a-zA-Z]:[\\/]/.test(rest) || rest.startsWith("\\\\");
  if (!prefix && !absolute) return null;
  const script = prefix ? join(shimDir, rest) : rest;
  if (extname(script).toLowerCase() !== ".ps1" || !isFile(script)) return null;
  if (dirname(script).toLowerCase() !== shimDir.toLowerCase()) return null;
  return script;
}

/** `-Command` is not a spawn. The first `-File` whose `.ps1` sits beside the shim is. */
function parsePowerShellFileShim(shim: string, text: string, env?: NodeJS.ProcessEnv): ResolvedSpawn | null {
  const shimDir = dirname(shim);
  for (const line of text.split(/\r?\n/)) {
    const tokens = splitCliString(line);
    const head = tokens[0];
    if (!head || tokens.length < 3) continue;
    const command = powerShellExecutable(head, env);
    if (!command) continue;
    const rest = tokens.slice(1);
    if (rest.some(isPowerShellCommandSwitch)) continue;
    const fileAt = rest.findIndex((token) => token.toLowerCase() === "-file");
    const operand = fileAt >= 0 ? rest[fileAt + 1] : undefined;
    if (!operand) continue;
    const script = siblingPowerShellScript(operand, shimDir);
    if (!script) continue;
    const args: string[] = [];
    for (let index = 0; index < rest.length; index++) {
      const token = rest[index];
      if (!token || token === "%*") continue;
      args.push(index === fileAt + 1 ? script : token);
    }
    return { command, args };
  }
  return null;
}

/** npm/pnpm .cmd shims spell their target as "%dp0%\..." (or "%~dp0\..."). A PowerShell `-File` launcher is spawnable only for a sibling `.ps1`. */
function parseCmdShim(shim: string, env?: NodeJS.ProcessEnv): ResolvedSpawn | null {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shim);
  // npm's own npm.cmd/npx.cmd name their entry as SET "NPX_CLI_JS=%~dp0\…"; a launcher switch to a global npm is not followed.
  const npmEntry = /^SET "NP[MX]_CLI_JS=%~dp0\\([^"]+)"/im.exec(text);
  const targets = [...(npmEntry ? [npmEntry] : []), ...text.matchAll(/"%~?dp0%?\\?([^"]+)"/g)]
    .map((m) => join(dir, m[1]))
    .filter((p) => isFile(p) && basename(p).toLowerCase() !== "node.exe");
  const script = targets.find((p) => /\.[cm]?js$/i.test(p));
  if (script) {
    const node = nodeExe(dir, env);
    if (node) return { command: node, args: [script] };
  }
  const exe = targets.find((p) => extname(p).toLowerCase() === ".exe");
  if (exe) return { command: exe, args: [] };
  for (const target of targets) {
    const viaNode = parseNodeShebang(target, env);
    if (viaNode) return viaNode;
  }
  return parsePowerShellFileShim(shim, text, env);
}

function parseNodeShebang(file: string, env?: NodeJS.ProcessEnv): ResolvedSpawn | null {
  let head = "";
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
  if (!/^#!.*\bnode(\.exe)?\b/.test(head)) return null;
  const node = nodeExe(dirname(file), env);
  return node ? { command: node, args: [file] } : null;
}

/** One command word's platform spawn rules: identity except on win32, since POSIX resolves PATH and #! itself. */
function resolveWord(cli: string, args: string[], env?: NodeJS.ProcessEnv): ResolvedSpawn {
  if (process.platform !== "win32") return { command: cli, args };
  const file = whichWin(cli, env);
  if (!file) return { command: cli, args };
  const ext = extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const direct = parseCmdShim(file, env);
    return direct ? { command: direct.command, args: [...direct.args, ...args] } : { command: file, args };
  }
  if (ext === ".exe" || ext === ".com") return { command: file, args };
  const viaNode = parseNodeShebang(file, env);
  return viaNode ? { command: viaNode.command, args: [...viaNode.args, ...args] } : { command: file, args };
}

export function resolveCliSpawn(cli: string, args: string[], env?: NodeJS.ProcessEnv): ResolvedSpawn {
  // An existing file wins over the tokenizer: candidate paths with spaces arrive unquoted.
  const trimmed = cli.trim();
  if (trimmed.includes(" ") && existsSync(trimmed)) return resolveWord(trimmed, args, env);
  // One tokenizer pass; the head is never re-split, and fixed args go first so a wrapper's subcommand leads.
  const split = splitCliString(cli);
  if (split.length > 1 || split[0] !== trimmed) {
    const [head, ...fixed] = split;
    if (!head) return { command: cli, args };
    return resolveWord(head, [...fixed, ...args], env);
  }
  return resolveWord(cli, args, env);
}
