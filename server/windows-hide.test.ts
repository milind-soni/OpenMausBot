// A console-subsystem child spawned without windowsHide opens a visible console window on
// Windows. Every spawn/exec site in server/ and electron/ must set windowsHide (a no-op elsewhere), spread
// OWN_GROUP, or be allowlisted here with the reason it may stay as it is.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const repoRelative = (root: string, file: string, getRelative = relative): string => getRelative(root, file).replace(/\\/g, "/");
const APIS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"];

const isTestFile = (name: string): boolean =>
  /\.(test|node-test|e2e|integration|spec)\.[cm]?[jt]sx?$/.test(name) || name.endsWith(".d.ts");

function childProcessFiles(): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (!isTestFile(entry) && /\.(ts|mts|mjs)$/.test(entry) && readFileSync(path, "utf8").includes("node:child_process")) found.push(path);
    }
  };
  for (const dir of ["server", "electron"]) visit(join(ROOT, dir));
  return found;
}

/** Blank whole comment lines (keeping offsets) so prose like "spawn (oom-score.ts)" is not read as a call. */
const withoutCommentLines = (src: string): string =>
  src.split("\n").map((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") ? " ".repeat(line.length) : line;
  }).join("\n");

/** child_process entry points plus the local names bound to them (`promisify(execFile)`, `run = options.run ?? execFileAsync`, `run = execFile`). */
function trackedNames(src: string): Set<string> {
  const names = new Set(APIS);
  for (const match of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']node:child_process["']/g)) {
    for (const binding of (match[1] ?? "").split(",")) {
      const parts = binding.trim().split(/\s+as\s+/);
      if (APIS.includes(parts[0] ?? "") && parts[1]) names.add(parts[1]);
    }
  }
  for (const match of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*["']node:child_process["']/g)) {
    for (const api of APIS) names.add(`${match[1]}.${api}`);
  }
  for (let round = 0; round < 3; round++) {
    const bare = (identifier: string | undefined): boolean => identifier !== undefined && names.has(identifier);
    const aliased = (name: string | undefined, rhs: string | undefined): void => {
      if (name && !names.has(name) && bare(rhs)) names.add(name);
    };
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)(?:\s*:[^=]+)?\s*=\s*promisify\(([\w$.]+)\)/g)) aliased(m[1], m[2]);
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)(?:\s*:[^=]+)?\s*=\s*(?:[\w$.]+\s*\?\?\s*)?(\w+)\s*(?![\w(=])/g)) aliased(m[1], m[2]);
    for (const m of src.matchAll(/(?<![\w.=])(\w+)\s*=\s*(?!=)(\w+)\s*(?![\w(=])/g)) aliased(m[1], m[2]);
  }
  return names;
}

