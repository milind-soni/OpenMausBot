import { expect, it } from "vitest";

import { byLanguage, intlLocale } from "./language.ts";

it("picks the pack the app would: exact, alias, parent, else English", () => {
  const table = { en: "en", fr: "fr", "pt-br": "pt-br", "zh-tw": "zh-tw" };
  expect([" PT-BR ", "pt", "pt-PT", "zh-HK", "zh-Hant-TW", "fr-CA", "xx", undefined, ""].map((language) => byLanguage(table, language)))
    .toEqual(["pt-br", "pt-br", "pt-br", "zh-tw", "zh-tw", "fr", "en", "en", "en"]);
});

it("formats in the language set, and in US English when none or a bad one is set", () => {
  expect([intlLocale("pt-br"), intlLocale(undefined), intlLocale("not a locale!")]).toEqual(["pt-BR", "en-US", "en-US"]);
});
