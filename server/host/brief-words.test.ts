import { describe, expect, it } from "vitest";

import en from "../../src/locales/en.json" with { type: "json" };
import ptBr from "../../src/locales/pt-br.json" with { type: "json" };
import { briefWords } from "./brief-words.ts";

describe.each([
  ["en", en],
  ["pt-br", ptBr],
] as const)("brief words in %s", (language, catalog) => {
  it("keeps retry wording in sync with the catalog", () => {
    expect(briefWords(language).tryAgainSoon).toBe(catalog["brief.row.tryAgainSoon"]);
  });

  it.each([0, 1, 3, 40])("keeps the caption for %i chats in sync with the catalog", (count) => {
    expect(briefWords(language).noticedAcross(count)).toBe(catalog["brief.row.noticedAcross"].replace("{count}", String(count)));
  });
});

describe("pt-BR brief rows", () => {
  const words = briefWords("pt-br");

  it("keeps static rows in sync with the catalog", () => {
    expect(words.intro).toBe(ptBr["brief.card.intro"]);
    expect(words.needsYou).toBe(ptBr["brief.card.needsYou"]);
    expect(words.nothingNeedsYou).toBe(ptBr["brief.card.nothingNeedsYou"]);
    expect(words.waitingMany).toBe(ptBr["brief.card.waitingMany"]);
    expect(words.didNotFinish).toBe(ptBr["brief.row.didNotFinish"]);
    expect(words.unsorted).toBe(ptBr["brief.row.unfenced"]);
    expect(words.signInAgain).toBe(ptBr["brief.row.signInAgain"]);
  });

  it.each([0, 1, 3, 40])("keeps the backlog for %i emails in sync with the catalog", (count) => {
    const key = count === 1 ? "brief.card.waitingOne" : "brief.card.waitingOther";
    expect(words.waitingCount(count)).toBe(ptBr[key].replace("{count}", String(count)));
  });

  it("keeps app and bot details in sync with the catalog", () => {
    expect(words.draftReply("Ada")).toBe(ptBr["brief.card.draftReply"].replace("{who}", "Ada"));
    expect(words.couldNotRead("Gmail")).toBe(ptBr["brief.row.cantRead"].replace("{app}", "Gmail"));
    expect(words.unsortedNote("Scout")).toBe(ptBr["brief.row.unfencedNote"].replace("{name}", "Scout"));
    expect(words.unpreparedNote("Scout")).toBe(ptBr["brief.row.unpreparedNote"].replace("{name}", "Scout"));
  });

  it("keeps calendar overlaps in sync with the catalog", () => {
    expect(words.overlap("Planning", "Review")).toBe(ptBr["brief.row.clash"].replace("{first}", "Planning").replace("{second}", "Review"));
  });
});
