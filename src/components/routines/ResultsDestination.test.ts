import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { ResultsDestination, resultsOfPlace, RoutineAudience, type RoutinePlace } from "./ResultsDestination";

const bot = {
  id: "pepper", projects: [{ id: "management", name: "OMB management" }],
  tasks: [
    { threadId: "main", title: "Everyday chat" },
    { threadId: "health", title: "Fleet health", projectId: "management" },
    { threadId: "execution", title: "Internal run", routineRunId: "run-1" },
  ],
} as Bot;

describe("routine result destination", () => {
  it("offers a dedicated thread or visible conversations grouped by folder", () => {
    const html = renderToStaticMarkup(createElement(ResultsDestination, { bot, value: null, onChange: vi.fn() }));
    expect(html).toContain("Post results to");
    expect(html).toContain('value="new" selected=""');
    expect(html).toContain('label="OMB management"');
    expect(html).toContain("Fleet health");
    expect(html).toContain("Everyday chat");
    expect(html).not.toContain("Internal run");
    expect(html).not.toContain("Keep current destination");
  });

  it("preserves a legacy destination on unrelated edits", () => {
    const html = renderToStaticMarkup(createElement(ResultsDestination, { bot, value: undefined, allowCurrent: true, onChange: vi.fn() }));
    expect(html).toContain('value="current" selected=""');
    expect(html).toContain("Keep current destination");
  });

  it("shows an unavailable selection honestly instead of silently choosing another account's thread", () => {
    const html = renderToStaticMarkup(createElement(ResultsDestination, { bot, value: "deleted-or-foreign", onChange: vi.fn() }));
    expect(html).toContain("Thread unavailable");
    expect(html).toContain('value="deleted-or-foreign" disabled="" selected=""');
  });

  it("on a team offers only Just me and the shared chat, and picks the shared chat by its id", () => {
    const team = { ...bot, mainThreadId: "main", tasks: [...bot.tasks!, { threadId: "mine", title: "Bob's plans", private: true }] } as Bot;
    const html = renderToStaticMarkup(createElement(ResultsDestination, { bot: team, value: null, team: true, onChange: vi.fn() }));
    expect(html).toContain('value="shared" selected=""');
    expect(html).toContain(">Just me<");
    expect(html).toContain(">Shared chat<");
    expect(html).not.toContain("Fleet health");
    expect(renderToStaticMarkup(createElement(ResultsDestination, { bot: team, value: "mine", team: true, onChange: vi.fn() }))).toContain('value="me" selected=""');
    expect(renderToStaticMarkup(createElement(ResultsDestination, { bot: team, value: "just-me", team: true, onChange: vi.fn() }))).toContain('value="me" selected=""');
  });

  describe("on a team's Cloud", () => {
    const quotes = { id: "quotes", threadId: "mine", mainThreadId: "main", tasks: [
      { threadId: "main", title: "Shared chat", sharedChat: true }, { threadId: "mine", title: "Salary talk", private: true }, { threadId: "run", title: "A run", routineRunId: "run-1" },
    ] } as Bot;
    const maus = { id: "maus", threadId: "inbox", defaultBot: { person: "rui@acme.test" }, tasks: [{ threadId: "inbox", title: "Inbox", private: true }] } as Bot;
    const place = (fields: Partial<RoutinePlace>, bot: Bot = quotes): RoutinePlace => ({ activeView: "chat", selectedId: bot.id, bots: [bot, maus], config: { team: { name: "Acme" } }, ...fields });
    const line = (bot: Bot, value: string | null | undefined, madeIn?: string) => renderToStaticMarkup(createElement(RoutineAudience, { team: { name: "Acme" }, bot, value, madeIn }));

    it("presets the audience of the place the form was opened from, and the person alone anywhere else", () => {
      expect(resultsOfPlace(place({}), "quotes"), "from a private chat").toBe("just-me");
      expect(resultsOfPlace(place({}, { ...quotes, threadId: "main" }), "quotes"), "from the shared chat").toBe("main");
      expect(resultsOfPlace(place({}, { ...quotes, threadId: "run" }), "quotes"), "a run's own conversation is no place to share from").toBe("just-me");
      expect(resultsOfPlace(place({ activeView: "routines" }, { ...quotes, threadId: "main" }), "quotes"), "the Automations page is no chat").toBe("just-me");
      expect(resultsOfPlace(place({ selectedId: "maus" }, { ...quotes, threadId: "main" }), "quotes"), "another bot's chat on screen").toBe("just-me");
      expect(resultsOfPlace(place({}), undefined), "no bot chosen yet").toBe("just-me");
      expect(resultsOfPlace(place({}), "maus"), "their own MausBot is theirs already").toBeNull();
      expect(resultsOfPlace(place({ config: {} }), "quotes"), "off a team").toBeUndefined();
    });

    it("says who will see the routine in the words of the label by the message box", () => {
      expect(line(quotes, "just-me")).toContain('data-routine-audience="me"');
      expect(line(quotes, "just-me")).toContain("Private · only you");
      expect(line(quotes, "mine")).toContain("Private · only you");
      expect(line(quotes, null, "mine"), "one a bot made in their private chat").toContain("Private · only you");
      expect(line(maus, null)).toContain("Private · only you");
      for (const value of ["main", null, undefined]) {
        expect(line(quotes, value)).toContain('data-routine-audience="shared"');
        expect(line(quotes, value)).toContain("Shared · everyone in Acme can see");
      }
      expect(line({ ...quotes, onlyPeopleAdded: true } as Bot, "main")).toContain("Shared · only people added and admins can see");
      expect(renderToStaticMarkup(createElement(RoutineAudience, { team: null, bot: quotes, value: null })), "nothing off a team").toBe("");
    });
  });
});
