import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, closeMessageSearch, insertMessage, searchMessages, searchMessagesAsync } from "./message-db.ts";

beforeEach(async () => {
  await closeMessageSearch();
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(async () => { await closeMessageSearch(); closeMessageDb(); });

describe("case-insensitive message search outside ASCII", () => {
  it.each([
    ["ÉCOLE", "école"], ["МОСКВА", "москва"], ["ΑΘΉΝΑ", "αθήνα"], ["ÜBER", "über"],
  ])("finds %s with %s in text and tool names", async (stored, query) => {
    insertMessage("text", { id: "m1", at: 1, role: "user", kind: "text", text: `Discuss ${stored} today` });
    insertMessage("tools", { id: "m2", at: 2, role: "bot", kind: "activity", tool: { name: `Search ${stored}`, ok: true } });
    const hits = searchMessages(query);
    expect(hits.map((one) => one.messageId)).toEqual(["m2", "m1"]);
    expect(hits.map((one) => one.snippet.slice(one.matchStart, one.matchStart + one.matchLength))).toEqual([stored, stored]);
    expect(await searchMessagesAsync(query)).toEqual(hits);
    expect(searchMessages(query, 1, "text").map((one) => one.messageId)).toEqual(["m1"]);
  });

  it("keeps highlights in original string coordinates when lowercasing expands a character", async () => {
    insertMessage("text", { id: "m", at: 1, role: "user", kind: "text", text: "İ prefix İSTANBUL after" });
    for (const [query, match] of [["prefix", "prefix"], ["İSTANBUL", "İSTANBUL"], ["after", "after"]]) {
      const hits = await searchMessagesAsync(query!);
      expect(hits).toHaveLength(1);
      const hit = hits[0]!;
      expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe(match);
    }
  });

  it("preserves literal wildcard matching and limits for non-ASCII text", async () => {
    insertMessage("text", { id: "literal", at: 1, role: "user", kind: "text", text: "ÉCOLE 10%_\\ fee" });
    insertMessage("text", { id: "decoy", at: 2, role: "user", kind: "text", text: "ÉCOLE 100xx fee" });
    expect((await searchMessagesAsync("école 10%_\\")).map((one) => one.messageId)).toEqual(["literal"]);
    expect((await searchMessagesAsync("école", 1)).map((one) => one.messageId)).toEqual(["decoy"]);
  });
});
