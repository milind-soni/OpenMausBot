import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageCircleMore, Quote, X } from "lucide-react";
import {
  CITATION_MAX_QUOTE_LENGTH,
  citationAttachment,
  type CitationAttachment,
} from "@/lib/citations";
import { addToPromptChord, captureCitationSelection, citationTabShortcut, isAddToPromptShortcut } from "@/lib/citations-dom";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { t } from "@/lib/i18n";
import { textDirection } from "./ChatMarkdown";

type Point = { left: number; top: number };
/** Where the selection is: the pill sits above its first line, or below
 * its last when there is no room above. */
type Anchor = { left: number; top: number; bottom: number };

function place(element: HTMLElement, point: Point): void {
  const rect = element.getBoundingClientRect();
  element.style.left = `${Math.max(8, Math.min(point.left, window.innerWidth - rect.width - 8))}px`;
  element.style.top = `${Math.max(8, Math.min(point.top, window.innerHeight - rect.height - 8))}px`;
}

function placeAbove(element: HTMLElement, anchor: Anchor): void {
  const rect = element.getBoundingClientRect();
  const above = anchor.top - rect.height - 8;
  place(element, { left: anchor.left - rect.width / 2, top: above >= 8 ? above : anchor.bottom + 8 });
}

/** Focus the composer with the caret after what is already typed, which is
 * right after the quote chips when nothing is. */
function focusComposer(): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

/** The floating "Add to prompt" pill over selected message text. Clicking
 * it, or the shortcut, puts the quote straight into the composer. */
export function CitationSelectionToolbar({
  viewportRef,
  onAdd,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  onAdd: (citation: CitationAttachment) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tabShortcut = useRef(citationTabShortcut()).current;
  const isMac = useRef(isMacPlatform()).current;
  const [captured, setCaptured] = useState<{
    citation: CitationAttachment;
    anchor: Anchor;
  } | null>(null);
  const capturedRef = useRef(captured);
  capturedRef.current = captured;

  const add = () => {
    const current = capturedRef.current;
    if (!current || current.citation.quote.length > CITATION_MAX_QUOTE_LENGTH) return;
    onAdd(current.citation);
    window.getSelection()?.removeAllRanges();
    setCaptured(null);
    focusComposer();
  };
  const addRef = useRef(add);
  addRef.current = add;

  useEffect(() => {
    if (!captured) tabShortcut.reset();
    const update = () => {
      const viewport = viewportRef.current;
      const selection = viewport ? captureCitationSelection(viewport, window.getSelection()) : null;
      if (!selection) { setCaptured(null); return; }
      const { citationSource: messageId, citationOwnerType: ownerType, citationOwner: ownerId, citationThread: threadId } = selection.source.dataset;
      if (!messageId || !ownerId || !threadId || (ownerType !== "bot" && ownerType !== "group")) { setCaptured(null); return; }
      const rects = selection.range.getClientRects();
      const box = selection.range.getBoundingClientRect();
      const first = rects.item(0) ?? box;
      setCaptured({
        citation: selection.selector.text.length <= CITATION_MAX_QUOTE_LENGTH
          ? citationAttachment({ ownerType, ownerId, threadId, messageId }, selection.selector)
          : {
              kind: "citation",
              version: 1,
              id: "selection-too-long",
              quote: selection.selector.text,
              source: { ownerType, ownerId, threadId, messageId, ...selection.selector },
              size: selection.selector.text.length,
            },
        anchor: { left: box.left + box.width / 2, top: first.top, bottom: (rects.item(rects.length - 1) ?? box).bottom },
      });
    };
    document.addEventListener("selectionchange", update);
    viewportRef.current?.addEventListener("pointerup", update);
    viewportRef.current?.addEventListener("keyup", update);
    const onKey = (event: KeyboardEvent) => {
      if (!captured) return;
      // a selection over the limit cannot be added, so the key keeps its
      // usual meaning instead of doing nothing
      if (isAddToPromptShortcut(event, isMac) && captured.citation.quote.length <= CITATION_MAX_QUOTE_LENGTH) {
        event.preventDefault();
        event.stopPropagation();
        addRef.current();
        return;
      }
      tabShortcut.handle(event, buttonRef.current);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      viewportRef.current?.removeEventListener("pointerup", update);
      viewportRef.current?.removeEventListener("keyup", update);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [captured, isMac, tabShortcut, viewportRef]);

  useLayoutEffect(() => {
    if (!captured) return;
    const update = () => { if (buttonRef.current) placeAbove(buttonRef.current, captured.anchor); };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [captured]);
  if (!captured) return null;
  const tooLong = captured.citation.quote.length > CITATION_MAX_QUOTE_LENGTH;
  const chord = addToPromptChord(isMac);
  // dark in every skin, like a tooltip: it floats over the transcript
  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      data-add-to-prompt
      disabled={tooLong}
      aria-label={tooLong ? t("citation.tooLong") : t("citation.addToPrompt")}
      aria-keyshortcuts={tooLong ? undefined : chord.aria}
      onPointerDown={(event) => event.preventDefault()}
      onClick={add}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setCaptured(null); }
      }}
      className="fixed z-50 flex items-center gap-2 rounded-xl border border-white/10 bg-[#1c1c1e] py-1.5 pe-1.5 ps-3 text-[13px] font-medium text-[#f2f2f2] shadow-xl shadow-black/30 transition-colors hover:bg-[#2a2a2c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 disabled:text-[#ff9b9b]"
      style={{ left: captured.anchor.left, top: captured.anchor.top }}
    >
      <span>{tooLong ? t("citation.shorten") : t("citation.addToPrompt")}</span>
      {!tooLong && (
        <kbd dir="ltr" className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-sans text-[11px] font-normal text-[#a1a1a6]">{chord.text}</kbd>
      )}
    </button>,
    document.body,
  );
}

/** Direction of the composer's input line while quotes lead it: the
 * comment's once one is typed, the first quote's before that. The chips then
 * sit at the line's start and the caret right after them, in Arabic as in
 * English. */
export function quoteLineDirection(text: string, quotes: readonly CitationAttachment[]): "rtl" | "ltr" {
  if (/\p{Letter}/u.test(text)) return textDirection(text);
  return textDirection(quotes[0]?.quote ?? "");
}

/** The longest stretch of a quote a chip reads before its ellipsis. CSS
 * clamps it to the chip's width too; this keeps the DOM small. */
const CHIP_TEXT = 80;
const CHIP_TITLE = 2_000;

/** A quote waiting in the composer: inline at the start of the input line,
 * a speech-bubble icon and the opening words in quotes. Hover shows the whole
 * quote and an x. Backspace at the start of the input or Escape removes the
 * newest one (Composer). */
export function ComposerQuoteChip({ citation, onRemove }: { citation: CitationAttachment; onRemove: () => void }) {
  const flat = citation.quote.replace(/\s+/g, " ").trim();
  const title = [
    citation.quote.length > CHIP_TITLE ? `${citation.quote.slice(0, CHIP_TITLE)}…` : citation.quote,
    citation.comment ? `\n\n${citation.comment}` : "",
  ].join("");
  return (
    <span
      data-quote-chip
      title={title}
      className="group/quote inline-flex h-7 min-w-0 max-w-[min(12rem,70%)] shrink items-center gap-1.5 rounded-lg px-1.5 text-[14px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-within:bg-raised"
    >
      {/* the x takes the icon's place on hover or focus (always on a touch
          screen), so the chip keeps its width and the caret stays right
          after it */}
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <MessageCircleMore size={15} aria-hidden="true" className="transition-opacity group-focus-within/quote:opacity-0 group-hover/quote:opacity-0 touch:opacity-0" />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("citation.remove", { quote: flat.slice(0, 60) })}
          className="absolute inset-[-2px] flex items-center justify-center rounded-full text-ink opacity-0 transition-opacity hover:bg-control focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 group-hover/quote:opacity-100 touch:opacity-100"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </span>
      <span dir="auto" className="min-w-0 truncate">
        {"\u201C"}{flat.length > CHIP_TEXT ? flat.slice(0, CHIP_TEXT) : flat}
      </span>
    </span>
  );
}

