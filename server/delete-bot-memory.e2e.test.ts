// Deleting a bot removes its conversations and its memory. The journal
// lives outside the workspace and the search index lives in the message
// database, so both have to go too. Checked against the fixture server.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";

it("deletes the memory journal and memory index with the bot", async () => {
  const fixture = await launchVerificationServer();
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async <T = unknown>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const memoryRows = (botId: string) => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM memory_files WHERE bot_id = ?").get(botId) as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  };
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Forgotten" }, 201);
    const { bot: kept } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Kept" }, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });
    await api(`/api/bots/${kept.id}`, "PATCH", { memoryUpkeep: false });
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { path: "memory/notes.md", text: "vendor list\n" });
    await api(`/api/bots/${kept.id}/memory/file`, "PUT", { path: "memory/notes.md", text: "other notes\n" });
    const journal = await api<{ entries: unknown[] }>(`/api/bots/${bot.id}/memory/journal`);
    expect(journal.entries.length).toBeGreaterThan(0);
    const journalPath = join(fixture.info.dataDir, "memory-journal", `${bot.id}.ndjson`);
    const keptJournal = join(fixture.info.dataDir, "memory-journal", `${kept.id}.ndjson`);
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(keptJournal)).toBe(true);
    await control("send", "--bot", bot.id, "--text", "Remember the vendor list.");
    expect(await control("wait", "--bot", bot.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    await control("send", "--bot", kept.id, "--text", "Remember the other notes.");
    expect(await control("wait", "--bot", kept.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(memoryRows(bot.id)).toBeGreaterThan(0);
    const keptRows = memoryRows(kept.id);
    expect(keptRows).toBeGreaterThan(0);

    expect(await api(`/api/bots/${bot.id}`, "DELETE")).toEqual({ ok: true });

    expect(existsSync(journalPath)).toBe(false);
    expect(memoryRows(bot.id)).toBe(0);
    expect(existsSync(keptJournal)).toBe(true);
    expect(memoryRows(kept.id)).toBe(keptRows);
  } finally {
    await fixture.close();
  }
}, 90_000);
