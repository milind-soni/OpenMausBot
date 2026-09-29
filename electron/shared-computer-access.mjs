// Local authority boundary. The server sends requests, never paths to grant,
// commands to install, or permission changes. Only the desktop's saved grant
// decides which operations reach this computer.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";

const LIMIT = 256 * 1024;
const PROTECTED = "Desktop credentials and sharing settings cannot be accessed through a shared folder";
const GIT_INTERNALS = "Files inside .git cannot be changed through a shared folder: git runs commands from its configuration and hooks";

/** Where a person keeps the keys that open a shell or an account (SSH, cloud
 * and package CLIs, the coding engines, keychains and browser cookie stores)
 * and the places that run code by themselves (login items, git and shell
 * configuration, ~/.local/bin). No folder grant reaches these, read-only or
 * not, however the shared folder around them was chosen. Relative to home;
 * entries that do not exist on this machine protect nothing. */
const PERSONAL_SECRETS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".npmrc", ".pypirc",
  ".claude", ".claude.json", ".codex", ".mozilla", ".local/share/keyrings", ".local/bin",
  ".config/gh", ".config/gcloud", ".config/op", ".config/git", ".config/fish", ".config/autostart", ".config/systemd",
  ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge",
  "Library/Keychains", "Library/Cookies", "Library/LaunchAgents", "Library/Safari",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Firefox", "Library/Application Support/Arc",
];
export function personalSecretPaths(home) {
  return typeof home === "string" && home ? PERSONAL_SECRETS.map(entry => path.join(home, ...entry.split("/"))) : [];
}

/** The computer-control tools a lent screen offers: observing windows and
 * operating apps the way a person at the keyboard would. Everything else the
 * local driver can do (upload an arbitrary local file into a page, record or
 * replay to a chosen path, change or update its own configuration, install a
 * binary, open a DevTools port, kill any process) works outside the screen
 * and outside every folder scope, so it is not lent. Unknown tools are
 * refused, so a newer driver lends nothing new until listed here. */
export const LENT_SCREEN_TOOLS = Object.freeze(new Set([
  "bring_to_front", "click", "double_click", "right_click", "drag", "scroll", "move_cursor", "hotkey", "press_key",
  "type_text", "set_value", "launch_app", "list_apps", "list_windows", "get_window_state", "get_accessibility_tree",
  "get_desktop_state", "get_screen_size", "get_cursor_position", "zoom", "screenshot", "check_permissions",
  "start_session", "end_session", "get_session_state", "escalate_session",
  "get_agent_cursor_state", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_style",
  "browser_click", "browser_type", "browser_navigate", "browser_pointer", "browser_dialog", "get_browser_state",
]));

/** Any component named .git, compared the way a case-folding, Unicode-
 * normalizing filesystem compares it: in the requested path, or in the
 * shared folder itself (someone may have picked a .git directory). */
const gitComponent = part => part.normalize("NFC").toLowerCase() === ".git";
const insideGitInternals = (root, relative) => root.split(path.sep).some(gitComponent) || relative.split("/").some(gitComponent);
const hash = data => createHash("sha256").update(data).digest("hex");
const absent = error => error.code === "ENOENT" || error.code === "ENOTDIR";
const identify = async candidate => { const info = await fs.stat(candidate, { bigint: true }); return `${info.dev}:${info.ino}`; };

/** Protected roots as filesystem identities. A case-insensitive volume, a
 * Unicode normalization, a macOS firmlink and a Windows 8.3 or UNC name all
 * spell one directory several ways, so containment is decided by {dev, ino}
 * and never by comparing path text. A root a fresh install has not created
 * yet protects nothing, so a missing path is skipped rather than thrown. */
async function protectedIdentities(roots) {
  const identities = new Set();
  for (const root of roots ?? []) {
    if (typeof root !== "string" || !root) continue;
    try { identities.add(await identify(await fs.realpath(root))); }
    catch (error) { if (!absent(error)) throw error; }
  }
  return identities;
}

/** Refuse anything the operating system resolves inside a protected root. A
 * write may create a file that does not exist yet, so fall back to the nearest
 * existing ancestor, then walk that resolved chain comparing identities. */