export function CitationBadge({
  citation,
  onRemove,
  onNavigate,
}: {
  citation: CitationAttachment;
  onRemove?: () => void;
  onNavigate?: () => Promise<boolean>;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const rect = triggerRef.current?.getBoundingClientRect();
  const point = { left: rect?.left ?? 8, top: (rect?.bottom ?? 8) + 6 };
  const restoreTriggerFocus = () => requestAnimationFrame(() => triggerRef.current?.focus());
  useEffect(() => {
    if (open) requestAnimationFrame(() => detailsRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const details = detailsRef.current;
      if (!trigger || !details) return;
      const rect = trigger.getBoundingClientRect();
      place(details, { left: rect.left, top: rect.bottom + 6 });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);
  return (
    <span className="relative inline-flex max-w-full items-center gap-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { setUnavailable(false); setOpen((value) => !value); }}
        aria-expanded={open}
        aria-label={`Open citation: ${citation.quote.slice(0, 80)}`}
        className="inline-flex max-w-64 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] text-accent-text hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
      >
        <Quote size={11} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{citation.quote.replace(/\s+/g, " ")}</span>
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Remove citation" className="flex size-5 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"><X size={11} /></button>
      )}
      {open && createPortal(
        <div
          role="dialog"
          aria-label="Citation details"
          className="fixed z-50 w-[min(30rem,calc(100vw-1rem))] rounded-xl border border-hairline/50 bg-panel p-3 text-left text-ink shadow-2xl"
          style={point}
          ref={(element) => {
            detailsRef.current = element;
            if (element) place(element, point);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); setOpen(false); restoreTriggerFocus(); }
          }}
        >
          <div className="max-h-56 overflow-auto rounded-lg bg-inset px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">Quoted message</div>
            <pre dir="auto" className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed">{citation.quote}</pre>
          </div>
          {citation.comment && <div className="mt-2 text-[12px]"><span className="font-semibold">Comment:</span> <span className="whitespace-pre-wrap">{citation.comment}</span></div>}
          {unavailable && <p role="status" className="mt-2 text-[11px] text-warning">Source unavailable or changed. The saved quote is still available.</p>}
          <div className="mt-3 flex justify-end gap-2">
            {onNavigate && <button type="button" onClick={() => { void onNavigate().then((found) => { setUnavailable(!found); if (found) setOpen(false); }); }} className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] hover:bg-raised">Go to source</button>}
            <button type="button" onClick={() => { setOpen(false); restoreTriggerFocus(); }} className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white">Close</button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

export function SentCitations({ citations, onNavigate }: { citations: CitationAttachment[]; onNavigate: (citation: CitationAttachment) => Promise<boolean> }) {
  if (!citations.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5">{citations.map((citation) => <CitationBadge key={citation.id} citation={citation} onNavigate={() => onNavigate(citation)} />)}</div>;
}