/** One entry per allowed unhidden site: `file` is repo-relative (a trailing `/` allows the whole directory), `match` picks the call when the file has several. */
const ALLOWED: Array<{ file: string; match?: string; why: string }> = [
  // Test rigs: spawn fixture servers under vitest on CI runners, never in the shipped desktop app.
  { file: "server/testing/", why: "test rig, runs under vitest only" },

  // Linux-only features and probes.
  { file: "server/bot-box/box-bridge.ts", match: "spawn(command[0]!", why: "runs inside the Linux bot box" },
  { file: "server/bot-box/box-probe.ts", match: "spawnSync(spec.engine.name", why: "runs inside the Linux bot box" },
  { file: "server/bot-box/box-probe.ts", match: 'spawnSync("python3"', why: "runs inside the Linux bot box" },
  { file: "server/bot-box/detect.ts", match: "spawnSync(bwrap", why: "bubblewrap probe; box detection reports not-linux off Linux" },
  { file: "server/bot-box/self-check.ts", match: 'spawn("sleep"', why: "Linux box self-check" },
  { file: "server/bot-box/self-check.ts", match: "spawn(wrapped.command", why: "Linux box self-check" },
  { file: "server/browser/desktop/policy.ts", match: "execFileSync(candidate", why: "bwrap sandbox policy probe, Linux" },
  { file: "server/browser/desktop/displays.ts", match: "spawn(xvnc", why: "Xvnc per-display server, Linux desktops only" },
  { file: "server/browser/desktop/displays.ts", match: "spawnProcess(file, args", why: "Xvnc per-display server, Linux desktops only" },
  { file: "server/caddy.ts", match: 'spawnSync("tar"', why: "ensureCaddy refuses win32 before any download; the tar extraction is POSIX-only" },
  { file: "server/cloud-clock-keeper.ts", match: "spawnSync(DATE", why: "/bin/date clock step, Linux cloud home" },
  { file: "server/cloud-home-start.ts", match: 'spawnSync("/usr/bin/flock"', why: "Linux cloud home" },
  { file: "server/cloud-home-start.ts", match: "spawnSync(command, args", why: "Linux cloud home" },
  { file: "server/cloud-home-start.ts", match: "spawn(command, args, { env: clockPipe", why: "Linux cloud home" },
  { file: "server/cloud-home-start.ts", match: "spawn(edgeBin", why: "Linux cloud home" },
  { file: "server/cloud-home-start.ts", match: "spawn(tunnel.command", why: "Linux cloud home" },
  { file: "server/fleet-cli.ts", match: 'execFileSync("/usr/bin/getent"', why: "Linux root fleet agent (getuid/getent)" },
  { file: "server/fleet-cli.ts", match: "execFileSync(process.execPath", why: "Linux root fleet agent (getuid/getent)" },
  { file: "server/fleet-cli.ts", match: "spawn(command!", why: "Linux root fleet agent (getuid/getent)" },
  { file: "server/host/conversation-folder-cleanup.ts", match: 'execFile("rm"', why: "GNU rm probe, Linux-gated" },
  { file: "server/host/conversation-folder-cleanup.ts", match: 'execFile("nice"', why: "GNU coreutils, Linux" },
  { file: "server/host/conversation-folder-cleanup.ts", match: 'execFile("chmod"', why: "GNU coreutils, Linux" },
  { file: "server/meetings/meetbot.ts", match: 'execFileSync("pactl"', why: "PulseAudio null sink, Linux meeting bot" },
  { file: "server/meetings/meetbot.ts", match: 'execFileSync("ffmpeg"', why: "Linux meeting bot" },
  { file: "server/meetings/meetbot.ts", match: "spawn(config.chrome", why: "/usr/bin/google-chrome, Linux meeting bot" },
  { file: "server/meetings/meetbot.ts", match: 'spawn("bash"', why: "whisper venv install, Linux" },
  { file: "server/meetings/meetbot.ts", match: "spawn(python", why: "whisper worker, Linux" },
  { file: "server/meetings/meetbot.ts", match: 'spawn("ffmpeg"', why: "Linux meeting bot" },
  { file: "server/server-launcher.ts", match: "spawn(process.execPath, server.args", why: "Linux container image entry" },
  { file: "server/engine-records.ts", match: "execFile(PS, args", why: "ps(1) process records, POSIX" },
  { file: "server/engine-records.ts", match: "execFileSync(PS", why: "ps(1) process records, POSIX" },
  { file: "server/proc-descendants.ts", match: "execFileSync(process.platform", why: "ps(1), POSIX" },

  // macOS-only.
  { file: "server/browser/chrome/resolve.ts", match: 'spawnSync("osascript"', why: "macOS AppleScript probe" },
  { file: "server/engine-standalone.ts", match: 'execFile("/usr/bin/codesign"', why: "macOS code signing" },
  { file: "server/headless/saved-servers.ts", match: 'spawnSync("/usr/bin/security"', why: "macOS keychain" },
  { file: "server/tts/system-voices.ts", match: "execFileAsync(file, args, { timeout", why: "macOS `say` voices; systemVoicesAvailable gates darwin" },
  { file: "electron/build-speech-helper.mjs", match: '"swiftc"', why: "macOS build tool, not shipped runtime" },
  { file: "electron/build-speech-helper.mjs", match: '"lipo"', why: "macOS build tool, not shipped runtime" },
  { file: "electron/build-speech-helper.mjs", match: '"codesign"', why: "macOS build tool, not shipped runtime" },
  { file: "electron/cloud-sync-mark.mjs", match: "/usr/bin/xattr", why: "macOS quarantine mark; the win32 branch writes Zone.Identifier without a child" },
  { file: "electron/cua.mjs", match: 'execFileAsync("/usr/bin/open"', why: "darwin-gated standalone driver attach (returns null off darwin)" },
  { file: "electron/shell-path.mjs", match: 'execFile(shell, ["-l", "-i", "-c"', why: "POSIX login-shell PATH probe; commandPath returns env.PATH on win32" },
  { file: "electron/speech.mjs", match: "/usr/bin/mkfifo", why: "macOS speech lifeline fifo" },
  { file: "electron/speech.mjs", match: "/usr/bin/open", why: "macOS helper launch; the Windows path sets windowsHide" },
  { file: "electron/system-name.mjs", match: "/usr/bin/id", why: "goes through run(), which sets windowsHide" },
  { file: "electron/system-name.mjs", match: 'exec("getent"', why: "goes through run(), which sets windowsHide" },
  { file: "electron/system-proxy.mjs", match: 'execFile("/usr/sbin/scutil"', why: "macOS proxy settings" },

  // Options come prebuilt, deliberately detached, or through an approved hiding helper.
  { file: "server/drivers/antigravity-runtime.ts", match: 'execFile(executablePath, ["--version"], options', why: "options are built just above with windowsHide" },
  { file: "server/drivers/codex-process.ts", match: "spawn()", why: "spawnHoldingSlot's callback parameter; callers spawn through spawnCli/execFileInGroup, which hide" },
  { file: "server/drivers/device-auth.ts", match: "private exec(args", why: "method declaration; its body spawns via procs.ts spawnCli, which hides on Windows" },
  { file: "server/github/gh-cli.ts", match: "spawn(file: string", why: "interface declaration, not a call" },
  { file: "server/github/gh-cli.ts", match: "spawn(file, args, env) {", why: "adapter method definition; its body sets windowsHide" },
  { file: "server/headless/prompt.ts", match: 'spawn(command, args, { stdio: "ignore", detached: true }', why: "deliberately detached + unref'd browser opener; Windows' opener rundll32 is GUI-subsystem" },
  { file: "server/env-path.ts", match: 'spawn(shell, ["-l", "-i", "-c"', why: "POSIX login-shell PATH probe ($SHELL), deliberately detached: an interactive shell takes the terminal's foreground" },
  { file: "server/vps-ssh.ts", match: 'execFile("ssh"', why: "needs a ControlMaster config, and prepareVpsSsh returns configPath null on win32, so ensureVpsSshMaster returns before this" },
  { file: "server/mcp-bridge.ts", match: "shell: false, windowsHide, env, stdio", why: "consoleChild selects windowsHide at the bridge caller" },
  { file: "server/mcp-gate.ts", match: '...(process.platform === "win32" ? { windowsHide: true } : {})', why: "windowsHide is true on win32" },
  { file: "server/procs.ts", match: '...(process.platform === "win32" ? { windowsHide: true } : { detached: true })', why: "windowsHide is true on win32" },
  { file: "server/memory-store.ts", match: 'stdio: "ignore", windowsHide: false, detached: true', why: "GUI openers must remain visible on Windows" },
  { file: "electron/elevated-install.mjs", match: "pkexec", why: "Linux package install (pkexec + .deb)" },
  { file: "electron/terminal-launch.mjs", match: "run(executable, args, options", why: "options come from the callers; the win32 caller passes windowsHide: true" },

  // Scanner artifacts.
  { file: "electron/launch-probes.mjs", match: "STARTERS", why: "instrumentation: matches a child_process name regex, not a spawn call" },
];

