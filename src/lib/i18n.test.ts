import { afterEach, describe, expect, it } from "vitest";

import { resolveLocale, setLocale, t, tFromServer } from "./i18n";
import { en, localeChoices, locales } from "@/locales";

afterEach(() => {
  setLocale("en");
});

describe("resolveLocale", () => {
  const available = new Set(["en", "de", "pt-br", "zh", "zh-hant", "zh-tw"]);

  it("keeps a registered exact tag, case-insensitively", () => {
    expect(resolveLocale("pt-BR", available)).toBe("pt-br");
    expect(resolveLocale("de", available)).toBe("de");
  });

  it("falls back from a regional tag to its base language", () => {
    expect(resolveLocale("de-AT", available)).toBe("de");
  });

  it("falls back through script tags before the base language", () => {
    expect(resolveLocale("zh-Hant-TW", available)).toBe("zh-hant");
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
    expect(resolveLocale("zh-TW", available)).toBe("zh-tw");
    expect(resolveLocale("zh-Hant-TW", available)).toBe("zh-hant");
    expect(resolveLocale("zh-HK", available)).toBe("zh-hk");
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

  it("ships translated model and trusted-access help for threads", () => {
    for (const [code, pack] of Object.entries(locales)) {
      if (code === "en") continue;
      for (const key of ["model.threadBusy", "model.chooseThreadHint", "approvalMode.threadTrustedNotice"] as const) {
        expect(pack[key], `${code}: ${key}`).toBeTruthy();
        expect(pack[key], `${code}: ${key}`).not.toBe(en[key]);
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

// The server picks which note a held approval card shows; the renderer picks
// the language. A key this build has never heard of must still read.
describe("tFromServer", () => {
  it("translates a key the catalog knows", () => {
    locales["zz"] = { "approval.held.destructive": "Sieht zerstoererisch aus." };
    try {
      setLocale("zz");
      expect(tFromServer("approval.held.destructive", "This looks destructive, so Approve for me stopped to ask."))
        .toBe("Sieht zerstoererisch aus.");
    } finally {
      delete locales["zz"];
      setLocale("en");
    }
  });

  it("falls back to English for a key this build does not carry", () => {
    expect(tFromServer("approval.held.inventedLater", "A note from a newer server."))
      .toBe("A note from a newer server.");
  });

  it.each(["constructor", "toString", "__proto__"])("rejects inherited catalog property %s", (key) => {
    expect(tFromServer(key, "A note from the server.")).toBe("A note from the server.");
  });

  it("shows a card that carries only text, and nothing when it carries neither", () => {
    expect(tFromServer(undefined, "Routine could not be applied: disk full"))
      .toBe("Routine could not be applied: disk full");
    expect(tFromServer(undefined, undefined)).toBeUndefined();
  });

  // The rule these notes have to keep — a note must name a button the reader
  // can see — now lives in ApprovalModeSelector.i18n.test.ts, which checks the
  // note against the label the selector renders in that same language. The
  // labels used to be hardcoded English, so this file pinned the English words
  // instead; the selector reads the catalog now.

  it("prefers the catalog over stale text saved with an older card", () => {
    expect(tFromServer("approval.held.destructive", "This looked destructive, so auto mode stopped to ask."))
      .toBe(en["approval.held.destructive"]);
  });
});
