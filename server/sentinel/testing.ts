// WAL with checkpointing off and the writer open, so rows stay in the -wal file as they do while the app runs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface FixtureDataDir {
  dataDir: string;
  messages: DatabaseSync;
  runtime: DatabaseSync;
  activity(row: { threadId: string; id: string; at: number; name: string; ok?: boolean; output?: string; turnId?: string; from?: { botId: string; name: string } }): void;
  assignment(row: { id: string; status: string; botId: string; threadId: string; events: Array<{ kind: string; at: number }> }): void;
  close(): void;
}

function walWriter(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  return db;
}

export function fixtureDataDir(dataDir: string, bots: Array<{ id: string; name: string; threadId: string; tasks?: Array<{ threadId: string }> }> = []): FixtureDataDir {
  mkdirSync(join(dataDir, "events"), { recursive: true });
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots));
  const messages = walWriter(join(dataDir, "messages.db"));
  messages.exec(`
    CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));
    CREATE INDEX messages_thread_at ON messages(thread_id, at);
  `);
  const runtime = walWriter(join(dataDir, "runtime.db"));
  runtime.exec(`
    CREATE TABLE assignments (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, status TEXT NOT NULL, requester_thread_id TEXT, requester_run_id TEXT,
      assignee_bot_id TEXT NOT NULL, assignee_thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, json TEXT NOT NULL);
    CREATE TABLE assignment_events (id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
  `);
  const insertMessage = messages.prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'bot', 'activity', NULL, ?)");
  return {
    dataDir,
    messages,
    runtime,
    activity(row) {
      const tool = { name: row.name, ...(row.ok !== undefined ? { ok: row.ok } : {}), ...(row.output !== undefined ? { output: row.output } : {}) };
      const json = { id: row.id, role: "bot", kind: "activity", at: row.at, tool, ...(row.turnId ? { turnId: row.turnId } : {}), ...(row.from ? { from: { ...row.from, color: "#000" } } : {}) };
      insertMessage.run(row.threadId, row.id, row.at, JSON.stringify(json));
    },
    assignment(row) {
      runtime.prepare("INSERT OR REPLACE INTO assignments (id, root_id, status, assignee_bot_id, assignee_thread_id, created_at, json) VALUES (?, ?, ?, ?, ?, ?, '{}')")
        .run(row.id, row.id, row.status, row.botId, row.threadId, row.events[0]?.at ?? 0);
      for (const event of row.events) runtime.prepare("INSERT INTO assignment_events (assignment_id, at, kind) VALUES (?, ?, ?)").run(row.id, event.at, event.kind);
    },
    close() {
      messages.close();
      runtime.close();
    },
  };
}

export function turnCompleted(event: { eventId: string; threadId: string; turnId?: string; at: number; ok?: boolean; stopReason?: string | null; cost?: number | null }): string {
  return JSON.stringify({
    type: "turn.completed", eventId: event.eventId, provider: "claude", threadId: event.threadId, createdAt: new Date(event.at).toISOString(),
    ok: event.ok ?? true, stopReason: event.stopReason ?? "end_turn", cost: event.cost ?? 0.01,
    ...(event.turnId ? { turnId: event.turnId } : {}),
  });
}
