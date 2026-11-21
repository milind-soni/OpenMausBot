import { describe, expect, it } from "vitest";

import { GOES_WELL_WITH, matchesCatalogSearch, rankAppSuggestions, searchCatalog, searchWords, STARTER_APPS } from "./app-suggestions.ts";

const card = (slug: string, extra: Partial<{ noAuth: boolean; label: string; blurb: string; categories: string[] }> = {}) => ({ slug, label: slug, blurb: "", ...extra });
const catalog = [...new Set([...STARTER_APPS, ...Object.keys(GOES_WELL_WITH), ...Object.values(GOES_WELL_WITH).flat()])].map((slug) => card(slug));
const rank = (input: Partial<Parameters<typeof rankAppSuggestions>[0]> = {}) => rankAppSuggestions({ catalog, connected: [], held: [], limit: 6, ...input }).map(({ slug }) => slug);

describe("which apps to offer", () => {
  it("offers a person with nothing connected the starter set", () => {
    expect(rank()).toEqual(STARTER_APPS.slice(0, 6));
  });

  it("offers what goes well with what they have, never what they have", () => {
    const offered = rank({ connected: ["gmail"], held: ["gmail"] });
    expect(offered.slice(0, 3)).toEqual(["googlecalendar", "googledrive", "slack"]);
    expect(offered).not.toContain("gmail");
    expect(rank({ connected: ["github"], held: ["github"] }).slice(0, 3)).toEqual(["linear", "slack", "notion"]);
    expect(rank({ connected: ["hubspot"], held: ["hubspot"] }).slice(0, 2)).toEqual(["gmail", "slack"]);
  });

  it("leaves out an app with any account, even one that isn't working", () => {
    expect(rank({ connected: ["gmail"], held: ["gmail", "googlecalendar"] })).not.toContain("googlecalendar");
  });

  it("ranks what a bot looked for first, then the decision model's order, then the pairings", () => {
    const offered = rank({ connected: ["gmail"], held: ["gmail"], wanted: ["stripe"], picks: ["zoom", "googledrive"] });
    expect(offered.slice(0, 4)).toEqual(["stripe", "zoom", "googledrive", "googlecalendar"]);
  });

  it("keeps room for the rest however much was looked for", () => {
    const offered = rank({ wanted: ["stripe", "zoom", "asana", "trello", "jira"], limit: 6 });
    expect(offered.slice(0, 3)).toEqual(["stripe", "zoom", "asana"]);
    expect(offered.slice(3)).toEqual(STARTER_APPS.filter((slug) => !["stripe", "zoom", "asana"].includes(slug)).slice(0, 3));
  });

  it("offers only catalog apps that may be connected and need a sign-in", () => {
    const small = [card("gmail"), card("slack", { noAuth: true }), card("notion")];
    expect(rankAppSuggestions({ catalog: small, connected: [], held: [], picks: ["invented"], limit: 6 }).map(({ slug }) => slug)).toEqual(["gmail", "notion"]);
    expect(rankAppSuggestions({ catalog: small, connected: [], held: [], allowed: (slug) => slug !== "gmail", limit: 6 }).map(({ slug }) => slug)).toEqual(["notion"]);
  });

  it("puts a card's own app's pairings first and never offers that app", () => {
    const offered = rank({ about: "gmail", connected: ["github"], held: ["github"] });
    expect(offered).not.toContain("gmail");
    expect(offered.slice(0, 3)).toEqual(["googlecalendar", "googledrive", "slack"]);
  });

  it("takes any name for the card's app without tripping on it", () => {
    expect(rank({ about: "constructor" })).toEqual(STARTER_APPS.slice(0, 6));
  });
});

describe("searching the catalog", () => {
  it("reads what is being looked for out of plain words", () => {
    expect(searchWords("something for spreadsheets")).toEqual(["spreadsheet"]);
    expect(searchWords("The app")).toEqual(["the", "app"]);
  });

  it("matches every word, in any order, with spaces around them", () => {
    expect(matchesCatalogSearch("Google Sheets Read and update spreadsheets", " sheets  google ")).toBe(true);
    expect(matchesCatalogSearch("Google Sheets", "sheets notion")).toBe(false);
    expect(matchesCatalogSearch("anything", "   ")).toBe(true);
  });

  it("finds apps by what they do, the closest and most used first", () => {
    const cards = [
      card("airtable", { label: "Airtable", blurb: "Bases and spreadsheets" }),
      card("excel", { label: "Excel", blurb: "A spreadsheet tool" }),
      card("spreadsheetly", { label: "Spreadsheetly", blurb: "" }),
      card("notion", { label: "Notion", blurb: "Pages" }),
    ];
    expect(searchCatalog(cards, "something for spreadsheets", 8).map(({ slug }) => slug)).toEqual(["spreadsheetly", "airtable", "excel"]);
    expect(searchCatalog(cards, "calendar", 8)).toEqual([]);
  });
});
