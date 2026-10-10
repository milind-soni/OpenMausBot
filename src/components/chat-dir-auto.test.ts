import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** The attribute sits on the element that shows or edits that text. */
function expectDirAuto(file: string, marker: string) {
  const text = source(file);
  const at = text.indexOf(marker);
  expect(at, `${file} missing ${marker}`).toBeGreaterThan(-1);
  const window = text.slice(Math.max(0, at - 280), at + marker.length);
  expect(window, `${file} near ${marker}`).toContain('dir="auto"');
}

describe("chat text follows the writer's direction", () => {
  it("sets dir=auto on the chat inputs and previews that were still forced ltr", () => {
    expectDirAuto("ChatView.tsx", "value={draft}");
    expectDirAuto("OptionCard.tsx", "value={custom}");
    expectDirAuto("QuestionCard.tsx", "value={draft.custom}");
    // the composer's quote chip (the comment is the composer text itself)
    expectDirAuto("CitationUI.tsx", '{"\\u201C"}{flat');
    expectDirAuto("ChatFindBar.tsx", "value={query}");
    expectDirAuto("RawMarkdownToggle.tsx", 'data-testid="raw-markdown-view"');
    expectDirAuto("GroupView.tsx", "value={bulletinDraft}");
    expectDirAuto("GroupView.tsx", "group.bulletin.split");
    expectDirAuto("TaskPicker.tsx", "{task.title}");
    expectDirAuto("TaskPicker.tsx", "task.threadId === bot.threadId");
    expectDirAuto("SearchResults.tsx", "line-clamp-2");

    const quotes = source("CitationUI.tsx").match(/<pre dir="auto"[^>]*>\{citation\.quote\}/g) ?? [];
    expect(quotes).toHaveLength(1);
    const pins = [source("ChatView.tsx"), source("GroupView.tsx")].map((text) => text.includes('dir="auto" className="truncate text-[12.5px] text-ink-secondary"'));
    expect(pins).toEqual([true, true]);
  });
});
