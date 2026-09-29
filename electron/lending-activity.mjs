// What a server's bots did on this computer through computer sharing, kept
// on this computer for the person to read (Settings). One JSON object per
// operation: when, which server, which action, where (folder name and
// relative path, the tool name, or the command text) and whether it worked.
// Never file contents, command output, typed text or tool arguments. The file
// is owner-only and sits in the protected sharing directory, so no shared
// folder can read or rewrite it.
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

export function createLendingActivity(file, { now = Date.now } = {}) {
  let lines = null;
  const load = () => {
    if (lines) return lines;
    try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-KEEP); }
    catch { lines = []; }
    return lines;
  };
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
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
      load().push(JSON.stringify(entry));
      if (lines.length > KEEP) lines = lines.slice(-KEEP);
      try { persist(); } catch { /* kept in memory until the next write */ }
      return entry;
    },
    /** Newest first. Malformed lines are skipped, never trusted. */
    list(limit = 100) {
      const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, KEEP) : 100;
      const entries = [];
      for (const line of load().slice().reverse()) {
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
