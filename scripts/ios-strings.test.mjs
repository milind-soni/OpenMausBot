import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The iOS app's string catalog. English is the source: each key is the
// English text (with its format arguments) that SwiftUI looks up. Every
// shipped language must carry every key, so a new screen cannot reach
// Chinese or Brazilian users half in English. Keys marked
// shouldTranslate:false (language names, the app name) are exempt.
const CATALOG = new URL("../ios/App/Localizable.xcstrings", import.meta.url);
// The shipped languages are the in-app picker's: every `case x = "…"` in
// AppLanguage except English, the source. A language added there is checked
// here without this file changing.
const APP_LANGUAGE = new URL("../ios/App/AppLanguage.swift", import.meta.url);
const LANGUAGES = [...readFileSync(APP_LANGUAGE, "utf8").matchAll(/^\s*case\s+\w+\s*=\s*"([^"]+)"/gm)]
  .map((match) => match[1])
  .filter((language) => language !== "en");

// printf arguments as Foundation reads them: an optional position (%1$@),
// flags, width, precision and length (%lld), then the conversion. %% is a
// literal percent sign and takes no argument.
const SPECIFIER = /%(?:%|(?:(\d+)\$)?[-+ #0']*\d*(?:\.\d+)?(hh|h|ll|l|q|z|t|j|L)?([@dDiuUxXoOfFeEgGcCsSpaA]))/g;

/**
 * The arguments a format string consumes, as sorted "position:conversion"
 * pairs, so a translation may reorder them with positions (%2$@ … %1$@) but
 * not drop, add or change one.
 */
function formatArguments(text) {
  const found = [];
  let next = 1;
  for (const match of text.matchAll(SPECIFIER)) {
    if (match[0] === "%%") continue;
    const position = match[1] ? Number(match[1]) : next++;
    found.push(`${position}:${match[2] ?? ""}${match[3]}`);
  }
  return found.sort();
}

/** Every stringUnit in a localization, with its path for messages. */
function units(localization, path = []) {
  const found = [];
  if (localization?.stringUnit) found.push({ path, unit: localization.stringUnit });
  for (const [kind, cases] of Object.entries(localization?.variations ?? {})) {
    for (const [name, variant] of Object.entries(cases)) {
      found.push(...units(variant, [...path, `${kind}.${name}`]));
    }
  }
  return found;
}

/** Problems with the catalog, one line per key and language. */
function catalogProblems(catalog, languages = LANGUAGES) {
  const problems = [];
  for (const [key, entry] of Object.entries(catalog.strings ?? {})) {
    if (entry.shouldTranslate === false) continue;
    const localizations = entry.localizations ?? {};
    // An English plural's forms are the source when present; otherwise the
    // key itself is the English text.
    const english = new Map(units(localizations.en).map(({ path, unit }) => [path.join("/"), unit.value]));
    const source = (path) => english.get(path.join("/")) ?? english.get("plural.other") ?? key;
    for (const language of languages) {
      const found = units(localizations[language]);
      if (found.length === 0) {
        problems.push(`${JSON.stringify(key)}: no ${language} translation`);
        continue;
      }
      for (const { path, unit } of found) {
        const where = [language, ...path].join(" ");
        if (unit.state !== "translated" || typeof unit.value !== "string" || unit.value.trim() === "") {
          problems.push(`${JSON.stringify(key)}: ${where} is not translated (state ${unit.state ?? "missing"})`);
          continue;
        }
        const expected = formatArguments(source(path));
        const actual = formatArguments(unit.value);
        if (expected.join() !== actual.join()) {
          problems.push(
            `${JSON.stringify(key)}: ${where} has format arguments [${actual}] but English has [${expected}]`,
          );
        }
      }
    }
  }
  return problems;
}

describe("iOS string catalog", () => {
  it("checks the languages the app offers", () => {
    expect(LANGUAGES).toEqual(expect.arrayContaining(["pt-BR", "zh-Hans", "zh-Hant"]));
  });

  it("translates every key into each shipped language with the English format arguments", () => {
    const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
    expect(catalogProblems(catalog)).toEqual([]);
  });

  it("names a key whose translation is missing, unfinished or drops an argument", () => {
    const translated = (value) => ({ stringUnit: { state: "translated", value } });
    const catalog = {
      strings: {
        "English": { shouldTranslate: false },
        "Live with %@": {
          localizations: {
            "pt-BR": translated("Ao vivo com %@"),
            "zh-Hans": translated("与 %@ 通话中"),
            "zh-Hant": { stringUnit: { state: "needs_review", value: "與 %@ 通話中" } },
          },
        },
        "%1$@ is on a call with %2$@.": {
          localizations: {
            "pt-BR": translated("%1$@ está em uma ligação com %2$@."),
            "zh-Hans": translated("%2$@ 正在与 %1$@ 通话。"),
            "zh-Hant": translated("正在通話。"),
          },
        },
        "%lld minutes": {
          localizations: {
            en: { variations: { plural: { one: translated("%lld minute"), other: translated("%lld minutes") } } },
            "pt-BR": { variations: { plural: { one: translated("%lld minuto"), other: translated("%d minutos") } } },
            "zh-Hans": translated("%lld 分钟"),
          },
        },
      },
    };
    expect(catalogProblems(catalog, ["pt-BR", "zh-Hans", "zh-Hant"])).toEqual([
      `"Live with %@": zh-Hant is not translated (state needs_review)`,
      `"%1$@ is on a call with %2$@.": zh-Hant has format arguments [] but English has [1:@,2:@]`,
      `"%lld minutes": pt-BR plural.other has format arguments [1:d] but English has [1:lld]`,
      `"%lld minutes": no zh-Hant translation`,
    ]);
  });

  it("reads positions, lengths and literal percent signs the way Foundation does", () => {
    expect(formatArguments("%@ is on a call with %@.")).toEqual(["1:@", "2:@"]);
    expect(formatArguments("%2$@ 正在与 %1$@ 通话。")).toEqual(["1:@", "2:@"]);
    expect(formatArguments("%lld%% done, %.1f left")).toEqual(["1:lld", "2:f"]);
    expect(formatArguments("No arguments")).toEqual([]);
  });
});
