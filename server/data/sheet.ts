// The sheet: the ordered cards a bot's Data tab shows, persisted as
// sheet.json beside data.duckdb in the bot folder. Cards keep their SQL and
// their chart spec, never their rows: rows live in DuckDB (omb_results) and
// the panel pages them, so the file stays small enough to send whole on
// every change. One store per bot; the tools and the panel routes share it.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_LIMITS, type DataBroadcast, type DataCard, type DataSheet, type DataSource } from "../../shared/data-surface.ts";
import { writeFileAtomic } from "../atomic.ts";
import { botFolder } from "../bot-folder.ts";

export const SHEET_FILE = "sheet.json";

export function sheetFile(botId: string): string {
  return join(botFolder(botId), SHEET_FILE);
}

/** On disk: the sheet plus one counter. Card ids (`c_<n>`) and result
 * tables (`q_<n>`) draw from it, so an id is never reused after a delete
 * and a model holding an old id can never be answered with another card. */
type StoredSheet = DataSheet & { seq: number };

export interface SheetDeps {
  botId: string;
  /** The folder sheet.json lives in. Default: the bot folder. */
  dir?: string;
  /** Sends the whole sheet to every client after a change. */
  broadcast?: (frame: DataBroadcast) => void;
  /** Drops a deleted or pruned card's result table (BotDatabase.dropResult). */
  dropResult?: (name: string) => Promise<void>;
  now?: () => Date;
  /** Default DATA_LIMITS.sheetCardsMax. */
  cardsMax?: number;
}

export type NewCard = Omit<DataCard, "id" | "createdAt" | "updatedAt" | "status"> & Partial<Pick<DataCard, "status">>;

export class DataSheetStore {
  readonly botId: string;
  private readonly dir: string;
  private readonly deps: SheetDeps;
  private stored: StoredSheet | null = null;

  constructor(deps: SheetDeps) {
    this.deps = deps;
    this.botId = deps.botId;
    this.dir = deps.dir ?? botFolder(deps.botId);
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private load(): StoredSheet {
    if (this.stored) return this.stored;
    const fresh = (): StoredSheet => ({ version: 1, botId: this.botId, cards: [], sources: [], updatedAt: this.now(), seq: 0 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, SHEET_FILE), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`data sheet for ${this.botId}: unreadable, starting empty (${String(error)})`);
      this.stored = fresh();
      return this.stored;
    }
    const sheet = parsed as Partial<StoredSheet> | null;
    if (!sheet || typeof sheet !== "object" || sheet.version !== 1 || !Array.isArray(sheet.cards) || !Array.isArray(sheet.sources)) {
      console.warn(`data sheet for ${this.botId}: unexpected shape, starting empty`);
      this.stored = fresh();
      return this.stored;
    }
    const cards = sheet.cards.filter((card): card is DataCard => !!card && typeof card === "object" && typeof card.id === "string");
    // A card still "running" was cut off by a restart: nothing will finish it.
    const now = this.now();
    for (const card of cards) {
      if (card.status === "running") {
        card.status = "failed";
        card.error = { code: "cancelled", message: "The server restarted while this ran." };
        card.updatedAt = now;
      }
    }
    const highest = cards.reduce((max, card) => Math.max(max, Number(/^c_(\d+)$/.exec(card.id)?.[1] ?? 0)), 0);
    this.stored = {
      version: 1,
      botId: this.botId,
      cards,
      sources: sheet.sources.filter((source): source is DataSource => !!source && typeof source === "object" && typeof source.name === "string"),
      ...(Array.isArray(sheet.tables) ? { tables: sheet.tables } : {}),
      updatedAt: typeof sheet.updatedAt === "string" ? sheet.updatedAt : now,
      seq: Math.max(Number.isSafeInteger(sheet.seq) ? (sheet.seq as number) : 0, highest),
    };
    return this.stored;
  }

