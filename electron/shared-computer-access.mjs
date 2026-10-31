// The server sends requests, never paths to grant, commands to install or permission changes: only the saved grant decides.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { lentScreenArguments, lentScreenToolListing } from "./lent-screen-tools.mjs";
import { typeOneCharacterAtATime, typesInOneBurst } from "./paced-typing.mjs";
import { helperMissing } from "./lent-screen-failures.mjs";
import { commandPath } from "./shell-path.mjs";

/** Reads stay under the 4 MB body that carries a result to the server (base64 of 2 MiB is 2.8 MB); writes stay small. */
const READ_LIMIT = 2 * 1024 * 1024;
const WRITE_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
// A process the command left running in the background can hold its output pipes open long after the command ended,
// and on Windows a grandchild whose parent has exited is outside the tree taskkill /T ends. A command's result is
// therefore what it wrote by shortly after it exited, and a stopped command ends shortly after the stop.
const COMMAND_SECONDS = 120;
/** Below the 300-second wait for response headers in Node's fetch (undici), which carries the result back to the bot. */
const MAX_COMMAND_SECONDS = 240;
const PIPE_GRACE_MS = 1000;
const STOP_GRACE_MS = 5000;
/** The server reads a result body of at most 4,000,000 bytes. */
const RESULT_LIMIT = 3_900_000;
const PROTECTED = "Desktop credentials and sharing settings cannot be accessed through a shared folder";
const GIT_INTERNALS = "Files inside .git cannot be changed through a shared folder: git runs commands from its configuration and hooks";
const HOME_SETTINGS = "The home folder's hidden files, Library and AppData cannot be changed through a shared folder: shells, git and apps run what they hold";

/** Keys that open a shell or an account, and places that run code by themselves: no folder grant reaches these. Relative to home. */
const PERSONAL_SECRETS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".gitconfig", ".npmrc", ".pypirc",
  // Shell start-up files run in every new terminal and often export API keys.
  ".profile", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout",
  ".claude", ".claude.json", ".codex", ".mozilla", ".local/share/keyrings", ".local/bin",
  ".config/gh", ".config/gcloud", ".config/op", ".config/git", ".config/fish", ".config/autostart", ".config/systemd",
  ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge",
  "Library/Keychains", "Library/Cookies", "Library/LaunchAgents", "Library/Safari",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Firefox", "Library/Application Support/Arc",
  ".cua",
  // Windows: the browsers' saved passwords and cookies, the credential vault and its keys, and what runs at sign-in.
  "AppData/Local/Google/Chrome/User Data", "AppData/Local/Microsoft/Edge/User Data", "AppData/Local/BraveSoftware/Brave-Browser/User Data",
  "AppData/Roaming/Mozilla", "AppData/Local/Mozilla",
  "AppData/Roaming/Microsoft/Credentials", "AppData/Local/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect",
  "AppData/Roaming/Microsoft/Vault", "AppData/Local/Microsoft/Vault",
  "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
  "Documents/PowerShell", "Documents/WindowsPowerShell",
];
export function personalSecretPaths(home) {
  return typeof home === "string" && home ? PERSONAL_SECRETS.map(entry => path.join(home, ...entry.split("/"))) : [];
}

export { LENT_SCREEN_TOOLS } from "./lent-screen-tools.mjs";

/** Compared the way a case-folding, Unicode-normalizing filesystem compares it. */
const gitComponent = part => part.normalize("NFC").toLowerCase() === ".git";
export const insideGitInternals = (root, relative) => root.split(path.sep).some(gitComponent) || relative.split("/").some(gitComponent);
/** Security: the home folder is lent with editing, so a write through it never reaches its own hidden files and folders,
 * Library (macOS) or AppData (Windows), where shell start-up files, git's configuration and apps' settings live. */
export const insideHomeSettings = relative => {
  const first = relative.split("/").find(part => part && part !== ".");
  return Boolean(first) && (first.startsWith(".") || ["library", "appdata"].includes(first.normalize("NFC").toLowerCase()));
};
const hash = data => createHash("sha256").update(data).digest("hex");

function editedText(current, oldText, newText) {
  const before = current.toString("utf8");
  if (!Buffer.from(before, "utf8").equals(current)) throw new Error("edit_file changes text files only: read it and write it whole with write_file");
  const at = before.indexOf(oldText);
  if (at < 0) throw new Error("old_text was not found in the file: read it again and copy the passage exactly");
  if (before.indexOf(oldText, at + 1) >= 0) throw new Error("old_text occurs more than once: include more of the surrounding text");
  return Buffer.from(before.slice(0, at) + newText + before.slice(at + oldText.length), "utf8");
}
const absent = error => error.code === "ENOENT" || error.code === "ENOTDIR";
const identify = async candidate => { const info = await fs.stat(candidate, { bigint: true }); return `${info.dev}:${info.ino}`; };

