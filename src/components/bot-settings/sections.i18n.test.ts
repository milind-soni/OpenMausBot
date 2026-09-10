// The section rail is a module-scope array the dialog also searches against,
// so it carries keys rather than rendered labels. These cover that, plus the
// two sections whose copy is easy to render on its own.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { en, locales } from "@/locales";
import { runStatusLabel } from "@/lib/schedule-label";
import { BOT_SECTIONS } from "./sections";
import { HistorySection } from "./HistorySection";

afterEach(() => {
  setLocale("en");
});

describe("bot settings translation", () => {
  it("keeps the rail's labels as catalog keys", () => {
    for (const entry of BOT_SECTIONS) {
      expect(Object.hasOwn(en, entry.labelKey), entry.labelKey).toBe(true);
    }

    // Resolved at render, so the rail follows a language change.
    setLocale("pt-br");
    const labels = BOT_SECTIONS.map((entry) => t(entry.labelKey));
    expect(labels).toContain(locales["pt-br"]!["botSettings.section.overview"]);
    expect(labels).not.toContain("Overview");
  });

  it("leaves search keywords in English so the typed term still matches", () => {
    // Keywords are what someone types, and the docs and CLI use the English
    // term — translating them would break search for those users.
    const access = BOT_SECTIONS.find((entry) => entry.id === "access");
    expect(access?.keywords).toContain("workspace");
  });

  it("translates a routine run status through the shared helper", () => {
    setLocale("de");
    expect(runStatusLabel("waiting")).toBe(locales.de!["routines.status.waiting"]);
    expect(runStatusLabel("completed")).toBe(locales.de!["routines.status.completed"]);
  });

  it("translates the history section", () => {
    setLocale("ja");
    const empty = renderToStaticMarkup(createElement(HistorySection, {
      bot: { id: "atlas" },
      rows: [],
      onRollback: () => {},
    }));
    expect(empty).toContain(locales.ja!["botSettings.history.empty"]);

    const withRow = renderToStaticMarkup(createElement(HistorySection, {
      bot: { id: "atlas" },
      rows: [{ id: "r1", at: 0, actor: "user", via: "app", field: "soul", summary: "…", canRestore: true }],
      onRollback: () => {},
    }));
    expect(withRow).toContain(locales.ja!["botSettings.history.undo"]);
    expect(withRow).not.toContain("Undo this change");
  });
});
