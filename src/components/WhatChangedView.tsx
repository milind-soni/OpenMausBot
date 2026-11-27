import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";

import { requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";
import { previewHeight } from "./HtmlFilePreview";
import { readTableResponse } from "./TableFilePreview";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { changeCount, type ChangeSegment, type TextComparison } from "../../shared/text-changes";

/** What the view reads of each side: a preview limit, as for a Markdown file. */
export const WHAT_CHANGED_MAX_BYTES = 2 * 1024 * 1024;
const CONTEXT_PARAGRAPHS = 1;
/** Blocks drawn per frame: a heavily edited 100-page document never lands in one long commit. */
const BLOCKS_PER_FRAME = 120;

export interface ComparedFile { path: string; name: string; message: MessageAttachmentContext }

type Failure = "size" | "load" | "encoding" | "failed";
type Paragraph = { para: number; segments: Array<{ segment: ChangeSegment; change: number | null }>; changed: boolean };
/** `first` and `last`: the change numbers inside the block, -1 for none. */
export type Block = ({ kind: "paragraph"; paragraph: Paragraph } | { kind: "unchanged"; paragraphs: Paragraph[] }) & { first: number; last: number };

/** The edited text paragraph by paragraph, each change numbered in reading order, and stretches of unchanged paragraphs
 * folded away beyond one paragraph of context on each side of a change. */
export function changeBlocks(segments: readonly ChangeSegment[]): { blocks: Block[]; changes: number } {
  const paragraphs: Paragraph[] = [];
  let changes = 0;
  for (const segment of segments) {
    let last = paragraphs[paragraphs.length - 1];
    if (!last || last.para !== segment.para) paragraphs.push(last = { para: segment.para, segments: [], changed: false });
    const change = segment.kind === "same" ? null : changes++;
    last.segments.push({ segment, change });
    if (change !== null) last.changed = true;
  }
  const near = paragraphs.map((_, index) => paragraphs.slice(Math.max(0, index - CONTEXT_PARAGRAPHS), index + CONTEXT_PARAGRAPHS + 1).some((paragraph) => paragraph.changed));
  const blocks: Block[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (near[index]) {
      const numbers = paragraph.segments.flatMap(({ change }) => change === null ? [] : [change]);
      return void blocks.push({ kind: "paragraph", paragraph, first: numbers.length ? numbers[0]! : -1, last: numbers.length ? numbers[numbers.length - 1]! : -1 });
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "unchanged") last.paragraphs.push(paragraph);
    else blocks.push({ kind: "unchanged", paragraphs: [paragraph], first: -1, last: -1 });
  });
  return { blocks, changes };
}

/** `kept`: the server served the copy kept when the person sent the file, so it is exactly their original. */
async function readSide(file: ComparedFile, signal: AbortSignal): Promise<{ text: string; kept: boolean }> {
  const response = await requestMessageFile(file.path, file.message, signal);
  const kept = response.headers.get("x-openmausbot-kept-original") === "1";
  return { text: await readTableResponse(response, signal, WHAT_CHANGED_MAX_BYTES, "windows-1252"), kept };
}

const INS = "rounded-[3px] bg-success/15 text-ink no-underline";
const DEL = "rounded-[3px] text-ink-secondary line-through decoration-ink-secondary";
const MOVED = "rounded-[3px] bg-ink/[0.06] underline decoration-ink-tertiary decoration-dotted underline-offset-4";

function Segment({ segment, current }: { segment: ChangeSegment; current: boolean }): ReactNode {
  const mark = current ? "outline-2 outline-offset-2 outline-focus" : undefined;
  switch (segment.kind) {
    case "same": return segment.text;
    case "added": return <ins className={cn(INS, mark)}>{segment.text}</ins>;
    case "removed": return <del className={cn(DEL, mark)}>{segment.text}</del>;
    case "moved": return <span className={cn(MOVED, mark)} title={t("changes.movedFrom", { para: segment.beforePara })}>{segment.text}</span>;
    case "changed": return <span className={cn("rounded-[3px]", mark)} title={segment.minor ? t("changes.minor") : undefined}>
      {segment.parts.map((part, index) => part.op === "same" ? part.text : part.op === "add" ? <ins key={index} className={INS}>{part.text}</ins> : <del key={index} className={DEL}>{part.text}</del>)}
    </span>;
  }
}

/** One block, drawn again only when it opens or the current change enters or leaves it. */
const BlockView = memo(function BlockView({ block, index, open, current, onOpen }: { block: Block; index: number; open: boolean; current: number; onOpen: (index: number) => void }) {
  if (block.kind === "unchanged" && !open) {
    return <button type="button" className="mb-3 inline-flex h-7 items-center rounded-full px-2.5 text-[13px] leading-none text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => onOpen(index)}>
      {t(block.paragraphs.length === 1 ? "changes.unchangedOne" : "changes.unchanged", { count: block.paragraphs.length })}
    </button>;
  }
  return (block.kind === "paragraph" ? [block.paragraph] : block.paragraphs).map((paragraph) => <p key={paragraph.para} dir="auto" className="mb-3 whitespace-pre-wrap break-words">
    {paragraph.segments.map(({ segment, change }, at) => change === null ? <span key={at}>{segment.kind === "same" ? segment.text : null}</span> : <span key={at} data-change={change}><Segment segment={segment} current={change === current} /></span>)}
  </p>);
});

