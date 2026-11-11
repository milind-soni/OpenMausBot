// Cards keep their SQL and chart spec, never their rows: rows live in DuckDB, so the file is small enough to send whole.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_LIMITS, type DataBroadcast, type DataCard, type DataSheet, type DataSource } from "../../shared/data-surface.ts";
import { writeFileAtomic } from "../atomic.ts";
import { botFolder } from "../bot-folder.ts";

export const SHEET_FILE = "sheet.json";

export function sheetFile(botId: string): string {
  return join(botFolder(botId), SHEET_FILE);
}

/** Card ids and result tables draw from one counter: an old id can never answer with another card. */
type StoredSheet = DataSheet & { seq: number };

export interface SheetDeps {
  botId: string;
  dir?: string;
  broadcast?: (frame: DataBroadcast) => void;
  dropResult?: (name: string) => Promise<void>;
  now?: () => Date;
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
      updatedAt: typeof sheet.updatedAt === "string" ? sheet.updatedAt : now,
      seq: Math.max(Number.isSafeInteger(sheet.seq) ? (sheet.seq as number) : 0, highest),
    };
    return this.stored;
  }

  private save(): void {
    const stored = this.load();
    stored.updatedAt = this.now();
    this.persist();
    this.deps.broadcast?.({ kind: "data", botId: this.botId, sheet: this.sheet() });
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.dir, SHEET_FILE), JSON.stringify(this.load(), null, 2), { mode: 0o600 });
  }

  sheet(): DataSheet {
    const { version, botId, cards, sources, updatedAt } = this.load();
    return { version, botId, cards, sources, updatedAt };
  }

  cards(): DataCard[] {
    return this.load().cards;
  }

  card(id: string): DataCard | undefined {
    return this.load().cards.find((card) => card.id === id);
  }

  outline(): Array<{ id: string; title: string; kind: DataCard["kind"] }> {
    return this.load().cards.map(({ id, title, kind }) => ({ id, title, kind }));
  }

  nextResultName(prefix = "q"): string {
    const stored = this.load();
    stored.seq += 1;
    // data_sql can materialise a persistent table without ever saving a card.
    // Reserve its name on disk before the query can replace an older result.
    this.persist();
    return `${prefix}_${stored.seq}`;
  }

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

  recordSource(source: DataSource): void {
    const stored = this.load();
    const index = stored.sources.findIndex((entry) => entry.name === source.name);
    if (index === -1) stored.sources.push(source);
    else stored.sources[index] = source;
    this.save();
  }

  removeSource(name: string): void {
    const stored = this.load();
    const before = stored.sources.length;
    stored.sources = stored.sources.filter((entry) => entry.name !== name);
    if (stored.sources.length !== before) this.save();
  }

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

/** One store per bot for the whole server: the tools and the panel routes must see the same cards. */
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

  forget(botId: string): void {
    this.stores.delete(botId);
  }

  delete(botId: string): void {
    const dir = this.deps.dir?.(botId) ?? botFolder(botId);
    this.stores.delete(botId);
    rmSync(join(dir, SHEET_FILE), { force: true });
  }
}
