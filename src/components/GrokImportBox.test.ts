import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreContext } from "@/state/store";
import { GrokImportView, type GrokImportViewProps } from "./GrokImportBox";
import { GrokImportFlow } from "./GrokImportFlow";
import { TeamImportDetails } from "./TeamLibraryPanel";
import { grokImportPreview } from "@/lib/team-import";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const view = (overrides: Partial<GrokImportViewProps> = {}) => renderToStaticMarkup(createElement(GrokImportView, {
  url: "", card: null, loading: false, reply: "", error: "", copyState: "idle", cursor: null,
  onUrl: vi.fn(), onLoad: vi.fn(), onCopy: vi.fn(), onReply: vi.fn(), onPreviewReply: vi.fn(), onStarter: vi.fn(),
  onCursorSignIn: vi.fn(), onCursorSignOut: vi.fn(),
  ...overrides,
}));

describe("From Grok Bot", () => {
  it("shows the share card with its creator, the export prompt step, the reply box and the starter", () => {
    const markup = view({
      url: "https://x.ai/bot/d8OshqLZvtcKDcNluPuyo",
      card: { shareId: "d8OshqLZvtcKDcNluPuyo", name: "DOGE", creator: "Avid", description: "Audits your other bots.", url: "https://x.ai/bot/d8OshqLZvtcKDcNluPuyo" },
    });
    const shown = text(markup);
    expect(shown).toContain("From Grok Bot");
    expect(shown).toMatch(/DOGE by Avid Audits your other bots\. Start from description/);
    expect(shown).toContain("Copy export prompt Paste this into your Grok Bot, then paste its reply here.");
    expect(markup).toContain('aria-label="Reply from your Grok Bot"');
    expect(markup).toContain('aria-label="Grok Bot share link"');
  });

  it("offers the starter only once a card is loaded, and says when the prompt was copied", () => {
    expect(text(view())).not.toContain("Start from description");
    expect(text(view({ copyState: "copied" }))).toContain("Copied");
    expect(text(view({ error: "That Grok Bot link was not found." }))).toContain("That Grok Bot link was not found.");
  });

  it("offers the Cursor sign-in on the card, says while it waits, and shows who is signed in", () => {
    const card = { shareId: "d8OshqLZvtcKDcNluPuyo", name: "DOGE", description: "", url: "https://x.ai/bot/d8OshqLZvtcKDcNluPuyo" };
    expect(text(view({ card, cursor: { signedIn: false, waiting: false } }))).toContain("Sign in with Cursor to import everything");
    expect(text(view({ card, cursor: { signedIn: false, waiting: true } }))).toContain("Waiting for you to approve in the browser…");
    const signedIn = text(view({ card: { ...card, exportNote: "Your Cursor sign-in has expired. Sign in again." }, cursor: { signedIn: true, waiting: false } }));
    expect(signedIn).toContain("Signed in to Cursor · Sign out");
    expect(signedIn).toContain("Your Cursor sign-in has expired. Sign in again.");
    // The copy-paste path is always there, signed in or not.
    expect(signedIn).toContain("Copy export prompt");
    // No status yet (a remote client, or the request failed): no Cursor line at all.
    expect(text(view({ card }))).not.toContain("Cursor");
  });

  it("offers the Cursor sign-in before any link is loaded, once, and keeps it on the card after", () => {
    const empty = text(view({ cursor: { signedIn: false, waiting: false } }));
    expect(empty).toContain("Sign in with Cursor to import everything");
    expect(text(view({ cursor: { signedIn: true, waiting: false } }))).toContain("Signed in to Cursor · Sign out");
    const card = { shareId: "d8OshqLZvtcKDcNluPuyo", name: "DOGE", description: "", url: "https://x.ai/bot/d8OshqLZvtcKDcNluPuyo" };
    const withCard = text(view({ card, cursor: { signedIn: false, waiting: false } }));
    expect(withCard.split("Sign in with Cursor to import everything").length - 1).toBe(1);
  });

  it("titles what an export could not carry as Left out in the preview", () => {
    const pending = grokImportPreview({
      format: "openmaus.grok/1", name: "Overheard", instructions: "Watch for mentions.",
      routines: [{ name: "On mention", schedule: "When someone mentions the brand", prompt: "Flag it." }],
    });
    const shown = text(renderToStaticMarkup(createElement(TeamImportDetails, { pending, importedNames: ["Overheard"] })));
    expect(shown).toContain("Left out Routine “On mention”: it starts on an event, not a clock.");
    expect(shown).not.toContain("Backup notes");
  });

  it("shows the Grok Bot mark on the card, the sign-in button and the box heading", () => {
    const card = { shareId: "d8OshqLZvtcKDcNluPuyo", name: "DOGE", description: "", url: "https://x.ai/bot/d8OshqLZvtcKDcNluPuyo" };
    const markup = view({ card, cursor: { signedIn: false, waiting: false } });
    expect(markup.match(/viewBox="0 0 70 70"/g)).toHaveLength(3);
    expect(view({ bare: true }).match(/viewBox="0 0 70 70"/g)).toBeNull();
    expect(text(view({ bare: true }))).not.toContain("From Grok Bot");
  });

  it("starts the shared flow on the link box, framed or bare", () => {
    const value = { state: { bots: [], config: {} }, dispatch: vi.fn() } as never;
    const flow = (bare: boolean) => renderToStaticMarkup(createElement(StoreContext.Provider, { value }, createElement(GrokImportFlow, { bare })));
    expect(flow(false)).toContain('aria-label="Grok Bot share link"');
    expect(text(flow(false))).toContain("From Grok Bot");
    expect(text(flow(true))).not.toContain("From Grok Bot");
    expect(flow(true)).toContain("Copy export prompt");
  });
});

