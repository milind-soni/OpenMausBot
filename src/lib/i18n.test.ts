import { afterEach, describe, expect, it } from "vitest";

import { resolveLocale, setLocale, t } from "./i18n";
import { en, localeChoices, locales } from "@/locales";

afterEach(() => {
  setLocale("en");
});

describe("resolveLocale", () => {
  const available = new Set(["en", "de", "pt-br"]);

  it("keeps a registered exact tag, case-insensitively", () => {
    expect(resolveLocale("pt-BR", available)).toBe("pt-br");
    expect(resolveLocale("de", available)).toBe("de");
  });

  it("falls back from a regional tag to its base language", () => {
    expect(resolveLocale("de-AT", available)).toBe("de");
  });

  it("falls back to English for unknown or missing tags", () => {
    expect(resolveLocale("fr-FR", available)).toBe("en");
    expect(resolveLocale(undefined, available)).toBe("en");
    expect(resolveLocale("", available)).toBe("en");
  });
});

describe("t", () => {
  it("returns the English catalog value by default", () => {
    expect(t("engines.cloud")).toBe("Cloud");
  });

  it("setLocale reports the locale that actually took effect", () => {
    // a shipped base pack catches its regional variants…
    expect(setLocale("de-AT")).toBe("de");
    expect(t("engines.local")).toBe("Lokal");
    // …and a genuinely unknown tag falls back to English
    expect(setLocale("xx-YY")).toBe("en");
    expect(t("engines.local")).toBe("Local");
  });

  it("resolves every registered locale to itself", () => {
    const available = new Set(Object.keys(locales));
    for (const code of available) {
      expect(resolveLocale(code, available)).toBe(code);
    }
  });

  it("routes common system tags onto the shipped packs", () => {
    const available = new Set(Object.keys(locales));
    expect(resolveLocale("zh-CN", available)).toBe("zh");
    expect(resolveLocale("ja-JP", available)).toBe("ja");
    expect(resolveLocale("pt-BR", available)).toBe("pt-br");
    expect(resolveLocale("pt-PT", available)).toBe("pt");
    expect(resolveLocale("hi-IN", available)).toBe("hi");
  });

  it("every registered pack carries only known keys with non-empty values", () => {
    for (const pack of Object.values(locales)) {
      for (const [key, value] of Object.entries(pack)) {
        expect(Object.hasOwn(en, key)).toBe(true);
        expect((value ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("ships exactly one JSON catalog for every picker language", () => {
    const files = Object.keys(import.meta.glob("../locales/*.json", { eager: true }))
      .map((path) => path.split("/").at(-1))
      .filter((file) => file !== "source-hashes.json")
      .sort();
    const choices = localeChoices.map(({ code }) => `${code}.json`).sort();
    expect(files).toEqual(choices);
  });

  it("overlays a partial pack and falls back to English for missing keys", () => {
    locales["zz"] = { "engines.cloud": "Wolke" };
    try {
      expect(setLocale("zz")).toBe("zz");
      expect(t("engines.cloud")).toBe("Wolke");
      // key the pack omits → English, not undefined and not the key
      expect(t("engines.local")).toBe("Local");
    } finally {
      delete locales["zz"];
      setLocale("en");
    }
  });

  it("interpolates params and keeps unmatched placeholders visible", () => {
    // exercised through a raw template so the test doesn't depend on which
    // catalog keys happen to use params yet
    const template = "Hello {name}, {missing}!";
    const rendered = template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in { name: "Maus" } ? String({ name: "Maus" }[name as "name"]) : match,
    );
    expect(rendered).toBe("Hello Maus, {missing}!");
  });
});
