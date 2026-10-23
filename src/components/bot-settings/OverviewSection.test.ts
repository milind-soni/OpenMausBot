import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BotOverview } from "@/lib/bot-overview-types";
import type { PromptPreviewData } from "./PromptPreview";
import { OverviewSection } from "./OverviewSection";

// renderToStaticMarkup HTML-escapes apostrophes as &#x27;; decode before comparing.
function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'");
}

const sentences: BotOverview = {
  who: {
    name: "Scout",
    title: "Research specialist",
    blurb: "Digs into a claim and reports back with sources.",
    soulLead: "Always cite primary sources and separate fact from inference.",
  },
  does: ["Daily at 9:00 AM: Morning brief. Next run 9:00 AM."],
  reaches: ["Works in its own private folder.", "Has the built-in browser."],
  wont: [
    "Won't run commands without asking you first.",
    "Won't contact other bots without asking.",
    "Has no connected apps.",
    "Can't use a computer.",
    "Won't act on a schedule.",
    "Won't change its own instructions without your approval.",
  ],
  recent: [{ at: 1700000000000, summary: "Title changed" }],
};

const prompt: PromptPreviewData = {
  sections: [{ id: "persona", label: "Identity", text: "You are Scout.", bytes: 42 }],
  totalBytes: 42,
  approxTokens: 11,
  note: "Approximate.",
};

describe("OverviewSection", () => {
  it("offers optional setup ideas without declaring a usable bot unfinished", () => {
    const markup = render(createElement(OverviewSection, {
      overview: { ...sentences, setup: [
        { id: "identity", label: "Identity", done: true, section: "identity" },
        { id: "folder", label: "Choose a working folder", done: false, section: "access" },
        { id: "schedule", label: "Add a routine", done: false, section: "routines" },
      ] }, prompt: null, onOpen: vi.fn(),
    }));
    expect(markup).toContain("Setup ideas");
    expect(markup).toContain("You can start chatting now.");
    expect(markup).toContain("Choose a working folder");
    expect(markup).not.toContain("Finish setting up");
    expect(markup).not.toContain("1 of 3 done");
    expect(markup).not.toContain(">Identity</span>");
  });

  it("shows Loading… before the overview arrives", () => {
    const markup = render(
      createElement(OverviewSection, { overview: null, prompt: null, onOpen: vi.fn() }),
    );
    expect(markup).toContain("Loading…");
  });

  it("renders the six wont lines, a does line, and a Read all link into Soul", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, prompt, onOpen: vi.fn() }),
    );

    for (const line of sentences.wont) {
      expect(markup).toContain(line);
    }
    expect(markup).toContain(sentences.does[0]);
    expect(markup).toContain("Read all");
  });

  it("shows the empty-does fallback when the bot does nothing yet", () => {
    const empty: BotOverview = { ...sentences, does: [] };
    const markup = render(
      createElement(OverviewSection, { overview: empty, prompt, onOpen: vi.fn() }),
    );

    expect(markup).toContain("Nothing scheduled or learned yet.");
  });

  it("passes promptError through to PromptPreview instead of just nulling the data", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, prompt: null, promptError: true, onOpen: vi.fn() }),
    );

    expect(markup).toContain("Prompt preview");
  });

  it("keeps showing the loaded overview and adds a quiet banner when a background refresh fails", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, refreshError: true, prompt, onOpen: vi.fn() }),
    );

    expect(markup).toContain("Couldn’t refresh — showing the last loaded overview.");
    for (const line of sentences.wont) {
      expect(markup).toContain(line);
    }
  });

  it("omits the refresh banner when there was no refresh error", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, refreshError: false, prompt, onOpen: vi.fn() }),
    );

    expect(markup).not.toContain("Couldn’t refresh");
  });
});

describe("the overview's reach and limits in the person's language", () => {
  it("words the bots it can talk to, contact and Ask mode, each count by its own plural", async () => {
    const { setLocale } = await import("@/lib/i18n");
    const overview = { ...sentences, reaches: ["Can talk to 1 other bot in its section.", "Can talk to 3 other bots in its allowed teams."],
      wont: ["Cannot initiate contact with other bots.", "Command approvals use Ask mode; saved permissions and provider rules still apply."] };
    const html = () => render(createElement(OverviewSection, { overview, prompt: null, onOpen: vi.fn() }));
    expect(html()).toContain("Can talk to 1 other bot in its section.");
    setLocale("pt-br");
    try {
      const shown = html();
      expect(shown).toContain("Pode falar com 1 outro bot da seção.");
      expect(shown).toContain("Pode falar com 3 outros bots nas equipes permitidas.");
      expect(shown).toContain("Não inicia contato com outros bots.");
      expect(shown).toContain("As aprovações de comandos usam o modo “Pedir”.");
    } finally {
      setLocale("en");
    }
  });
});
