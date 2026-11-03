import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FoundExports, GrokLook, GrokMoved, GrokMoveRow } from "@/lib/grok-move";
import { GROK_EXPORT_FORMAT, grokMovePlan, parseGrokExport } from "../../../shared/grok-import";
import { GrokMoveFinish } from "./GrokMoveFinish";
import { GrokMovePreview } from "./GrokMovePreview";
import { GrokMoveStart } from "./GrokMoveStart";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const planOf = (bot: Record<string, unknown>) => grokMovePlan(parseGrokExport(JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [bot] }))[0]!, { timeZone: "UTC" });
const NO_LOOK: GrokLook = { files: [], bots: [], routines: {} };
const start = (over: Partial<Parameters<typeof GrokMoveStart>[0]> = {}) => renderToStaticMarkup(createElement(GrokMoveStart, {
  local: true, found: { bots: [], refused: [] }, look: NO_LOOK, movedNames: [], error: "", onBring: vi.fn(), onFound: vi.fn(), onError: vi.fn(), ...over,
}));
const preview = (bot: Record<string, unknown>, over: Partial<Parameters<typeof GrokMovePreview>[0]> = {}) => renderToStaticMarkup(createElement(GrokMovePreview, {
  pending: { plans: [planOf(bot)], redacted: 0, missing: [] }, takenNames: [], adding: false, error: "", onAdd: vi.fn(), ...over,
}));

/** Words a person moving a Bot should never have to meet in the main text. */
const JARGON = /\b(?:MCP|JSON|export format|package|cron)\b/;

describe("the first screen", () => {
  it("says what happens, offers the message to copy and the ways back, in plain words", () => {
    const shown = text(start());
    expect(shown).toContain("Your Bot writes down its own setup");
    expect(shown).toContain("Copy the message");
    expect(shown).toContain("paste its whole reply");
    expect(shown).toContain("Choose a file");
    expect(shown).not.toMatch(JARGON);
    expect(shown).not.toMatch(/Cursor|x\.ai|share link/);
  });

  it("offers a found Bot in one tap, says why a file was refused, and marks the roster", () => {
    const bot = parseGrokExport(JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [{ name: "Drew", skills: [{ name: "s", instructions: "i" }] }] }))[0]!;
    const found: FoundExports = { bots: [bot], refused: [{ file: "grok-bot-export-bad.json", error: "has keys" }] };
    const markup = start({ found, look: { ...NO_LOOK, bots: ["Drew", "Eve", "Moved"] }, movedNames: ["moved"] });
    const shown = text(markup);
    expect(markup).toContain("data-grok-move-found");
    expect(shown).toContain("Drew Skills: 1 · Routines: 0");
    expect(shown).toContain("grok-bot-export-bad.json: has keys");
    expect(shown).toContain("Your Bots on this computer");
    expect(markup.match(/aria-label="Brought over or ready"/g)).toHaveLength(2);
  });

  it("on a Cloud or remote page it talks about pasting and dropping only", () => {
    expect(text(start({ local: false }))).not.toContain("Downloads");
    expect(text(start())).toContain("Downloads");
  });
});

describe("What's coming over", () => {
  const FULL = {
    name: "Desk", title: "Front desk", instructions: "Answer the door.",
    memories: ["The door sticks"],
    skills: [{ name: "Greet", instructions: "Hi." }],
    routines: [
      { name: "Open up", instruction: "Open.", schedule_cron: "0 9 * * *", schedule_text: "Every day at 9", timezone: "Asia/Tokyo" },
      { name: "Hook", instruction: "Hook.", trigger: "webhook" },
      { name: "On ping", instruction: "Answer.", trigger: "slack" },
    ],
    apps: [{ name: "Linear", mcp_url: "https://mcp.linear.app/mcp", header_names: ["Authorization"] }, { name: "Gmail" }],
  };

  it("lists every category with its count and names, and what stays behind", () => {
    const shown = text(preview(FULL));
    for (const part of ["Bots 1", "Desk · Front desk", "Skills 1", "Greet", "Routines 2", "Open up · Every day at 9 (Asia/Tokyo)", "Memories 1", "The door sticks", "Apps 2", "Linear", "Gmail", "What stays behind", "Chat history, app logins"]) {
      expect(shown, part).toContain(part);
    }
    expect(shown).toContain("On ping starts on an event (slack)");
    expect(shown).toContain("Add Desk");
    expect(shown).not.toMatch(JARGON);
  });

  it("an empty Bot says None rather than hiding the section", () => {
    const shown = text(preview({ name: "Empty", instructions: "Chat." }));
    for (const section of ["Skills None", "Routines None", "Memories None", "Apps None"]) expect(shown, section).toContain(section);
  });

  it("a busy Bot shows a few names and opens the rest on a tap", () => {
    const shown = text(preview({ name: "Busy", skills: Array.from({ length: 12 }, (_, i) => ({ name: `Skill ${i}`, instructions: "x" })) }));
    expect(shown).toContain("Skill 5");
    expect(shown).not.toContain("Skill 6");
    expect(shown).toContain("Show all 12");
  });

  it("says when a name is taken, warns about routines left out, and owns up to what it took out", () => {
    const shown = text(preview(FULL, { takenNames: ["desk"], pending: { plans: [planOf(FULL)], redacted: 2, missing: [{ bot: "Desk", routines: ["routine-healthcheck"] }] } }));
    expect(shown).toContain("Desk 2");
    expect(shown).toContain("You already have a Desk");
    expect(shown).toContain("Desk mentioned routines its message left out: routine-healthcheck");
    expect(shown).toContain("taken out: 2");
  });
});

describe("Finish setting up", () => {
  const moved = [{ bot: { name: "Desk" }, serversSkipped: 0 }] as unknown as GrokMoved[];
  const row = (over: Partial<GrokMoveRow> = {}): GrokMoveRow => ({ key: "b:skills", id: "skills", title: "Review skills: 1", detail: "Off.", target: { kind: "plugins", surface: "apps" }, done: false, ...over });
  const finish = (rows: GrokMoveRow[], list = moved) => renderToStaticMarkup(createElement(GrokMoveFinish, { moved: list, rows, onOpen: vi.fn(), onAnother: vi.fn(), onDone: vi.fn() }));

  it("says done when nothing is needed, and always offers another Bot", () => {
    const shown = text(finish([]));
    expect(shown).toContain("Desk is here");
    expect(shown).toContain("You're all set");
    expect(shown).toContain("Move another Bot");
  });

  it("counts what's left and shows the routines to rebuild with what they said", () => {
    const rebuild = [{ name: "On ping", trigger: "slack", details: "#door", when: "", instruction: "Answer the ping.", reason: "event" as const }];
    const markup = finish([row(), row({ key: "b:routines", id: "routines", done: true }), row({ key: "b:rebuild", id: "rebuild", rebuild })]);
    expect(markup).toContain('data-grok-move-left="2"');
    expect(markup).toContain('data-grok-move-row="skills"');
    expect(markup).toContain('aria-label="Done"');
    expect(text(markup)).toContain("Answer the ping.");
    expect(text(markup)).not.toContain("You're all set");
  });

  it("says when a connection could not be added", () => {
    expect(text(finish([], [{ bot: { name: "Desk" }, serversSkipped: 1 }] as unknown as GrokMoved[]))).toContain("a connection couldn't be added");
  });
});
