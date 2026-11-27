// Coordinated turns as tests read them: runtime.db Assignment rows as HandoffView, read-only while the server runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { HandoffView } from "../coordinator.ts";
import { view } from "../runtime-coordinator.ts";
import type { Assignment } from "../runtime/types.ts";

export function readHandoffs(dataDir: string): HandoffView[] {
  const file = join(dataDir, "runtime.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT json FROM assignments ORDER BY created_at, rowid").all() as Array<{ json: string }>;
    const all = rows.map((row) => JSON.parse(row.json) as Assignment);
    const byId = new Map(all.map((a) => [a.id, a]));
    return all.map((a) => view(a, a.parentId ? byId.get(a.parentId) : undefined));
  } finally {
    db.close();
  }
}
