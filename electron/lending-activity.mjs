// What a server's bots did on this computer through computer sharing, kept
// on this computer for the person to read (Settings). One JSON object per
// operation: when, which server, which action, where (folder name and
// relative path, the tool name, or the command text) and whether it worked.
// Never file contents, command output, typed text or tool arguments. The file
// is owner-only and sits in the protected sharing directory, so no shared
// folder can read or rewrite it, and no lent screen argument can name a path.
//
// Append-only: this module only ever appends a line (O_APPEND, never through
// a symbolic link). It never rewrites or truncates an entry; to stay bounded
// it renames a full file to `<file>.1` (replacing the older one) and starts a
// new file, so the log always holds between one and two files of history.
import fs from "node:fs";
import path from "node:path";

const KEEP = 500;
// oxlint-disable-next-line no-control-regex
const clean = (value, max) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, max) : undefined;

/** The one-line description of an operation, from the local grant (folder
 * names come from this computer, never from the server). */
export function describeSharedOperation(grant, operation) {
  switch (operation?.action) {
    case "list_files":
    case "read_file":
    case "write_file": {
      const folder = grant?.folders?.find?.(entry => entry.id === operation.folder_id);
      const where = typeof operation.path === "string" && operation.path ? `/${operation.path}` : "";
      return clean(`${folder?.name ?? "unknown folder"}${where}`, 300);
    }
    case "run_command": return clean(operation.command, 300);
    case "computer_call": return clean(operation.tool_name, 100);
    default: return "";
  }
}

export function createLendingActivity(file, { now = Date.now, keep = KEEP } = {}) {
  const previous = `${file}.1`;
  const read = name => {
    try { return fs.readFileSync(name, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  };
  let count = null;
  const append = line => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    count ??= read(file).length;
    if (count >= keep) { fs.renameSync(file, previous); count = 0; }
    const handle = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(handle, `${line}\n`); } finally { fs.closeSync(handle); }
    count++;
  };
  return {
    /** Never throws: a full disk must not stop an operation's answer or the
     * stop switch. */
    record({ env, action, detail, ok, error }) {
      const entry = {
        at: now(), server: clean(env?.name, 120) ?? "", origin: clean(env?.origin, 300) ?? "",
        action: clean(action, 40) ?? "", detail: clean(detail, 300) ?? "", ok: ok === true,
        ...(ok === true ? {} : { error: clean(error, 200) ?? "" }),
      };
      try { append(JSON.stringify(entry)); } catch { count = null; }
      return entry;
    },
    /** Newest first. Malformed lines are skipped, never trusted. */
    list(limit = 100) {
      const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, keep * 2) : 100;
      const entries = [];
      for (const line of [...read(previous), ...read(file)].reverse()) {
        if (entries.length >= count) break;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry.at === "number" && typeof entry.action === "string") entries.push(entry);
        } catch { /* skip */ }
      }
      return entries;
    },
  };
}
