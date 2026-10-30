import { useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AudioLines, Check, Minus, X } from "lucide-react";

import { formatCallDuration } from "../../shared/live-call";
import { stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { callConversation, type CallConversationEntry, type CallRecordLine } from "@/lib/call-record";
import { t } from "@/lib/i18n";
import { activityStepLabel } from "@/lib/live-activity";
import type { Message } from "@/state/store";
import { approvalCardOutcome, toolLabel } from "./ApprovalCard";
import { ChatMarkdown } from "./ChatMarkdown";
import { WorkingDots } from "./WorkingIndicator";

type LineState = "done" | "stopped" | "open" | "neutral";

function lineState(line: CallRecordLine, busy: boolean): LineState {
  if (line.kind === "step") {
    if (line.tool.ok === undefined) return busy ? "open" : "neutral";
    return line.tool.ok ? "done" : "stopped";
  }
  if (line.card.expired) return "stopped";
  if (!line.card.answered) return "open";
  return line.card.answered === "allow" ? "done" : "stopped";
}

function stepStatus(state: LineState): string | null {
  if (state === "done") return t("toolDetail.completed");
  if (state === "stopped") return t("toolDetail.failed");
  if (state === "open") return t("toolDetail.running");
  return null;
}

function lineText(line: CallRecordLine): string {
  if (line.kind === "step") return activityStepLabel(line.tool);
  const outcome = line.card.expired === true
    ? t("chat.callRecord.expired")
    : approvalCardOutcome(line.card) ?? t("chat.callRecord.waiting");
  const text = t("chat.callRecord.approval", { outcome, action: toolLabel(line.card.tool) });
  return line.card.answeredBy?.via === "call" ? `${text} · ${t("approval.status.byVoice")}` : text;
}

export function CallLineItem({ line, busy }: { line: CallRecordLine; busy: boolean }) {
  const state = lineState(line, busy);
  const status = line.kind === "step" ? stepStatus(state) : null;
  return (
    <li className="flex items-center gap-1.5">
      <span className="shrink-0" aria-hidden="true">
        {state === "open" ? (
          <WorkingDots size={3} />
        ) : state === "done" ? (
          <Check size={12} className="text-success" />
        ) : state === "stopped" ? (
          <X size={12} className="text-danger" />
        ) : (
          <Minus size={12} className="text-ink-tertiary" />
        )}
      </span>
      <span className="min-w-0 truncate">
        {lineText(line)}
        {status && <span className="sr-only">{` (${status})`}</span>}
      </span>
    </li>
  );
}

type Block =
  | Extract<CallConversationEntry, { kind: "said" | "answer" }>
  | { kind: "lines"; id: string; lines: CallRecordLine[] };

function blocksOf(entries: readonly CallConversationEntry[]): Block[] {
  const blocks: Block[] = [];
  for (const entry of entries) {
    if (entry.kind === "said" || entry.kind === "answer") {
      blocks.push(entry);
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "lines") last.lines.push(entry);
    else blocks.push({ kind: "lines", id: entry.id, lines: [entry] });
  }
  return blocks;
}

export function CallSheet({ message, transcript, botName, threadId, busy, partial, onClose }: {
  message: Message;
  transcript: readonly Message[];
  botName: string;
  threadId?: string;
  busy: boolean;
  partial: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, onClose);
  const call = message.call;
  const callId = call?.callId;
  const blocks = useMemo(() => (callId === undefined ? [] : blocksOf(callConversation(transcript, callId))), [transcript, callId]);
  if (!call) return null;
  const title = call.title?.trim() || t("chat.callRecord.title", { name: botName });
  const when = new Date(call.startedAt || call.endedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 sm:p-6"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialog}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="call-sheet-title"
        data-testid="call-sheet"
        className="animate-pop-in flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl"
        style={{ outline: "none" }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-5 pb-3.5 pt-4">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-text">
              <AudioLines size={13} aria-hidden="true" />
              <span>{t("chat.callSheet.kicker")}</span>
            </div>
            <h2 id="call-sheet-title" className="mt-0.5 truncate text-[16px] font-semibold">{title}</h2>
            <p className="mt-0.5 text-[13px] tabular-nums text-ink-secondary">{`${formatCallDuration(call.seconds)} · ${when}`}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={17} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {partial && <p className="mb-3 text-center text-[12px] text-ink-tertiary">{t("chat.callRecord.partial")}</p>}
          {blocks.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-ink-secondary">{t("chat.callSheet.empty")}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {blocks.map((block) => <SheetBlock key={block.id} block={block} busy={busy} threadId={threadId} />)}
            </div>
          )}
        </div>
        <footer className="border-t border-hairline/40 px-5 py-3 text-[12px] text-ink-tertiary">
          {t("chat.callSheet.kept", { name: botName })}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function SheetBlock({ block, busy, threadId }: { block: Block; busy: boolean; threadId?: string }): ReactNode {
  if (block.kind === "lines") {
    return (
      <ul className="flex flex-col gap-0.5 pl-1 text-[13px] text-ink-secondary">
        {block.lines.map((line) => <CallLineItem key={line.id} line={line} busy={busy} />)}
      </ul>
    );
  }
  if (block.kind === "said") {
    return (
      <div className="flex justify-end">
        <div className="w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl bg-bubble-user px-3.5 py-2 text-[14px] leading-relaxed text-ink">
          {block.message.text}
        </div>
      </div>
    );
  }
  const text = stripLeakedSystemHarnessMessages(block.message.text);
  if (!text.trim()) return null;
  return (
    <div className="flex justify-start">
      <div className="w-fit min-w-0 max-w-[85%] rounded-2xl bg-card px-3.5 py-2 text-[14px] leading-relaxed text-ink">
        <ChatMarkdown text={text} message={threadId ? { threadId, messageId: block.message.id } : undefined} />
      </div>
    </div>
  );
}