interface Site { line: number; api: string; text: string }

function callSites(src: string, names: Set<string>): Site[] {
  const sites: Site[] = [];
  const alt = [...names].sort((a, b) => b.length - a.length).map((name) => name.replace(/\./g, "\\.")).join("|");
  const collect = (re: RegExp): void => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1;
      const source = ts.createSourceFile("call.ts", `f${src.slice(open)}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const findCall = (node: ts.Node): ts.CallExpression | undefined => {
        if (node.pos !== 0) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) return node;
        return ts.forEachChild(node, findCall);
      };
      const call = findCall(source);
      const text = call ? source.text.slice(2, call.arguments.end) : src.slice(open + 1, open + 400);
      sites.push({ line: src.slice(0, m.index).split("\n").length, api: m[1]!, text });
    }
  };
  collect(new RegExp(`(?<![\\w.])(${alt})\\s*\\(`, "g"));
  // `(options.spawnImpl ?? spawn)(...)`: the callee is a parenthesized expression naming a tracked entry point.
  collect(new RegExp(`\\([^()]*?(?<![\\w.])(${alt})\\b[^()]*?\\)\\s*\\(`, "g"));
  return sites;
}

function hidesConsole(text: string): boolean {
  const source = ts.createSourceFile("call.ts", `f(${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  return statement.expression.arguments.slice(1, 3).some((argument) => {
    if (!ts.isObjectLiteralExpression(argument)) return false;
    let hidden = false;
    for (const property of argument.properties) {
      if (ts.isSpreadAssignment(property)) hidden = ts.isIdentifier(property.expression) && property.expression.text === "OWN_GROUP";
      else if (ts.isPropertyAssignment(property) && property.name.getText(source).replace(/^["']|["']$/g, "") === "windowsHide") {
        hidden = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
      }
    }
    return hidden;
  });
}

describe("windows console hiding", () => {
  it.each([
    ['import { spawn as start } from "node:child_process"; start("cmd.exe");', "start"],
    ['import * as cp from "node:child_process"; cp.spawn("cmd.exe");', "cp.spawn"],
    ['import { execFile } from "node:child_process"; const run = promisify(execFile); run("cmd.exe");', "run"],
    ['import * as cp from "node:child_process"; const run = promisify(cp.execFile); run("cmd.exe", [], { windowsHide: false });', "run"],
  ])("detects an unhidden child process through imported bindings", (src, api) => {
    const site = callSites(src, trackedNames(src)).find((candidate) => candidate.api === api);
    expect(site).toBeDefined();
    expect(site && hidesConsole(site.text)).toBe(false);
  });

  it.each([
    'spawn("cmd.exe", [], { windowsHide: false })',
    'spawn("windowsHide")',
    'spawn("cmd.exe", ["windowsHide: true"])',
    'spawn("cmd.exe", [], { env: { windowsHide: true } })',
    'spawn("cmd.exe", [], { windowsHide: true, windowsHide: false })',
    'spawn("cmd.exe", [], { windowsHide: true, ...other })',
    'spawn("cmd.exe", [], { windowsHide: true, note: ")", ...{ windowsHide: false } })',
    `spawn("cmd.exe", [], { windowsHide: true, note: "${"x".repeat(8_000)}", ...{ windowsHide: false } })`,
    'spawn("cmd.exe", [], { ...OWN_GROUP, windowsHide: false })',
    'spawn("cmd.exe", [], { note: "windowsHide: true" })',
    'spawn({ windowsHide: true }, [])',
    'spawn("cmd.exe", [], { /* windowsHide: true */ })',
  ])("rejects an unrelated or disabled hiding option", (src) => {
    const site = callSites(src, trackedNames(src))[0];
    expect(site && hidesConsole(site.text)).toBe(false);
  });

  it.each([
    'spawn("cmd.exe", [], { windowsHide: true })',
    'spawn("cmd.exe", [], { ...OWN_GROUP })',
    'import * as cp from "node:child_process"; const run = promisify(cp.execFile); run("cmd.exe", [")"], { windowsHide: true })',
    'spawn("cmd.exe", [`run ${f(")")}`], { windowsHide: true })',
    'spawn("cmd.exe", [")"], { windowsHide: true }).once("error", onError)',
    'spawn("cmd.exe", [")"], { windowsHide: true }) as ChildProcess',
    'spawn("cmd.exe", [/\\)/], { windowsHide: true })',
  ])("accepts an enabled hiding option", (src) => {
    const site = callSites(src, trackedNames(src))[0];
    expect(site && hidesConsole(site.text)).toBe(true);
  });

  it("normalizes Windows paths for the allowlist", () => {
    expect(repoRelative("C:\\repo\\", "C:\\repo\\server\\testing\\fixture.ts", win32.relative)).toBe("server/testing/fixture.ts");
  });

  it("every child_process spawn in server/ and electron/ hides its console on Windows or is allowlisted", () => {
    const unhidden: string[] = [];
    for (const file of childProcessFiles()) {
      const rel = repoRelative(ROOT, file);
      const src = withoutCommentLines(readFileSync(file, "utf8"));
      const lines = src.split("\n");
      for (const site of callSites(src, trackedNames(src))) {
        if (hidesConsole(site.text)) continue;
        const line = (lines[site.line - 1] ?? "").trim();
        const why = ALLOWED.find((entry) =>
          (entry.file.endsWith("/") ? rel.startsWith(entry.file) : rel === entry.file)
          && (!entry.match || `${site.text}\n${line}`.includes(entry.match)),
        )?.why;
        if (!why) unhidden.push(`${rel}:${site.line} [${site.api}] ${line.replace(/\s+/g, " ").slice(0, 130)}`);
      }
    }
    expect(unhidden, [
      "child_process sites that hide no console on Windows (add windowsHide: true, or an allowlist entry with the",
      "reason it stays unhidden: POSIX-only, deliberately detached, or an approved helper):",
      ...unhidden,
    ].join("\n")).toEqual([]);
  });
});