async function assertOutsideProtected(identities, target) {
  if (!identities.size) return;
  let current = path.resolve(target);
  for (;;) {
    try { current = await fs.realpath(current); break; }
    catch (error) {
      if (!absent(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
  for (;;) {
    let identity;
    try { identity = await identify(current); }
    catch (error) { if (!absent(error)) throw error; }
    if (identity !== undefined && identities.has(identity)) throw new Error(PROTECTED);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

/** Job error text crosses to a remote workspace, so absolute paths collapse
 * to their basename. The original is warned first so debugging information is
 * preserved on this machine. */
const basenameMessage = message => {
  const original = String(message);
  if (!original.match(/(?:\/[^/\s]+)+/g)) return original;
  console.warn("Shared computer error before path sanitization:", original);
  return original.replace(/(?:\/[^/\s]+)+/g, matched => matched.slice(matched.lastIndexOf("/") + 1));
};
export const sharedComputerError = error => ({ ...text(basenameMessage(error?.message ?? "Computer action failed")), isError: true });

export async function sharedPath(folder, relative = "") {
  if (typeof relative !== "string" || relative.length > 2048 || /[\\:\0]/.test(relative) || path.isAbsolute(relative) || relative.split("/").some(part => part === "..")) throw new Error("Use a relative path inside the shared folder");
  const root = await fs.realpath(folder.path);
  if (root !== folder.path) throw new Error("Shared folder moved. Choose it again in Settings.");
  let target = root;
  for (const part of relative.split("/").filter(part => part && part !== ".")) {
    target = path.join(target, part);
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Symbolic links cannot be followed in shared folders"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

/** No inherited API keys, model-provider credentials or shell startup files.
 * This is still UNRESTRICTED host execution when the user enables terminal. */
export function sharedCommand(command, cwd, signal) {
  if (typeof command !== "string" || !command.trim() || command.length > 8000) throw new Error("Give a command of at most 8000 characters");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    // Windows PowerShell searches registered third-party modules before its
    // own cmdlets. On a cold machine even `echo` can spend the entire deadline
    // discovering Write-Output. Prioritize built-ins after startup constructs
    // the path, preserving every existing module location. A child CLI executes
    // the original text unchanged: a ScriptBlock wrapper loses native failure
    // status. The existing process-tree cancellation covers both shells.
    const script = windows
      ? `$env:PSModulePath = "$PSHOME\\Modules;$env:PSModulePath"; & "$PSHOME\\powershell.exe" -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '${Buffer.from(command, "utf16le").toString("base64")}'; exit $LASTEXITCODE`
      : command;
    const child = spawn(windows ? "powershell.exe" : "/bin/sh", windows ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["-c", script], {
      cwd, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      // Without PATHEXT, PowerShell treats even .exe files as documents.
      env: Object.fromEntries(["PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG"].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    });
    const chunks = []; let bytes = 0; let reason;
    const stop = message => { reason = message; killTree(child); };
    const abort = () => stop("Computer access was revoked or the requesting turn ended. Inspect the result before retrying.");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("Command timed out after 30 seconds; inspect before retrying."), 30_000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= LIMIT) chunks.push(chunk); else stop("Command output exceeded the limit");
    });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); if (reason) reject(new Error(reason)); else resolve(text({ exitCode: code, output: Buffer.concat(chunks).toString("utf8") })); });
  });
}

/** Persistent official Cua MCP transport: observation references survive the
 * next call. Ending sharing closes this transport, not the app's own daemon. */
export function createSharedCua(connection) {
  const child = spawn(connection.mcpCommand, connection.mcpArgs, {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...connection.mcpEnv },
  });
  let sequence = 0; let closed = false; let bytes = 0;
  const pending = new Map();
  const fail = error => { closed = true; for (const item of pending.values()) item.reject(error); pending.clear(); child.kill(); };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error("Computer-control transport closed")));
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4_000_000) fail(new Error("Computer-control response exceeded limit")); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id); bytes = 0;
    if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result);
  });
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) return reject(new Error("Computer control is disconnected"));
    const id = ++sequence;
    const abort = () => fail(new Error("Computer control stopped. An action already admitted by the driver may have completed."));
    const timer = setTimeout(abort, 30_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    pending.set(id, { resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); } });
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const ready = request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "omb-shared-desktop", version: "1" } }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  ready.catch(() => {});
  return {
    async call(operation, signal) {
      await ready; signal.throwIfAborted();
      if (operation.action === "computer_tools") {
        const listed = await request("tools/list", {}, signal);
        const tools = Array.isArray(listed?.tools) ? listed.tools.filter(tool => LENT_SCREEN_TOOLS.has(tool?.name)) : [];
        return text({ ...listed, tools });
      }
      if (typeof operation.tool_name !== "string" || !operation.tool_name) throw new Error("Choose a tool from computer_tools first");
      if (!LENT_SCREEN_TOOLS.has(operation.tool_name)) throw new Error(`${operation.tool_name.slice(0, 100)} is not part of lent apps and screen`);
      return request("tools/call", { name: operation.tool_name, arguments: operation.arguments ?? {} }, signal);
    },
    close() { lines.close(); fail(new Error("Computer sharing stopped")); },
  };
}

