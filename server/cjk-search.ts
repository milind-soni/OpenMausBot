import type { DatabaseSync } from "node:sqlite";

// FTS5's unicode61 tokenizer has no CJK dictionary and indexes a whole Han or kana run as one token, so a word in the
// middle of a sentence can never match. Each CJK character becomes its own token instead (split by U+200B, which
// unicode61 treats as a separator and a reader never sees), and a query asks for its characters as phrases.
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const CJK_CHAR = new RegExp(`[${CJK}]`, "u");
const CJK_RUNS = new RegExp(`[${CJK}]+|[^${CJK}]+`, "gu");
const CJK_BOUNDARY = new RegExp(`(?<=[${CJK}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?=[${CJK}])`, "gu");
const SEARCH_MARK = /​/g;

/** Particles and filler words say nothing about what a note is about; they also end a run, so no bigram straddles one. */
const FILLER = new RegExp(
  "我们|你们|他们|她们|它们|这个|那个|一下|一个|可以|时候|现在|知道|告诉|记得|还是|就是|不是|没有|已经|因为|所以|但是|如果|然后|还有|请问|帮我|怎样|这样|那样|哪里|哪个|应该|一些|[的了是吗呢吧啊呀哦嗯么]",
  "gu",
);

export const hasCjk = (text: string): boolean => CJK_CHAR.test(text);

/** The indexed form of `text`, or null when it holds no CJK and is indexed as written. */
export function cjkSearchText(text: string | null | undefined): string | null {
  return text && hasCjk(text) ? text.replace(CJK_BOUNDARY, "​") : null;
}

export const withoutSearchMarks = (snippet: string): string => snippet.replace(SEARCH_MARK, "");

/** A quoted FTS5 phrase whose tokens line up with the indexed form. */
export const ftsPhrase = (term: string): string => `"${term.replace(/"/g, "").replace(CJK_BOUNDARY, " ")}"`;

/** `token` split into its CJK runs and the rest; each CJK run becomes its overlapping bigrams, so a paraphrase still
 * shares most of them with a note. */
export function cjkTokenParts(token: string): { other: string[]; bigrams: string[] } {
  const other: string[] = [];
  const bigrams: string[] = [];
  for (const run of token.match(CJK_RUNS) ?? []) {
    if (!hasCjk(run)) {
      other.push(run);
      continue;
    }
    for (const segment of run.replace(FILLER, " ").split(" ")) {
      const chars = [...segment];
      for (let i = 0; i + 1 < chars.length; i++) bigrams.push(chars[i]! + chars[i + 1]!);
    }
  }
  return { other, bigrams };
}

export interface SearchIndexSpec {
  table: string;
  fts: string;
  view: string;
  triggerPrefix: string;
}

/** The table's FTS5 index over `coalesce(search_text, text)`, built or migrated from the plain-text index. */
export function ensureSearchIndex(db: DatabaseSync, { table, fts, view, triggerPrefix: t }: SearchIndexSpec): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "search_text")) db.exec(`ALTER TABLE ${table} ADD COLUMN search_text TEXT`);
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(fts) as { sql: string } | undefined;
  const current = Boolean(existing?.sql.includes(`'${view}'`));
  if (!current) {
    db.exec(`DROP TRIGGER IF EXISTS ${t}_ai; DROP TRIGGER IF EXISTS ${t}_ad; DROP TRIGGER IF EXISTS ${t}_au; DROP TABLE IF EXISTS ${fts};`);
    const update = db.prepare(`UPDATE ${table} SET search_text = ? WHERE rowid = ?`);
    db.exec("BEGIN");
    try {
      for (const row of db.prepare(`SELECT rowid, text FROM ${table} WHERE text IS NOT NULL AND search_text IS NULL`).iterate()) {
        const searchText = cjkSearchText(row.text as string);
        if (searchText) update.run(searchText, row.rowid as number);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.exec(`
    CREATE VIEW IF NOT EXISTS ${view} AS SELECT rowid AS rid, coalesce(search_text, text) AS text FROM ${table};
    CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(
      text, content='${view}', content_rowid='rid', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS ${t}_ai AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${fts}(rowid, text) VALUES (new.rowid, coalesce(new.search_text, new.text));
    END;
    CREATE TRIGGER IF NOT EXISTS ${t}_ad AFTER DELETE ON ${table} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, text) VALUES ('delete', old.rowid, coalesce(old.search_text, old.text));
    END;
    CREATE TRIGGER IF NOT EXISTS ${t}_au AFTER UPDATE ON ${table} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, text) VALUES ('delete', old.rowid, coalesce(old.search_text, old.text));
      INSERT INTO ${fts}(rowid, text) VALUES (new.rowid, coalesce(new.search_text, new.text));
    END;
  `);
  if (!current) db.exec(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`);
}
