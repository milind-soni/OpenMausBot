import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GroupThreadUsage } from "../shared/wire.ts";

type Row = { at: string; threadId: string; botId: string; botName?: string; input: number; output: number; cachedInput?: number; costUsd?: number | null };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const valid = (row: Partial<Row> | null): row is Row => Boolean(row && typeof row.threadId === "string" && typeof row.botId === "string" && typeof row.at === "string" && Number.isFinite(Date.parse(row.at)) && finite(row.input) && finite(row.output));

type Summary = { usage: GroupThreadUsage; lastAt: number };
function addRow(totals: Map<string, Summary>, row: Row) {
  const summary = totals.get(row.threadId) ?? { usage: { input: 0, output: 0, costUsd: null, turns: 0, cachedInput: 0 }, lastAt: -Infinity };
  const total = summary.usage;
  const input = Math.trunc(row.input), output = Math.trunc(row.output);
  const cached = finite(row.cachedInput) ? Math.min(input, Math.trunc(row.cachedInput)) : undefined;
  total.input += input; total.output += output; total.turns++;
  if (cached === undefined) delete total.cachedInput;
  else if (total.cachedInput !== undefined) total.cachedInput += cached;
  if (finite(row.costUsd)) total.costUsd = (total.costUsd ?? 0) + row.costUsd;
  const at = Date.parse(row.at);
  if (at >= summary.lastAt) {
    summary.lastAt = at;
    total.lastTurn = { input, output, ...(cached === undefined ? {} : { cachedInput: cached }), costUsd: finite(row.costUsd) ? row.costUsd : null };
    total.lastSpeaker = { botId: row.botId, name: typeof row.botName === "string" && row.botName ? row.botName : row.botId };
  }
  totals.set(row.threadId, summary);
}

/** Cache per-month/per-thread summaries, not the complete ledger in memory. */
export class GroupUsageReader {
  private files = new Map<string, { stamp: string; totals: Map<string, Summary> }>();
  private signature = "";
  private totals = new Map<string, GroupThreadUsage>();
  private dataDir: string;
  constructor(dataDir: string) { this.dataDir = dataDir; }

  /** Refresh only at startup or after ledger persistence, never on an SSE lookup. */
  refresh(): void {
    const dir = join(this.dataDir, "usage");
    let names: string[];
    try { names = readdirSync(dir).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    const files = names.map(name => {
      const stat = statSync(join(dir, name));
      return { name, stamp: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}` };
    });
    const signature = JSON.stringify(files);
    if (signature !== this.signature) {
      const next = new Map<string, { stamp: string; totals: Map<string, Summary> }>();
      for (const { name, stamp } of files) {
        let entry = this.files.get(name);
        if (entry?.stamp !== stamp) {
          const totals = new Map<string, Summary>();
          for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
            try { const row = JSON.parse(line); if (valid(row)) addRow(totals, row); } catch { /* incomplete or damaged row */ }
          }
          entry = { stamp, totals };
        }
        next.set(name, entry);
      }
      const summaries = new Map<string, Summary>();
      for (const entry of next.values()) {
        for (const [threadId, part] of entry.totals) {
          const total = summaries.get(threadId);
          if (!total) summaries.set(threadId, structuredClone(part));
          else {
            total.usage.input += part.usage.input;
            total.usage.output += part.usage.output;
            total.usage.turns += part.usage.turns;
            if (total.usage.cachedInput === undefined || part.usage.cachedInput === undefined) delete total.usage.cachedInput;
            else total.usage.cachedInput += part.usage.cachedInput;
            if (part.usage.costUsd !== null) total.usage.costUsd = (total.usage.costUsd ?? 0) + part.usage.costUsd;
            if (part.lastAt >= total.lastAt) {
              total.lastAt = part.lastAt;
              total.usage.lastTurn = part.usage.lastTurn;
              total.usage.lastSpeaker = part.usage.lastSpeaker;
            }
          }
        }
      }
      const totals = new Map([...summaries].map(([id, value]) => [id, value.usage]));
      this.files = next;
      this.totals = totals;
      this.signature = signature;
    }
  }

  forThread(threadId: string): GroupThreadUsage | undefined {
    const usage = this.totals.get(threadId);
    return usage ? structuredClone(usage) : undefined;
  }
}
