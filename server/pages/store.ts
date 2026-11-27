import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PAGE_ID, type PublishedPageVisibility } from "../../shared/published-page.ts";
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
  /** Absent means public. An owner-only page is kept in `owner-pages.json` and served by this server behind the owner's
   * sign-in, never uploaded to the pages Worker. */
  visibility?: PublishedPageVisibility;
  /** Published again by itself whenever its folder changes (publish_page `live`). */
  live?: true;
  /** The folder's fingerprint when it was last published, for a live page. */
  signature?: string;
  /** The upload's answer was lost: the page may be public, and stays listed so it can be unpublished. */
  uncertain?: boolean;
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

  /** Records a publish (a new page or an update) and the card that shows it. `visibility` is "owner" only for the separate
   * owner-only file; a public record carries no field, so a page from before the setting reads as public. */
  published(input: { pageId: string; url: string; title: string; botId: string; source: string; card: { threadId: string; messageId: string } | null;
    live?: boolean; signature?: string | null; uncertain?: boolean; visibility?: PublishedPageVisibility }, now = Date.now()): PublishedPageRecord {
    const existing = this.get(input.pageId);
    const cards = [...(existing?.cards ?? []), ...(input.card ? [input.card] : [])].slice(-MAX_CARDS);
    const record: PublishedPageRecord = { pageId: input.pageId, url: input.url, title: input.title, botId: input.botId, source: input.source, cards,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
      ...(input.visibility === "owner" ? { visibility: "owner" as const } : {}),
      ...(input.live ? { live: true as const, ...(input.signature ? { signature: input.signature } : {}) } : {}), ...(input.uncertain ? { uncertain: true } : {}) };
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

/** Both files: pages anyone with the link can open (`published-pages.json`, the one every release reads) and owner-only
 * pages (`owner-pages.json`, which a release before this one never opens). Keeping them apart means a rollback leaves an
 * owner-only page untouched and cannot republish it to the public Worker. */
export class PagesStore {
  private readonly publicPages: PublishedPagesStore;
  private readonly ownerPages: PublishedPagesStore;

  constructor(dataDir: string) {
    this.publicPages = new PublishedPagesStore(join(dataDir, "published-pages.json"));
    this.ownerPages = new PublishedPagesStore(join(dataDir, "owner-pages.json"));
  }

  get(pageId: string): PublishedPageRecord | null {
    return this.publicPages.get(pageId) ?? this.ownerPages.get(pageId);
  }

  fromSource(botId: string, source: string): PublishedPageRecord | null {
    return this.publicPages.fromSource(botId, source) ?? this.ownerPages.fromSource(botId, source);
  }

  list(): readonly PublishedPageRecord[] {
    return [...this.publicPages.list(), ...this.ownerPages.list()];
  }

  /** Records an owner-only publish; every other publish is a public page. */
  published(input: Parameters<PublishedPagesStore["published"]>[0], now = Date.now()): PublishedPageRecord {
    return (input.visibility === "owner" ? this.ownerPages : this.publicPages).published(input, now);
  }

  forget(pageId: string): PublishedPageRecord | null {
    return this.publicPages.forget(pageId) ?? this.ownerPages.forget(pageId);
  }

  /** Takes the record from one file only, for a page whose visibility changes: the other file's record stays until the
   * switch has gone through. */
  forgetPublic(pageId: string): PublishedPageRecord | null {
    return this.publicPages.forget(pageId);
  }

  forgetOwner(pageId: string): PublishedPageRecord | null {
    return this.ownerPages.forget(pageId);
  }
}
