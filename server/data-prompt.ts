// The Data section of a bot's system prompt. The Data server is mounted on every turn its engine supports, so its tools
// are always there; its 1.2 KB guide is sent where Data is in use and a one-line pointer elsewhere. A conversation keeps
// the choice made on its first turn, so its cached prefix and its warm engine never change because of it.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { botFolder } from "./bot-folder.ts";
import { BUILT_IN_DATA_SYSTEM_PROMPT } from "./data/instructions.ts";
import { DATA_DB_FILE } from "./data/engine.ts";
import { SHEET_FILE } from "./data/sheet.ts";

/** Where the guide is not sent: enough for the bot to know the tools are there. */
export const DATA_TOOLS_POINTER =
  " You have Data tools for tables, spreadsheets and charts (data_load, data_describe, data_sql, data_show, data_export); load them with tool search when needed.";

/** Words that ask for work the Data tools do: loading, querying or charting a file, a sheet or a database. */
export const DATA_WORK_TERMS = [
  "data", "csv", "tsv", "xlsx", "xls", "parquet", "ndjson", "json", "spreadsheet", "sheet", "excel", "sql", "duckdb",
  "database", "table", "query", "chart", "graph", "plot", "pivot", "analy", "dashboard",
] as const;

/** Whether the person's words, with any Data context they attached, ask for Data work. */
export function mentionsDataWork(text: string): boolean {
  const lower = text.toLowerCase();
  return DATA_WORK_TERMS.some((term) => lower.includes(term));
}

/** Whether the bot has used Data: its database or its Data sheet exists. Nothing is opened or created. */
export function botHasData(botId: string, folder: (botId: string) => string = botFolder): boolean {
  const dir = folder(botId);
  return existsSync(join(dir, DATA_DB_FILE)) || existsSync(join(dir, SHEET_FILE));
}

/** Each conversation's choice, made on its first turn here and kept, so its stable prompt never changes because of it;
 * capped so the map cannot grow with every thread. */
export class ThreadChoices {
  private readonly chosen = new Map<string, boolean>();
  private readonly max: number;
  constructor(max = 5_000) {
    this.max = max;
  }
  get(threadId: string): boolean | undefined {
    return this.chosen.get(threadId);
  }
  set(threadId: string, guide: boolean): void {
    this.chosen.delete(threadId);
    this.chosen.set(threadId, guide);
    if (this.chosen.size > this.max) this.chosen.delete(this.chosen.keys().next().value!);
  }
}

/** The server's one decision for a turn whose Data server is mounted: the guide or the pointer. The server's own
 * instructions and tools are there either way; a bot that has used Data gets the guide in every new conversation. */
export function dataPrompts(deps: { hasData?: (botId: string) => boolean; threads?: ThreadChoices } = {}) {
  const hasData = deps.hasData ?? ((botId: string) => botHasData(botId));
  const threads = deps.threads ?? new ThreadChoices();
  return (botId: string, threadId: string, text: string): string => {
    let guide = threads.get(threadId);
    if (guide === undefined) {
      guide = hasData(botId) || mentionsDataWork(text);
      threads.set(threadId, guide);
    }
    return guide ? BUILT_IN_DATA_SYSTEM_PROMPT : DATA_TOOLS_POINTER;
  };
}
