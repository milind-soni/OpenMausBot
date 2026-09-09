import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BotOverview } from "@/lib/bot-overview-types";
import type { PromptPreviewData } from "./PromptPreview";
import { OverviewSection } from "./OverviewSection";

// renderToStaticMarkup HTML-escapes apostrophes as &#x27; — decode before
// comparing against plain-text fixtures that use a straight quote.
function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'");
}

// A bot with every off switch flipped: exercises all six "wont" sentences
// buildBotOverview (server/bot-overview.ts) can produce at once.
const sentences: BotOverview = {
  who: {
    name: "Scout",
    title: "Research specialist",
    blurb: "Digs into a claim and reports back with sources.",
    soulLead: "Always cite primary sources and separate fact from inference.",
  },
  does: ["Daily at 9:00 AM: Morning brief. Next run 9:00 AM."],
  reaches: ["Works in its private workspace.", "Has the built-in browser."],
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

    // Closed by default, so the failure text isn't shown yet — but the
    // header must not be stuck offering a preview that will never arrive.
    expect(markup).toContain("Prompt preview");
  });

  it("keeps showing the loaded overview and adds a quiet banner when a background refresh fails", () => {
    const markup = render(
      createElement(OverviewSection, { overview: sentences, refreshError: true, prompt, onOpen: vi.fn() }),
    );

    expect(markup).toContain("Couldn’t refresh — showing the last loaded overview.");
    // The data itself must still be there — a refresh failure is not a load
    // failure, so none of the sections should be replaced by an error state.
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
