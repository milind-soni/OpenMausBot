// Where the OpenCode CLI keeps its login: `auth.json` (v1) or the `credential` table of `opencode.db` (v2).
// Only the active OpenCode rows are read, read-only; other providers' keys never leave the CLI's database.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

/** The CLI is xdg-flavoured on every platform, so the xdg data folder comes first. */
function openCodeDataRoots(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  return [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin" ? join(home, "Library", "Application Support") : "",
    process.platform === "win32" ? env.LOCALAPPDATA || join(home, "AppData", "Local") : "",
  ].filter(Boolean);
}

export function openCodeAuthText(env: NodeJS.ProcessEnv, readText: (path: string) => string | null): string | null {
  for (const root of openCodeDataRoots(env)) { const text = readText(join(root, "opencode", "auth.json")); if (text) return text; }
  return null;
}

export function openCodeDbText(env: NodeJS.ProcessEnv, readDb: (path: string) => string | null): string | null {
  for (const root of openCodeDataRoots(env)) { const text = readDb(join(root, "opencode", "opencode.db")); if (text) return text; }
  return null;
}

/** Reads only the active OpenCode logins, read-only, and never writes or locks the CLI's database. */
export function readOpenCodeDbLogins(path: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("SELECT integration_id, value FROM credential WHERE integration_id IN ('opencode-go', 'opencode') AND active = 1").all() as { integration_id: string; value: string }[];
    const logins: Record<string, unknown> = {};
    for (const row of rows) { const value = parseJson(row.value); if (value !== null && logins[row.integration_id] === undefined) logins[row.integration_id] = value; }
    return Object.keys(logins).length ? JSON.stringify(logins) : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
