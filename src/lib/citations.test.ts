import { afterEach, describe, expect, it, vi } from "vitest";
import { composeMessage, isAttachment, withDataContext } from "./composer-attachments";
import {
  citationAttachment,
  citationFallback,
  citationPreviewText,
  createCitationTextSelector,
  findCitationText,
  serializeCitation,
  splitTranscriptCitations,
  withCitationComment,
} from "./citations";
import { citationTabShortcut, findCitationSource, highlightCitationSource } from "./citations-dom";

const source = { ownerType: "bot" as const, ownerId: "bot-1", threadId: "thread-1", messageId: "message-1" };

describe("selected-text citations", () => {
  it("round-trips multiline Unicode and code without changing the immutable quote", () => {
    const text = "Before\nconst greeting = \"G'day 🐭\";\n  return greeting;\nAfter";
    const start = text.indexOf("const");
    const selector = createCitationTextSelector(text, start, text.indexOf("\nAfter"))!;
    const original = citationAttachment(source, selector, "Explain the indentation");
    const edited = withCitationComment(original, "  Check Unicode too  ");
    const stored = composeMessage("Please review", [edited]);
    const parsed = splitTranscriptCitations(stored);

    expect(parsed.display).toBe("Please review");
    expect(parsed.citations).toEqual([edited]);
    expect(parsed.citations[0]!.quote).toBe("const greeting = \"G'day 🐭\";\n  return greeting;");
    expect(parsed.citations[0]!.source).toEqual(original.source);
    expect(parsed.citations[0]!.comment).toBe("Check Unicode too");
    expect(stored).toContain(citationFallback(edited));
    expect(stored).toContain(">   return greeting;");
  });

  it("keeps each citation readable and ordered in the exact prompt used by sends, queues, and steers", () => {
    const first = citationAttachment(source, createCitationTextSelector("alpha beta", 0, 5)!, "first note");
    const second = citationAttachment({ ...source, messageId: "message-2" }, createCitationTextSelector("γamma delta", 0, 5)!);
    const prompt = composeMessage("Compare these", [first, second]);
    expect(prompt.indexOf("Compare these")).toBeLessThan(prompt.indexOf("> alpha"));
    expect(prompt.indexOf("> alpha")).toBeLessThan(prompt.indexOf("> γamma"));
    expect(prompt).toContain("Comment:\nfirst note");
    expect(splitTranscriptCitations(prompt).citations).toEqual([first, second]);
    expect(citationPreviewText(prompt)).toBe("Compare these alpha — first note γamma");
  });

  it("leaves malformed or altered serialized data visible instead of trusting it", () => {
    const citation = citationAttachment(source, createCitationTextSelector("quoted text", 0, 11)!);
    const serialized = serializeCitation(citation);
    expect(splitTranscriptCitations(serialized.replace("Quoted message", "Changed message"))).toEqual({
      display: serialized.replace("Quoted message", "Changed message"),
      citations: [],
    });
    expect(splitTranscriptCitations("<!--omb-citation-v1:not-json-->\n> Quoted message:\n> unsafe")).toEqual({
      display: "<!--omb-citation-v1:not-json-->\n> Quoted message:\n> unsafe",
      citations: [],
    });
    expect(isAttachment({ ...citation, quote: "" })).toBe(false);
  });

  it("hides generated Data context from previews without losing citation or thread references", () => {
    const recipient = { botId: "bot-1", threadId: "thread-1" };
    const view = { ...recipient, cardId: "c_1", draftSql: "SELECT private_draft" };
    const citation = citationAttachment(source, createCitationTextSelector("quoted text", 0, 11)!, "Check this");
    const text = "Compare [earlier task](omb://thread/bot-1/thread-2)";
    const plain = withDataContext(text, view, recipient);
    expect(citationPreviewText(plain)).toBe(text);
    expect(citationPreviewText(withDataContext(composeMessage(text, [citation]), view, recipient))).toBe(`${text} quoted text — Check this`);
    const example = `\`\`\`xml\n${plain}\n\`\`\``;
    expect(citationPreviewText(example)).toBe(example);
    expect(citationPreviewText("<data-context>{bad}</data-context>\nDo not hide this")).toBe("<data-context>{bad}</data-context>\nDo not hide this");
  });

  it("does not parse a serialized citation nested inside quoted or comment content", () => {
    const inner = citationAttachment(source, createCitationTextSelector("inner quote", 0, 11)!);
    const outer = citationAttachment(
      { ...source, messageId: "outer" },
      createCitationTextSelector("outer quote", 0, 11)!,
      serializeCitation(inner),
    );
    expect(splitTranscriptCitations(serializeCitation(outer))).toEqual({ display: "", citations: [outer] });
  });

  it("resolves one repeated quote only with unique context and never guesses an ambiguous occurrence", () => {
    const text = "left repeated right; other repeated ending";
    const start = text.lastIndexOf("repeated");
    const selector = createCitationTextSelector(text, start, start + "repeated".length)!;
    expect(findCitationText(text, selector)).toEqual({ start, end: start + 8 });
    expect(findCitationText("repeated and repeated", { text: "repeated", start: 99, end: 107, prefix: "", suffix: "" })).toBeNull();
    expect(findCitationText("source was deleted", selector)).toBeNull();
  });

  it("finds the same visible message after its bot or thread changes", () => {
    const citation = citationAttachment(source, createCitationTextSelector("quoted text", 0, 11)!);
    const unrelated = { dataset: { citationSource: "other", citationOwnerType: "bot" } } as unknown as HTMLElement;
    const moved = { dataset: { citationSource: source.messageId, citationOwnerType: "bot", citationOwner: "bot-2", citationThread: "thread-2" } } as unknown as HTMLElement;
    const document = { querySelectorAll: () => [unrelated, moved] } as unknown as Document;
    expect(findCitationSource(document, citation)).toBe(moved);
    expect(findCitationSource({ querySelectorAll: () => [unrelated] } as unknown as Document, citation)).toBeNull();
  });

  it("moves the first forward Tab from a selection to the cite action and leaves later Tabs alone", () => {
    const tab = (shiftKey = false, key = "Tab") => ({ key, shiftKey, preventDefault: vi.fn() });
    const action = (disabled: boolean) => ({ disabled, focus: vi.fn() }) as unknown as HTMLButtonElement;
    const shortcut = citationTabShortcut();
    const enabled = action(false);

    for (const event of [tab(true), tab(false, "ArrowDown")]) {
      expect(shortcut.handle(event, enabled)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }

    const first = tab();
    expect(shortcut.handle(first, enabled)).toBe(true);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(enabled.focus).toHaveBeenCalledWith({ preventScroll: true });

    const next = tab();
    expect(shortcut.handle(next, enabled)).toBe(false);
    expect(next.preventDefault).not.toHaveBeenCalled();
    expect(enabled.focus).toHaveBeenCalledOnce();

    shortcut.reset();
    expect(shortcut.handle(tab(), enabled)).toBe(true);
  });

  it("leaves Tab alone when an oversized selection disables the cite action", () => {
    const shortcut = citationTabShortcut();
    const disabled = { disabled: true, focus: vi.fn() } as unknown as HTMLButtonElement;
    const event = { key: "Tab", shiftKey: false, preventDefault: vi.fn() };
    expect(shortcut.handle(event, disabled)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(disabled.focus).not.toHaveBeenCalled();
    expect(shortcut.handle(event, null)).toBe(false);
  });
});

describe("citation source highlight cleanup", () => {
  const text = "quoted text in the source";
  const citation = citationAttachment(source, createCitationTextSelector(text, 0, 11)!);

  const stubDom = (css: object) => {
    const node = { nodeType: 3, data: text, length: text.length };
    const root = {
      nodeType: 1,
      tagName: "DIV",
      matches: () => false,
      childNodes: [node],
      dataset: { citationSource: source.messageId, citationOwnerType: "bot" },
      scrollIntoView: vi.fn(),
      ownerDocument: {
        createRange: () => ({
          setStart(container: unknown, offset: number) { Object.assign(this, { startContainer: container, startOffset: offset }); },
          setEnd(container: unknown, offset: number) { Object.assign(this, { endContainer: container, endOffset: offset }); },
        }),
      },
    };
    const ranges: unknown[] = [];
    const selection = {
      get rangeCount() { return ranges.length; },
      getRangeAt: (index: number) => ranges[index],
      addRange: (range: unknown) => ranges.push(range),
      removeAllRanges: vi.fn(() => { ranges.length = 0; }),
    };
    vi.useFakeTimers();
    vi.stubGlobal("Node", { TEXT_NODE: 3, ELEMENT_NODE: 1 });
    vi.stubGlobal("document", { querySelectorAll: () => [root] });
    vi.stubGlobal("CSS", css);
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (id: number) => clearTimeout(id),
      getSelection: () => selection,
    });
    return { node, ranges, selection };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps text the user selects after the highlight instead of clearing it", async () => {
    const { node, ranges, selection } = stubDom({});
    expect(await highlightCitationSource(citation)).toBe(true);
    expect(ranges).toHaveLength(1);
    ranges[0] = { startContainer: node, startOffset: 12, endContainer: node, endOffset: 16 };
    vi.advanceTimersByTime(2_500);
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(ranges).toHaveLength(1);
  });

  it("clears the highlight selection it installed once it expires", async () => {
    const { ranges } = stubDom({});
    await highlightCitationSource(citation);
    vi.advanceTimersByTime(2_500);
    expect(ranges).toHaveLength(0);
  });

  it("does not let an earlier highlight's timer delete a later one", async () => {
    const highlights = { set: vi.fn(), delete: vi.fn() };
    stubDom({ highlights });
    vi.stubGlobal("Highlight", class {});
    await highlightCitationSource(citation);
    vi.advanceTimersByTime(1_000);
    await highlightCitationSource(citation);
    vi.advanceTimersByTime(1_500);
    expect(highlights.delete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(highlights.delete).toHaveBeenCalledOnce();
  });
});
