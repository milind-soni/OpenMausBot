import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { instances: [] }, dispatch: () => {} }),
}));

const { UsageSection } = await import("./UsageSection");

const bot = (usage?: Record<string, unknown>) => ({
  id: "pepper",
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  tasks: [{ threadId: "t1", title: "t1", createdAt: 1, ...(usage ? { usage } : {}) }],
}) as any;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

afterEach(() => {
  setLocale("en");
});

describe("bot settings usage card", () => {
  it("speaks the app language", () => {
    setLocale("de");
    const shown = text(renderToStaticMarkup(createElement(UsageSection, {
      bot: bot({ input: 12_000, cachedInput: 10_000, output: 500, costUsd: 0.25, turns: 3 }),
    })));
    for (const english of ["Usage", "All bots", "Turns", "Cost "]) expect(shown).not.toContain(english);
    for (const german of ["Nutzung", "Alle Bots", "Neue Tokens", "Kosten"]) expect(shown).toContain(german);
  });

  it("labels a fresh-token figure as new tokens, as the Usage screen does", () => {
    const shown = text(renderToStaticMarkup(createElement(UsageSection, {
      bot: bot({ input: 12_000, cachedInput: 10_000, output: 500, costUsd: null, turns: 3 }),
    })));
    expect(shown).toContain("New tokens 2.5k");
  });

  it("says so in the app language when nothing is recorded yet", () => {
    setLocale("de");
    const shown = text(renderToStaticMarkup(createElement(UsageSection, { bot: bot() })));
    expect(shown).not.toContain("No usage recorded yet");
  });
});