/** {dev, ino}, never path text; a root a fresh install has not created yet is skipped. */
export async function protectedIdentities(roots) {
  const identities = new Set();
  for (const root of roots ?? []) {
    if (typeof root !== "string" || !root) continue;
    try { identities.add(await identify(await fs.realpath(root))); }
    catch (error) { if (!absent(error)) throw error; }
  }
  return identities;
}

/** A write may create a file that does not exist yet, so walk from the nearest existing ancestor. */
export async function assertOutsideProtected(identities, target) {
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

const POSIX_PATH = /(?:\/[^/\s]+)+/g;
/** A Windows folder may hold spaces, so everything up to a line's last backslash goes. */
const WINDOWS_FOLDERS = /(?:[A-Za-z]:|\\\\[^\\\s]+)\\(?:[^\\\r\n]*\\)*/g;
/** Job error text crosses to a remote workspace, so absolute paths collapse to their basename (the original is logged here). */
const basenameMessage = message => {
  const original = String(message);
  if (!original.match(POSIX_PATH) && !original.match(WINDOWS_FOLDERS)) return original;
  console.warn("Shared computer error before path sanitization:", original);
  return original.replace(WINDOWS_FOLDERS, "").replace(POSIX_PATH, matched => matched.slice(matched.lastIndexOf("/") + 1));
};
export const sharedComputerError = error => ({ ...text(basenameMessage(error?.message ?? "Computer action failed")), isError: true });

export async function sharedPath(folder, relative = "") {
  if (typeof relative !== "string" || relative.length > 2048 || /[\\:\0]/.test(relative) || path.isAbsolute(relative) || relative.split("/").some(part => part === "..")) throw new Error("Use a relative path inside the shared folder");
  const root = await fs.realpath(folder.path);
  if (root !== folder.path) throw new Error("Shared folder moved. Choose it again in Settings.");
  let target = root;
  const parts = relative.split("/").filter(part => part && part !== ".");
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    let stat = null;
    try { stat = await fs.lstat(target); }
    catch (error) {
      if (error.code === "ENOTDIR") throw new Error(`${parts.slice(0, index).join("/")} is a file, not a folder`);
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) throw new Error("Symbolic links cannot be followed in shared folders");
    // Windows answers ENOENT, not ENOTDIR, past a file, so a file with more of the path after it is refused here.
    if (stat && !stat.isDirectory() && index < parts.length - 1) throw new Error(`${parts.slice(0, index + 1).join("/")} is a file, not a folder`);
  }
  return target;
}

/** One level at a time, so a folder swapped for a link between two levels is refused, not followed. */
async function makeMissingFolders(folder, relative) {
  const parts = relative.split("/").filter(part => part && part !== ".").slice(0, -1);
  let current = await fs.realpath(folder.path);
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symbolic links cannot be followed in shared folders");
  }
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

/** No inherited API keys, provider credentials or shell startup files, but still UNRESTRICTED host execution once terminal is on. */
/** No inherited API keys or provider credentials. On Windows a child without SystemRoot cannot start Winsock, one
 * without USERPROFILE has no home, and one without TEMP or TMP puts temporary files in the Windows folder. */
const hostEnvironment = () => Object.fromEntries(["PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
/** cua-driver 0.28.2 keeps its settings, history and cursor themes under Windows' own folders, which hold no secret. */
const driverEnvironment = () => ({ ...hostEnvironment(), ...Object.fromEntries(["LOCALAPPDATA", "APPDATA", "ProgramData", "SystemDrive", "windir"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]])) });

export const validCommandSeconds = value => value === undefined || (Number.isInteger(value) && value >= 1 && value <= MAX_COMMAND_SECONDS);