  private save(): void {
    const stored = this.load();
    stored.updatedAt = this.now();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.dir, SHEET_FILE), JSON.stringify(stored, null, 2), { mode: 0o600 });
    this.deps.broadcast?.({ kind: "data", botId: this.botId, sheet: this.sheet() });
  }

  /** The sheet as clients and tools see it (no counter). */
  sheet(): DataSheet {
    const { version, botId, cards, sources, tables, updatedAt } = this.load();
    return { version, botId, cards, sources, ...(tables ? { tables } : {}), updatedAt };
  }

  cards(): DataCard[] {
    return this.load().cards;
  }

  card(id: string): DataCard | undefined {
    return this.load().cards.find((card) => card.id === id);
  }

  /** What `data_show` returns so the model knows what the person sees. */
  outline(): Array<{ id: string; title: string; kind: DataCard["kind"] }> {
    return this.load().cards.map(({ id, title, kind }) => ({ id, title, kind }));
  }

  /** A result table name no earlier result used: `q_<n>` for data_sql. */
  nextResultName(prefix = "q"): string {
    const stored = this.load();
    stored.seq += 1;
    return `${prefix}_${stored.seq}`;
  }

  /** Appends a card (newest at the bottom), prunes past the cap, saves. */
  async addCard(input: NewCard): Promise<DataCard> {
    const stored = this.load();
    stored.seq += 1;
    const now = this.now();
    const card: DataCard = { ...input, id: `c_${stored.seq}`, status: input.status ?? "running", createdAt: now, updatedAt: now };
    stored.cards.push(card);
    await this.prune();
    this.save();
    return card;
  }

  /** Changes a card in place; `id` and `createdAt` never change. */
  updateCard(id: string, patch: Partial<Omit<DataCard, "id" | "createdAt">>): DataCard | undefined {
    const stored = this.load();
    const index = stored.cards.findIndex((card) => card.id === id);
    if (index === -1) return undefined;
    const card: DataCard = { ...stored.cards[index]!, ...patch, id, createdAt: stored.cards[index]!.createdAt, updatedAt: this.now() };
    stored.cards[index] = card;
    this.save();
    return card;
  }

  async removeCard(id: string): Promise<boolean> {
    const stored = this.load();
    const index = stored.cards.findIndex((card) => card.id === id);
    if (index === -1) return false;
    const [card] = stored.cards.splice(index, 1);
    await this.dropResultOf(card!);
    this.save();
    return true;
  }

  /** Records a load; a table loaded again replaces its earlier entry. */
  recordSource(source: DataSource): void {
    const stored = this.load();
    const index = stored.sources.findIndex((entry) => entry.name === source.name);
    if (index === -1) stored.sources.push(source);
    else stored.sources[index] = source;
    this.recordTable({ name: source.name, ...(source.sqlName ? { sqlName: source.sqlName } : {}), rowCount: source.rowCount, columns: source.columns });
  }

  recordTable(table: NonNullable<DataSheet["tables"]>[number]): void {
    const stored = this.load();
    const tables = (stored.tables ?? stored.sources.map(({ name, sqlName, rowCount, columns }) => ({ name, ...(sqlName ? { sqlName } : {}), rowCount, columns })))
      .filter((entry) => entry.name !== table.name);
    stored.tables = [...tables, table];
    this.save();
  }

  recordTables(tables: NonNullable<DataSheet["tables"]>): void {
    const stored = this.load();
    if (JSON.stringify(stored.tables) === JSON.stringify(tables)) return;
    stored.tables = tables;
    this.save();
  }

  removeSource(name: string): void {
    const stored = this.load();
    const before = stored.sources.length;
    stored.sources = stored.sources.filter((entry) => entry.name !== name);
    if (stored.sources.length !== before) this.save();
  }

  /** Over the cap, the oldest unpinned card goes first; only when every
   * older card is pinned does the oldest pinned one go. The card just added
   * is never the one removed. Their result tables are dropped with them, so
   * a sheet never leaks tables it no longer shows. */
  private async prune(): Promise<void> {
    const stored = this.load();
    const max = this.deps.cardsMax ?? DATA_LIMITS.sheetCardsMax;
    while (stored.cards.length > max) {
      const index = Math.max(0, stored.cards.slice(0, -1).findIndex((card) => !card.pinned));
      const [card] = stored.cards.splice(index, 1);
      await this.dropResultOf(card!);
    }
  }

  private async dropResultOf(card: DataCard): Promise<void> {
    if (!card.result || !this.deps.dropResult) return;
    try {
      await this.deps.dropResult(card.result);
    } catch (error) {
      console.warn(`data sheet for ${this.botId}: could not drop ${card.result} (${String(error)})`);
    }
  }
}

/** One store per bot for the whole server: the tools (internal MCP route)
 * and the panel routes must see the same cards. */
export class DataSheetRegistry {
  private readonly stores = new Map<string, DataSheetStore>();
  private readonly deps: { broadcast: (frame: DataBroadcast) => void; dropResult: (botId: string, name: string) => Promise<void>; dir?: (botId: string) => string };
  constructor(deps: { broadcast: (frame: DataBroadcast) => void; dropResult: (botId: string, name: string) => Promise<void>; dir?: (botId: string) => string }) { this.deps = deps; }

  for(botId: string): DataSheetStore {
    let store = this.stores.get(botId);
    if (!store) {
      store = new DataSheetStore({
        botId,
        dir: this.deps.dir?.(botId),
        broadcast: this.deps.broadcast,
        dropResult: (name) => this.deps.dropResult(botId, name),
      });
      this.stores.set(botId, store);
    }
    return store;
  }

  /** Drops the in-memory store (a test, or a bot whose folder is gone). */
  forget(botId: string): void {
    this.stores.delete(botId);
  }

  /** When a bot is deleted: forget the store and remove its sheet.json. */
  delete(botId: string): void {
    const dir = this.deps.dir?.(botId) ?? botFolder(botId);
    this.stores.delete(botId);
    rmSync(join(dir, SHEET_FILE), { force: true });
  }
}