export async function executeSharedOperation(grant, operation, signal, cua) {
  signal.throwIfAborted();
  if (grant.enabled !== true) throw new Error("Computer sharing is off");
  if (operation.action === "run_command") {
    if (grant.terminal !== true) throw new Error("Terminal access is not enabled for this server");
    return sharedCommand(operation.command, grant.folders[0]?.path ?? process.env.HOME ?? process.env.USERPROFILE, signal);
  }
  if (["computer_tools", "computer_call"].includes(operation.action)) {
    if (grant.computer !== true) throw new Error("Computer control is not enabled for this server");
    return (await cua()).call(operation, signal);
  }
  if (!["list_files", "read_file", "write_file"].includes(operation.action)) throw new Error("Unsupported shared-computer operation");
  const folder = grant.folders.find(entry => entry.id === operation.folder_id);
  if (!folder) throw new Error("This folder has not been shared with this server");
  const target = await sharedPath(folder, operation.path);
  const protectedRoots = await protectedIdentities(grant.protectedPaths);
  await assertOutsideProtected(protectedRoots, target);
  signal.throwIfAborted();
  if (operation.action === "list_files") {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const shown = await Promise.all(entries.slice(0, 200).map(async entry => {
      if (entry.isSymbolicLink()) return { name: entry.name, type: "blocked-link" };
      let identity;
      try { identity = await identify(path.join(target, entry.name)); } catch { /* vanished meanwhile */ }
      if (identity !== undefined && protectedRoots.has(identity)) return { name: entry.name, type: "protected" };
      return { name: entry.name, type: entry.isDirectory() ? "directory" : "file" };
    }));
    return text({ entries: shown, truncated: entries.length > 200 });
  }
  const write = operation.action === "write_file";
  if (write && folder.write !== true) throw new Error("This folder is read-only");
  if (write && insideGitInternals(folder.path, operation.path ?? "")) throw new Error(GIT_INTERNALS);
  let data;
  if (write) {
    if (typeof operation.content !== "string") throw new Error("Give file content to write");
    data = Buffer.from(operation.content, operation.encoding === "base64" ? "base64" : "utf8");
    if (data.length > LIMIT) throw new Error("Files are limited to 256 KiB per operation");
  }
  const flags = (write ? operation.expected_sha256 ? constants.O_RDWR : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await fs.open(target, flags, 0o600);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > LIMIT) throw new Error("Only regular, single-link files up to 256 KiB can be shared");
    await sharedPath(folder, operation.path);
    const named = await fs.lstat(target, { bigint: true });
    if (named.ino !== stat.ino || named.dev !== stat.dev || named.isSymbolicLink()) throw new Error("The file changed while opening it; retry after inspecting the folder");
    // The descriptor, not the spelling, is what the rest of this call reads and
    // writes, so re-decide containment against its own identity and ancestry.
    if (protectedRoots.has(`${stat.dev}:${stat.ino}`)) throw new Error(PROTECTED);
    await assertOutsideProtected(protectedRoots, target);
    let current = Buffer.alloc(0);
    if (!write || operation.expected_sha256) {
      const buffer = Buffer.alloc(LIMIT + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > LIMIT) throw new Error("File grew beyond the 256 KiB limit");
      current = buffer.subarray(0, total);
    }
    if (write) {
      if (operation.expected_sha256 && hash(current) !== operation.expected_sha256) throw new Error("File changed. Read it again before overwriting it.");
      signal.throwIfAborted();
      for (let offset = 0; offset < data.length;) {
        signal.throwIfAborted();
        const { bytesWritten } = await file.write(data, offset, data.length - offset, offset);
        if (!bytesWritten) throw new Error("File write did not make progress; inspect before retrying");
        offset += bytesWritten;
      }
      await file.truncate(data.length); await file.sync();
      return text({ written: true, bytes: data.length, sha256: hash(data) });
    }
    signal.throwIfAborted();
    return text({ content: current.toString(operation.encoding === "base64" ? "base64" : "utf8"), encoding: operation.encoding ?? "utf8", bytes: current.length, sha256: hash(current) });
  } finally { await file.close(); }
}
