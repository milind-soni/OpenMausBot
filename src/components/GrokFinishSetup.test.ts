import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { getDraft, restoreComposerDraft } from "@/lib/drafts";
import { grokImportPreview, type GrokSetupNotes } from "@/lib/team-import";
import { StoreContext, type Bot } from "@/state/store";
import { GrokFinishSetup, grokSetupLeft, grokSetupMessage, openSetupChat, setupHelper } from "./GrokFinishSetup";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `thread-${id}`, name: id, title: "", description: "", notifications: true, color: "blue", unread: false, messages: [], ...extra,
} as Bot);

const notes = (): GrokSetupNotes => grokImportPreview({
  format: "openmaus.grok/1",
  name: "Overheard",
  instructions: "Watch for mentions.",
  routines: [
    { name: "Weekday digest", cron: "0 9 * * 1-5", timeZone: "UTC", prompt: "Send the digest." },
    { name: "On mention", schedule: "When someone mentions the brand on X", prompt: "Flag it." },
  ],
  plugins: ["Gmail", "Slack", "X search"],
  skills: [{ name: "empty", body: "" }],
}, { sourceUrl: "https://x.ai/bot/NIEguoGUjA648fUPle8F5" }).grokSetup!;

describe("Chief of Staff finishes a Grok Bot setup", () => {
  it("is offered only when something is left to do", () => {
    expect(grokSetupLeft(notes())).toBe(true);
    expect(grokSetupLeft({ apps: [], unmatched: [], leftOut: [] })).toBe(false);
    expect(grokSetupLeft(undefined)).toBe(false);
    expect(grokImportPreview({ format: "openmaus.grok/1", name: "Plain", instructions: "Hi." }).grokSetup).toEqual({ apps: [], unmatched: [], leftOut: [] });
  });

  it("asks the Chief of Staff, or the imported bot when there is none", () => {
    const imported = bot("overheard");
    expect(setupHelper([bot("a"), bot("chief", { chiefOfStaff: true }), imported], imported)).toEqual({ bot: expect.objectContaining({ id: "chief" }), chief: true });
    expect(setupHelper([bot("a"), bot("old-chief", { chiefOfStaff: true, hidden: true }), imported], imported)).toEqual({ bot: imported, chief: false });
  });

  it("writes one message with the link, the apps to connect, the tools with no match and the left-out routines verbatim", () => {
    const message = grokSetupMessage("Overheard 2", notes());
    expect(message).toContain("I just added Overheard 2, imported from the Grok Bot at https://x.ai/bot/NIEguoGUjA648fUPle8F5.");
    expect(message).toContain("Apps to connect: Gmail (gmail), Slack (slack).");
    expect(message).toContain("Grok Bot tools with no match here: X search.");
    expect(message).toContain("Routines that did not come over, with what they said:\n- Routine “On mention”: it starts on an event, not a clock.\n  When: When someone mentions the brand on X\n  Flag it.");
    expect(message).toContain("Also left out:\n- Skill “empty”: the export had no text for it.");
    expect(message).not.toContain("Weekday digest");
    expect(message.endsWith("Help me connect the apps and recreate the left-out routines.")).toBe(true);
  });

  it("prepares the message in the helper's composer and opens its chat, without sending anything", () => {
    const chief = bot("chief", { chiefOfStaff: true });
    const draftId = `bot:${chief.id}:${chief.threadId}`;
    restoreComposerDraft(draftId, { text: "half a thought", attachments: [] });
    const dispatch = vi.fn();
    openSetupChat(chief, bot("Overheard"), notes(), dispatch);
    const draft = getDraft(undefined, draftId);
    expect(draft.startsWith("I just added Overheard")).toBe(true);
    expect(draft.endsWith("\n\nhalf a thought")).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "showChat" }], [{ type: "select", id: "chief" }]]);
  });

  it("shows what is left and the button after Add", () => {
    const value = { state: { bots: [bot("chief", { chiefOfStaff: true })] }, dispatch: vi.fn() } as never;
    const render = (bots: Bot[]) => text(renderToStaticMarkup(createElement(StoreContext.Provider, { value: { ...(value as object), state: { bots } } as never },
      createElement(GrokFinishSetup, { notes: notes(), imported: bot("Overheard"), onDone: vi.fn() }))));
    const shown = render([bot("chief", { chiefOfStaff: true })]);
    expect(shown).toContain("Overheard is added");
    expect(shown).toContain("Connect: Gmail, Slack");
    expect(shown).toContain("No match here for: X search");
    expect(shown).toContain("1 routine(s) to set up by hand");
    expect(shown).toContain("Have your Chief of Staff finish the setup");
    expect(shown).toContain("Nothing is sent until you press send.");
    expect(render([])).toContain("Have Overheard finish the setup");
  });
});
