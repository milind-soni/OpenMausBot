// Phase 4 part 2, end to end on the fake engine: a seeded notebook with a
// duplicate, a contradiction and a stale line is consolidated in one
// bounded pass, the archive file receives the stale line, the journal has
// the before and after, and a second pass changes nothing.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");
posixOnly("notebook consolidation", () => {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home = "";
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  beforeAll(async () => {
    chmodSync(fake("fake-claude-cli.ts"), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-consolidate-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: {}, config: { cli: fake("fake-claude-cli.ts"), fullAuto: true } } },
      recall: { captures: false },
    }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);
  afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); });

  it("merges the duplicate, strikes the contradiction's loser, archives the stale line, journals the pass, and is idle on a second pass", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Keeper" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" } })).status).toBe(200);
    const seeded = [
      "# Notes",
      "- 2026-09-01 · from chat \"a\" · We ship on Fridays",
      "- 2026-09-10 · from chat \"b\", captured · We ship on Fridays.",
      "- 2026-09-12 · from chat \"c\" · We do not ship on Fridays",
      "- 2025-01-01 · from chat \"d\" · importance 1 · The office plant is called Fred",
      "- 2026-09-15 · from chat \"e\" · importance 5 · The database is called moonbase",
      "- 2026-09-15 · from chat \"f\" · The team lead is Priya",
      "- 2026-09-15 · from chat \"g\" · Standup is at ten",
      "- 2026-09-15 · from chat \"h\" · The repo uses pnpm",
      "- 2026-09-15 · from chat \"i\" · Releases are tagged v-<version>",
      "- 2026-09-15 · from chat \"j\" · The office is in Pune",
      "",
    ].join("\n");
    expect((await api("PUT", `/api/bots/${bot.id}/memory`, { text: seeded })).status).toBe(200);

    const first = await api("POST", `/api/bots/${bot.id}/memory/consolidate`);
    expect(first.status).toBe(200);
    // ten live entries, floor a fifth → two changes: the duplicate and the contradiction; the stale line waits
    expect(first.body).toMatchObject({ ok: true, entries: 10, removedDuplicates: 1, superseded: 1, archived: 0, overFloor: true, judged: true });
    let text = (await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).body.text as string;
    expect(text.split("\n").filter((l) => /ship on fridays/i.test(l) && !l.includes("~~") && !/not/.test(l)).length).toBe(0); // the older duplicate removed, the newer one struck as the loser
    expect(text).toMatch(/~~We ship on Fridays\.~~ · superseded \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("We do not ship on Fridays");
    expect(text).toContain("office plant"); // not yet: the floor
    expect(text).toContain("moonbase");
    const journal = (await api("GET", `/api/bots/${bot.id}/memory/journal`)).body;
    const entries = (journal.entries ?? journal) as any[];
    expect(entries.some((e: any) => e.via === "consolidate")).toBe(true);

    // the second pass archives the stale line; the third is idle
    const second = await api("POST", `/api/bots/${bot.id}/memory/consolidate`);
    expect(second.body).toMatchObject({ ok: true, removedDuplicates: 0, superseded: 0, archived: 1, overFloor: false });
    text = (await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).body.text as string;
    expect(text).not.toContain("office plant");
    const archive = (await api("GET", `/api/bots/${bot.id}/memory/file?path=memory/archive.md`)).body.text as string;
    expect(archive).toMatch(/office plant is called Fred · archived \d{4}-\d{2}-\d{2}/);
    const third = await api("POST", `/api/bots/${bot.id}/memory/consolidate`);
    expect(third.body).toMatchObject({ ok: true, removedDuplicates: 0, superseded: 0, archived: 0, overFloor: false });
  }, 120_000);
});