/** An edited file beside the person's original: every change in the edited text, word by word inside a changed
 * sentence, with counts and next and previous. Both files come through the message file route; the comparison runs in
 * a worker, never on the page's thread. */
export default function WhatChangedContent({ original, edited, fill = false }: { original: ComparedFile; edited: ComparedFile; fill?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<TextComparison | { ok: false; reason: "failed" } | null>(null);
  const [kept, setKept] = useState(false);
  const [error, setError] = useState<Failure | { reason: string } | null>(null);
  const [current, setCurrent] = useState(-1);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const [drawn, setDrawn] = useState(BLOCKS_PER_FRAME);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | undefined;
    setResult(null);
    setError(null);
    setCurrent(-1);
    void (async () => {
      let answered = false;
      try {
        const [before, after] = await Promise.all([readSide(original, controller.signal), readSide(edited, controller.signal)]);
        answered = true;
        controller.signal.throwIfAborted();
        worker = new Worker(new URL("../lib/text-changes.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<TextComparison | { ok: false; reason: "failed" }>) => {
          if (!controller.signal.aborted) setResult(event.data);
          worker?.terminate();
        };
        worker.onerror = () => { if (!controller.signal.aborted) setError("failed"); worker?.terminate(); };
        setKept(before.kept);
        worker.postMessage({ original: before.text, edited: after.text });
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof Error && (reason.message === "size" || reason.message === "encoding")) setError(reason.message);
        else if (!answered && reason instanceof Error && !(reason instanceof TypeError)) setError({ reason: reason.message });
        else setError("load");
      }
    })();
    return () => { controller.abort(); worker?.terminate(); };
  }, [original.path, original.message.messageId, edited.path, edited.message.messageId, edited.message.threadId, attempt]);
  const view = useMemo(() => result?.ok ? changeBlocks(result.segments) : null, [result]);
  useEffect(() => {
    if (!view || drawn >= view.blocks.length) return;
    const frame = requestAnimationFrame(() => setDrawn((count) => count + BLOCKS_PER_FRAME));
    return () => cancelAnimationFrame(frame);
  }, [view, drawn]);
  const scrollTo = useRef(-1);
  const openBlock = useCallback((index: number) => setOpened((was) => new Set([...was, index])), []);
  useEffect(() => {
    if (scrollTo.current < 0) return;
    const target = body.current?.querySelector(`[data-change="${scrollTo.current}"]`);
    if (!target) return;
    scrollTo.current = -1;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current, drawn]);

  const retry = <button type="button" className="mt-3 rounded-lg border border-hairline px-3 py-2 hover:bg-raised" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button>;
  if (error || (result && !result.ok)) {
    const why = typeof error === "object" && error ? t("changes.refused", { reason: error.reason })
      : t(error === "size" || (result && !result.ok && result.reason !== "failed") ? "changes.tooLarge" : error === "encoding" ? "changes.notText" : "changes.failed");
    return <div className="p-8 text-center text-sm"><p role="alert" className="text-ink-secondary">{why}</p>{retry}</div>;
  }
  if (!result?.ok || !view) return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("changes.loading")}</div>;

  const { counts } = result;
  const total = changeCount(counts);
  const go = (step: 1 | -1) => {
    const next = current < 0 ? (step > 0 ? 0 : total - 1) : (current + step + total) % total;
    scrollTo.current = next;
    setCurrent(next);
  };
  return <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1 text-[13px] text-ink-secondary">
        <p role="status" className="text-ink">{total ? (["changed", "added", "removed", "moved"] as const).filter((kind) => counts[kind]).map((kind) => t(`changes.${kind}`, { count: counts[kind] })).join(" · ") : t("changes.none")}</p>
        <p dir="auto" className={kept ? "truncate" : undefined}>{t(kept ? "changes.against" : "changes.notKept", { name: original.name })}</p>
      </div>
      {total > 0 && <div className="flex items-center gap-1">
        <span className="text-[12px] text-ink-secondary tabular-nums">{current >= 0 ? t("changes.position", { index: current + 1, count: total }) : null}</span>
        <button type="button" className="table-action" aria-label={t("changes.previous")} title={t("changes.previous")} onClick={() => go(-1)}><ChevronUp size={14} /></button>
        <button type="button" className="table-action" aria-label={t("changes.next")} title={t("changes.next")} onClick={() => go(1)}><ChevronDown size={14} /></button>
      </div>}
    </div>
    {result.coarse && <p className="text-[12px] text-ink-secondary">{t("changes.coarse")}</p>}
    <div ref={body} data-what-changed className={cn(previewHeight(fill), "overflow-auto rounded-lg border border-hairline/40 bg-panel px-5 py-4 text-[14px] leading-6 text-ink")}>
      {view.blocks.slice(0, drawn).map((block, index) => <BlockView key={index} block={block} index={index} open={opened.has(index)} current={block.first <= current && current <= block.last ? current : -1} onOpen={openBlock} />)}
    </div>
  </div>;
}
