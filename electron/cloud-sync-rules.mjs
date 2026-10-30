// What Files never carries, and the name rules between a PC (Windows or macOS) and the Linux Cloud. One module for both
// sides: the desktop imports it directly, the Cloud's server through its bundle.

// Room this computer keeps free for itself while bots' work comes down.
export const RESERVE_BYTES = 1024 ** 3;
/** Room My Cloud keeps free for itself and its bots: shared files never fill it past this. */
export const cloudReserveBytes = (totalBytes) => Math.max(2 * 1024 ** 3, Math.ceil(totalBytes * 0.15));
export const CHUNK_BYTES = 16 * 1024 ** 2;
export const MIN_CHUNK_BYTES = 512 * 1024;
export const QUIET_MS = 2_000;
export const TRASH_DAYS = 30;

// Security: .openmausbot-secrets holds a bot's private secret files, which never leave the computer they were given on.
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".next", ".turbo", ".cache", ".openmausbot-secrets"]);
const SKIP_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
// Right-to-left and other direction overrides: "invoice\u202Efdp.exe" shows as a PDF.
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
// Files an agent or a tool runs or obeys when it opens a folder: never brought down from My Cloud.
const AGENT_CONFIG = /(?:^|\/)(?:\.mcp\.json|claude\.md|agents\.md|gemini\.md|\.envrc|[^/]*\.code-workspace|\.(?:claude|codex|cursor|vscode|idea|github|gemini|devcontainer)\/.*)$/i;
// Version control runs hooks and config commands (git's core.fsmonitor) from these whenever anything reads the folder's
// status, and a ".git" file can point git at a folder of its own: never brought down as a folder or a file.
const VCS_METADATA = new Set([".git", ".hg", ".svn", ".jj", ".bzr"]);
// eslint-disable-next-line no-control-regex
const WINDOWS_CHARACTERS = /[<>:"\\|?*\u0000-\u001f]/;

/** True for a directory or file sync never carries, including its own half-downloaded files. */
export function skipped(name, directory) {
  if (directory) return SKIP_DIRS.has(name);
  return SKIP_FILES.has(name.toLowerCase()) || name.startsWith("~$") || /\.(?:tmp|crdownload|part)$/i.test(name)
    || /^\.~lock\..*#$/.test(name) || /\.omb-sync-[0-9a-f]+$/.test(name);
}

/** A path as it travels: well-formed Unicode, relative, "/"-separated, NFC, with no empty, "." or ".." part, and no direction override. */
export function validWirePath(path) {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || path.includes("\\") || path.startsWith("/") || BIDI.test(path)) return false;
  if (!path.isWellFormed() || path !== path.normalize("NFC")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** True for a path from My Cloud this computer never writes: through a folder sync skips, or an agent's or tool's config. */
export function neverFromCloud(path) {
  const parts = path.split("/");
  // macOS's and Windows's usual disks are case-insensitive: ".GIT" there is the ".git" every tool reads.
  return AGENT_CONFIG.test(path) || parts.some((part, index) => {
    const folder = index < parts.length - 1;
    return VCS_METADATA.has(part.toLowerCase()) || skipped(folder ? part.toLowerCase() : part, folder);
  });
}

/** Why a Windows PC cannot hold this path, or null. */
export function windowsProblem(path) {
  for (const part of path.split("/")) {
    if (WINDOWS_CHARACTERS.test(part)) return "characters";
    if (/[. ]$/.test(part)) return "trailing";
    if (WINDOWS_RESERVED.test(part)) return "reserved";
  }
  return null;
}

/** Equal for two paths a case-insensitive PC treats as one. */
export function foldKey(path) {
  return path.normalize("NFC").toLowerCase();
}

/** The PC copy's name in a clash, "report (PC copy, 15 Oct 2026).docx", numbered past any name `taken` says is used. */
export function clashPath(path, at, taken, label = "PC copy") {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  const date = new Date(at);
  const day = `${label}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  for (let n = 1; ; n++) {
    const candidate = `${dir}${stem} (${day}${n === 1 ? "" : ` ${n}`})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** A folder name Windows and macOS both hold, not already in `taken` (a set of foldKeys). */
export function safeFolderName(name, taken) {
  // eslint-disable-next-line no-control-regex
  let safe = String(name).normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, "-").trim().slice(0, 80).replace(/[. ]+$/, "");
  if (!safe) safe = "Untitled";
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  let candidate = safe;
  for (let n = 2; taken.has(foldKey(candidate)); n++) candidate = `${safe} (${n})`;
  return candidate;
}