export async function sharedCommand(command, cwd, signal, seconds = COMMAND_SECONDS) {
  if (typeof command !== "string" || !command.trim() || command.length > 8000) throw new Error("Give a command of at most 8000 characters");
  if (!validCommandSeconds(seconds)) throw new Error(`Give timeout_seconds as a whole number from 1 to ${MAX_COMMAND_SECONDS}`);
  signal.throwIfAborted();
  const PATH = await commandPath();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    // PowerShell searches third-party modules before its own cmdlets, so a cold `echo` can exhaust the deadline: prefer built-ins.
    // A ScriptBlock wrapper would lose native failure status, so a child CLI runs the original text.
    const script = windows
      ? `$env:PSModulePath = "$PSHOME\\Modules;$env:PSModulePath"; & "$PSHOME\\powershell.exe" -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '${Buffer.from(command, "utf16le").toString("base64")}'; exit $LASTEXITCODE`
      : command;
    const child = spawn(windows ? "powershell.exe" : "/bin/sh", windows ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["-c", script], {
      cwd, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      // Without PATHEXT, PowerShell treats even .exe files as documents.
      env: { ...hostEnvironment(), ...(PATH ? { PATH } : {}) },
    });
    const chunks = []; let bytes = 0; let reason; let settled = false;
    const graces = [];
    const settle = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); for (const grace of graces) clearTimeout(grace);
      signal.removeEventListener("abort", abort);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error);
      else if (reason) reject(new Error(reason));
      else resolve(text({ exitCode: code, output: Buffer.concat(chunks).toString("utf8") }));
    };
    const stop = message => {
      if (settled || reason) return;
      reason = message;
      killTree(child);
      graces.push(setTimeout(() => settle(null), STOP_GRACE_MS));
    };
    const abort = () => stop("Computer access was revoked or the requesting turn ended. Inspect the result before retrying.");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(`Command timed out after ${seconds} second${seconds === 1 ? "" : "s"}; inspect before retrying, or give a longer timeout_seconds.`), seconds * 1000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= OUTPUT_LIMIT) chunks.push(chunk); else stop("Command output exceeded the limit");
    });
    child.once("error", error => settle(null, error));
    child.once("close", code => settle(code));
    child.once("exit", code => { graces.push(setTimeout(() => settle(code), PIPE_GRACE_MS)); });
  });
}

/** Persistent transport: Cua observation references survive to the next call. Ending sharing closes this, not the app's daemon. */
export function createSharedCua(connection, { platform = process.platform } = {}) {
  const child = spawn(connection.mcpCommand, connection.mcpArgs, {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    env: { ...driverEnvironment(), ...connection.mcpEnv },
  });
  let sequence = 0; let closed = false; let bytes = 0;
  const pending = new Map();
  const fail = error => {
    closed = true;
    const reason = child.pid === undefined ? new Error(helperMissing()) : error;
    for (const item of pending.values()) item.reject(reason);
    pending.clear(); child.kill();
  };
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
  let driver;
  const ready = request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "omb-shared-desktop", version: "1" } }).then(answer => {
    driver = answer?.serverInfo;
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  });
  ready.catch(() => {});
  return {
    async call(operation, signal) {
      await ready; signal.throwIfAborted();
      if (operation.action === "computer_tools") {
        const listed = await request("tools/list", {}, signal);
        return text({ ...listed, tools: lentScreenToolListing(listed?.tools) });
      }
      if (typeof operation.tool_name !== "string" || !operation.tool_name) throw new Error("Choose a tool from computer_tools first");
      // Every tool and argument is checked here: nothing the server sends reaches the driver unless a lent screen accepts it.
      const lent = lentScreenArguments(operation.tool_name, operation.arguments);
      if (lent.error) throw new Error(lent.error);
      if (typesInOneBurst(platform, driver?.version, operation.tool_name, lent.arguments)) {
        return typeOneCharacterAtATime((name, args) => request("tools/call", { name, arguments: args }, signal), lent.arguments);
      }
      return request("tools/call", { name: operation.tool_name, arguments: lent.arguments }, signal);
    },
    close() { lines.close(); fail(new Error("Computer sharing stopped")); },
  };
}

