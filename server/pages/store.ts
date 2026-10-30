import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PAGE_ID } from "../../shared/published-page.ts";
import { writeFileAtomic } from "../atomic.ts";

/** One page this server published: its link, the bot that owns it, the file or folder it came from, and the chat cards
 * that show it (patched when it is unpublished). */
export interface PublishedPageRecord {
  pageId: string;
  url: string;
  title: string;
  botId: string;
  source: string;
  cards: Array<{ threadId: string; messageId: string }>;
  createdAt: number;
  updatedAt: number;
}

const MAX_RECORDS = 5_000, MAX_CARDS = 50;

/** The pages this server published, kept in one small JSON file in the data dir. Unpublished pages are dropped. */
export class PublishedPagesStore {
  private records: PublishedPageRecord[];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.records = PublishedPagesStore.read(file);
  }

  private static read(file: string): PublishedPageRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; pages?: unknown };
      return parsed.version === 1 && Array.isArray(parsed.pages)
        ? parsed.pages.filter((page): page is PublishedPageRecord => typeof page?.pageId === "string" && PAGE_ID.test(page.pageId) && typeof page.url === "string" && typeof page.botId === "string")
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, pages: this.records }), { mode: 0o600 });
  }

  get(pageId: string): PublishedPageRecord | null {
    return this.records.find((record) => record.pageId === pageId) ?? null;
  }

  /** The bot's own page from this file or folder, so publishing it again keeps its link. */
  fromSource(botId: string, source: string): PublishedPageRecord | null {
    return this.records.find((record) => record.botId === botId && record.source === source) ?? null;
  }

  list(): readonly PublishedPageRecord[] {
    return this.records;
  }

  /** Records a publish (a new page or an update) and the card that shows it. */
  published(input: { pageId: string; url: string; title: string; botId: string; source: string; card: { threadId: string; messageId: string } | null }, now = Date.now()): PublishedPageRecord {
    const existing = this.get(input.pageId);
    const cards = [...(existing?.cards ?? []), ...(input.card ? [input.card] : [])].slice(-MAX_CARDS);
    const record: PublishedPageRecord = { pageId: input.pageId, url: input.url, title: input.title, botId: input.botId, source: input.source, cards,
      createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.records = [...this.records.filter((each) => each.pageId !== input.pageId), record].slice(-MAX_RECORDS);
    this.save();
    return record;
  }

  forget(pageId: string): PublishedPageRecord | null {
    const existing = this.get(pageId);
    if (!existing) return null;
    this.records = this.records.filter((record) => record.pageId !== pageId);
    this.save();
    return existing;
  }
}