export async function executeSharedOperation(grant, operation, signal, cua) {
  signal.throwIfAborted();
  if (grant.enabled !== true) throw new Error("Computer sharing is off");
  if (operation.action === "run_command") {
    if (grant.terminal !== true) throw new Error("Terminal access is not enabled for this server");
    return sharedCommand(operation.command, grant.folders[0]?.path ?? process.env.HOME ?? process.env.USERPROFILE, signal, operation.timeout_seconds);
  }
  if (["computer_tools", "computer_call"].includes(operation.action)) {
    if (grant.computer !== true) throw new Error("Computer control is not enabled for this server");
    return (await cua()).call(operation, signal);
  }
  if (!["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file"].includes(operation.action)) throw new Error("Unsupported shared-computer operation");
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
      try { identity = await identify(path.join(target, entry.name)); } catch {}
      if (identity !== undefined && protectedRoots.has(identity)) return { name: entry.name, type: "protected" };
      return { name: entry.name, type: entry.isDirectory() ? "directory" : "file" };
    }));
    return text({ entries: shown, truncated: entries.length > 200 });
  }
  const write = operation.action === "write_file", edit = operation.action === "edit_file", append = operation.action === "append_file";
  const remove = operation.action === "delete_file", changes = write || edit || append || remove;
  if (changes && folder.write !== true) throw new Error("This folder is read-only");
  if (changes && insideGitInternals(folder.path, operation.path ?? "")) throw new Error(GIT_INTERNALS);
  if (changes && folder.home === true && insideHomeSettings(operation.path ?? "")) throw new Error(HOME_SETTINGS);
  let data;
  if (write) {
    if (typeof operation.content !== "string") throw new Error("Give file content to write");
    data = Buffer.from(operation.content, operation.encoding === "base64" ? "base64" : "utf8");
    if (data.length > WRITE_LIMIT) throw new Error("A file written here is limited to 256 KiB");
    if (!operation.expected_sha256) await makeMissingFolders(folder, operation.path ?? "");
  }
  if (edit) {
    if (typeof operation.old_text !== "string" || !operation.old_text || typeof operation.new_text !== "string") throw new Error("Give old_text to find and new_text to put in its place");
    if (Buffer.byteLength(operation.new_text) > WRITE_LIMIT) throw new Error("new_text is limited to 256 KiB");
  }
  if (append) {
    if (typeof operation.content !== "string") throw new Error("Give content to append");
    data = Buffer.from(operation.content, operation.encoding === "base64" ? "base64" : "utf8");
    if (data.length > WRITE_LIMIT) throw new Error("Content appended at once is limited to 256 KiB");
    await makeMissingFolders(folder, operation.path ?? "");
  }
  if (remove && !operation.expected_sha256) throw new Error("Read the file first and pass its sha256 as expected_sha256 to delete it");
  let opening = constants.O_RDONLY;
  if (write) opening = operation.expected_sha256 ? constants.O_RDWR : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  else if (edit) opening = constants.O_RDWR;
  else if (append) opening = constants.O_RDWR | constants.O_CREAT;
  const flags = opening | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await fs.open(target, flags, 0o600);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > READ_LIMIT) throw new Error("Only regular, single-link files up to 2 MiB can be shared");
    await sharedPath(folder, operation.path);
    const named = await fs.lstat(target, { bigint: true });
    if (named.ino !== stat.ino || named.dev !== stat.dev || named.isSymbolicLink()) throw new Error("The file changed while opening it; retry after inspecting the folder");
    // Re-decide containment against the opened descriptor's own identity, not the spelling.
    if (protectedRoots.has(`${stat.dev}:${stat.ino}`)) throw new Error(PROTECTED);
    await assertOutsideProtected(protectedRoots, target);
    let current = Buffer.alloc(0);
    if (!write || operation.expected_sha256) {
      const buffer = Buffer.alloc(READ_LIMIT + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > READ_LIMIT) throw new Error("File grew beyond the 2 MiB limit");
      current = buffer.subarray(0, total);
    }
    if (changes && operation.expected_sha256 && hash(current) !== operation.expected_sha256) throw new Error("File changed since it was read. Read it again first.");
    if (remove) {
      signal.throwIfAborted();
      // The path must still name the file just checked: never unlink what a swapped folder or file put there.
      await sharedPath(folder, operation.path);
      const named = await fs.lstat(target, { bigint: true });
      if (named.ino !== stat.ino || named.dev !== stat.dev || named.isSymbolicLink()) throw new Error("The file changed while deleting it; retry after inspecting the folder");
      await fs.unlink(target);
      return text({ deleted: true });
    }
    if (edit) data = editedText(current, operation.old_text, operation.new_text);
    // An append writes only its own bytes, after what is there.
    const at = append ? current.length : 0;
    if (data && at + data.length > READ_LIMIT) throw new Error("A file changed here is limited to 2 MiB");
    if (data) {
      signal.throwIfAborted();
      for (let offset = 0; offset < data.length;) {
        signal.throwIfAborted();
        const { bytesWritten } = await file.write(data, offset, data.length - offset, at + offset);
        if (!bytesWritten) throw new Error("File write did not make progress; inspect before retrying");
        offset += bytesWritten;
      }
      await file.truncate(at + data.length); await file.sync();
      const whole = append ? Buffer.concat([current, data]) : data;
      return text({ written: true, bytes: whole.length, sha256: hash(whole) });
    }
    signal.throwIfAborted();
    const read = text({ content: current.toString(operation.encoding === "base64" ? "base64" : "utf8"), encoding: operation.encoding ?? "utf8", bytes: current.length, sha256: hash(current) });
    // Text full of quotes or control characters grows when escaped twice; base64 never does.
    if (Buffer.byteLength(JSON.stringify(read)) > RESULT_LIMIT) throw new Error("This file is too big to read as text. Read it with encoding base64.");
    return read;
  } finally { await file.close(); }
}
