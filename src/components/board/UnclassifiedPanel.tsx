import { useMemo, useState } from "react";
import { CheckSquare, Loader2, Square } from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { Select } from "@/components/Select";
import { canEditProject, type ConversationRef } from "@/lib/project-board";
import {
  applyBatch, boardErrorText, BoardBatchError, loadBoard, previewBatch,
  type BatchPreview, type BatchStatus, type BatchThread,
} from "@/state/board";
import type { BoardSnapshot } from "../../../shared/board";
import { ProjectAssignment } from "./ProjectAssignment";

const MAX_BATCH = 100;

const STATUS_LABEL: Readonly<Record<BatchStatus, LocaleKey>> = {
  ready: "board.batch.status.ready",
  already_assigned: "board.batch.status.already",
  missing: "board.batch.status.missing",
  hidden: "board.batch.status.hidden",
  routine: "board.batch.status.routine",
  conflict: "board.batch.status.conflict",
};

const STATUS_CLASS: Readonly<Record<BatchStatus, string>> = {
  ready: "bg-success/15 text-success-ink",
  already_assigned: "bg-raised text-ink-secondary",
  missing: "bg-danger/12 text-danger",
  hidden: "bg-danger/12 text-danger",
  routine: "bg-warning/15 text-warning-ink",
  conflict: "bg-danger/12 text-danger",
};

/** History that has no board row yet: one at a time through the chip, or an explicit previewed batch. A batch never
 * guesses a project from a title, and the server writes all of it or none of it. */
export function UnclassifiedPanel({ conversations, board, onOpen }: {
  conversations: readonly ConversationRef[];
  board: BoardSnapshot;
  onOpen: (conversation: ConversationRef) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projectId, setProjectId] = useState("");
  const [subprojectId, setSubprojectId] = useState("");
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [noWrite, setNoWrite] = useState(false);

  const projects = useMemo(() => board.projects.filter((project) => canEditProject(board, project.id)), [board]);
  const subprojects = useMemo(() => board.subprojects.filter((subproject) => subproject.projectId === projectId), [board, projectId]);
  const chosen = conversations.filter((conversation) => selected.has(conversation.threadId));
  const shown = showAll ? conversations : conversations.slice(0, 6);
  const byThread = useMemo(() => new Map((preview?.items ?? []).map((item) => [item.threadId, item])), [preview]);
  const blocked = preview ? preview.summary.total - preview.summary.ready - preview.summary.alreadyAssigned : 0;
  const canConfirm = Boolean(preview && preview.summary.ready + preview.summary.alreadyAssigned === preview.summary.total && preview.summary.total > 0);

  const resetPreview = () => { setPreview(null); setError(null); setResult(null); setNoWrite(false); };
  const toggle = (threadId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else if (next.size < MAX_BATCH) next.add(threadId);
      return next;
    });
    resetPreview();
  };
  const toggleAll = () => {
    setSelected((current) => current.size >= Math.min(conversations.length, MAX_BATCH) ? new Set() : new Set(conversations.slice(0, MAX_BATCH).map((conversation) => conversation.threadId)));
    resetPreview();
  };
  const leaveBatch = () => { setBatch(false); setSelected(new Set()); setPreview(null); setError(null); setResult(null); };

  const runPreview = async (): Promise<BatchPreview | null> => {
    if (!projectId || !selected.size) return null;
    setBusy("preview");
    setError(null);
    setResult(null);
    setNoWrite(false);
    try {
      const next = await previewBatch({ projectId, ...(subprojectId ? { subprojectId } : {}), threads: chosen.map(threadOf) });
      setPreview(next);
      return next;
    } catch (cause) {
      setError(t(boardErrorText(cause)));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!preview || !canConfirm) return;
    setBusy("apply");
    setError(null);
    setResult(null);
    setNoWrite(false);
    try {
      const answer = await applyBatch({
        projectId, ...(subprojectId ? { subprojectId } : {}), version: preview.version, threads: chosen.map(threadOf),
      });
      setResult(t("board.batch.result", { assigned: answer.assigned, already: answer.alreadyAssigned }));
      setSelected(new Set());
      setPreview(null);
    } catch (cause) {
      const batchError = cause instanceof BoardBatchError ? cause : null;
      if (batchError?.items) {
        setPreview((current) => current ? { ...current, items: batchError.items!, summary: batchError.summary ?? current.summary } : current);
      }
      setError(t(boardErrorText(cause)));
      setNoWrite(true);
      await loadBoard({ force: true });
      if (batchError?.code === "BOARD_VERSION_CONFLICT") {
        setResult(t("board.batch.refreshed"));
        setPreview(null);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="board-unclassified" className="mt-5 rounded-xl border border-hairline/40 bg-card/30 p-3" data-board-unclassified={conversations.length}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="board-unclassified" className="text-[13px] font-semibold text-ink">{t("board.unclassified.title")}</h2>
        <span className="text-[11px] text-ink-tertiary tabular-nums">{conversations.length}</span>
        {conversations.length > 6 && !batch && (
          <button type="button" className="ms-auto text-[12px] font-medium text-accent-text hover:underline" onClick={() => setShowAll((current) => !current)}>
            {showAll ? t("board.unclassified.showLess") : t("board.unclassified.showAll")}
          </button>
        )}
        {conversations.length > 0 && projects.length > 0 && (
          <button type="button" onClick={() => batch ? leaveBatch() : setBatch(true)} className={cn("ui-button ui-button-sm", !batch && "ms-auto")}>
            {batch ? t("board.batch.exit") : t("board.batch.start")}
          </button>
        )}
      </div>
      {conversations.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-ink-tertiary">{t("board.unclassified.empty")}</p>
      ) : batch ? (
        <div data-board-batch>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-tertiary">{t("board.batch.note")}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block text-[11px] font-medium text-ink-secondary">
              {t("board.batch.targetProject")}
              <Select value={projectId} onChange={(event) => { setProjectId(event.target.value); setSubprojectId(""); resetPreview(); }} className="mt-1 w-full" aria-label={t("board.batch.targetProject")}>
                <option value="">{t("board.batch.pickProject")}</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </Select>
            </label>
            <label className="block text-[11px] font-medium text-ink-secondary">
              {t("board.batch.targetSubproject")}
              <Select value={subprojectId} onChange={(event) => { setSubprojectId(event.target.value); resetPreview(); }} disabled={!projectId} className="mt-1 w-full" aria-label={t("board.batch.targetSubproject")}>
                <option value="">{t("board.batch.wholeProject")}</option>
                {subprojects.map((subproject) => <option key={subproject.id} value={subproject.id}>{subproject.name}</option>)}
              </Select>
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={toggleAll} className="ui-button ui-button-sm">
              {selected.size >= Math.min(conversations.length, MAX_BATCH) && selected.size > 0 ? <CheckSquare size={13} aria-hidden /> : <Square size={13} aria-hidden />}
              {t("board.batch.selectAll")}
            </button>
            <span className="text-[11px] text-ink-tertiary tabular-nums" data-batch-selected>{t("board.batch.selected", { count: selected.size, max: MAX_BATCH })}</span>
            <span className="text-[11px] text-ink-tertiary" data-batch-limit-hint>{t("board.batch.limitShort")}</span>
            <button type="button" onClick={() => void runPreview()} disabled={!projectId || !selected.size || busy !== null} className="ui-button ui-button-sm ms-auto">
              {busy === "preview" && <Loader2 size={13} className="animate-spin" />}{t("board.batch.preview")}
            </button>
          </div>
          {conversations.length > MAX_BATCH && <p className="mt-1 text-[11px] text-warning-ink" data-batch-limit>{t("board.batch.limit")}</p>}
          <ul aria-label={t("board.unclassified.title")} className="mt-2 max-h-80 divide-y divide-hairline/25 overflow-y-auto">
            {shown.map((conversation) => {
              const checked = selected.has(conversation.threadId);
              const item = byThread.get(conversation.threadId);
              const disabled = !checked && selected.size >= MAX_BATCH;
              return (
                <li key={conversation.threadId} className="flex min-h-10 flex-wrap items-center gap-2 py-1.5">
                  <button type="button" role="checkbox" aria-checked={checked} aria-label={`${t("board.batch.select")}: ${conversation.title}`} disabled={disabled}
                    onClick={() => toggle(conversation.threadId)}
                    className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus">
                    {checked ? <CheckSquare size={16} aria-hidden /> : <Square size={16} aria-hidden />}
                  </button>
                  <button type="button" onClick={() => onOpen(conversation)} className="min-h-6 min-w-0 flex-1 truncate rounded py-0.5 text-start text-[13px] text-ink hover:underline focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus" title={conversation.title}>
                    {conversation.title}
                  </button>
                  <span className="shrink-0 text-[11px] text-ink-tertiary">{conversation.botName}</span>
                  {item && (
                    <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-medium", STATUS_CLASS[item.status])} title={item.reason}>
                      {t(STATUS_LABEL[item.status])}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {preview && (
            <div className="mt-2 rounded-lg border border-hairline/35 bg-app/40 p-2" data-batch-preview={preview.version}>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <BatchCount value={preview.summary.ready} label={t("board.batch.status.ready")} className="bg-success/15 text-success-ink" />
                <BatchCount value={preview.summary.alreadyAssigned} label={t("board.batch.status.already")} className="bg-raised text-ink-secondary" />
                {preview.summary.missing > 0 && <BatchCount value={preview.summary.missing} label={t("board.batch.status.missing")} className="bg-danger/12 text-danger" />}
                {preview.summary.hidden > 0 && <BatchCount value={preview.summary.hidden} label={t("board.batch.status.hidden")} className="bg-danger/12 text-danger" />}
                {preview.summary.routine > 0 && <BatchCount value={preview.summary.routine} label={t("board.batch.status.routine")} className="bg-warning/15 text-warning-ink" />}
                {preview.summary.conflict > 0 && <BatchCount value={preview.summary.conflict} label={t("board.batch.status.conflict")} className="bg-danger/12 text-danger" />}
                <span className="ms-auto text-ink-tertiary tabular-nums">{t("board.batch.version", { version: preview.version })}</span>
              </div>
              <p className="mt-1 text-[11px] text-ink-tertiary">
                {preview.target.projectName}{preview.target.subprojectName ? ` · ${preview.target.subprojectName}` : ""}
              </p>
              {blocked > 0 && <p className="mt-1 text-[11px] text-danger" data-batch-blocked>{t("board.batch.blocked", { count: blocked })}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void confirm()} disabled={!canConfirm || busy !== null} className="ui-button ui-button-primary ui-button-sm">
                  {busy === "apply" && <Loader2 size={13} className="animate-spin" />}
                  {t("board.batch.confirm", { count: preview.summary.ready + preview.summary.alreadyAssigned })}
                </button>
                <span className="text-[11px] text-ink-tertiary">{t("board.batch.allOrNothing")}</span>
              </div>
            </div>
          )}
          {error && <p role="alert" className="mt-2 text-[12px] text-danger" data-batch-error>{error}</p>}
          {noWrite && <p role="status" className="mt-1 text-[11px] text-warning-ink" data-batch-nowrite>{t("board.batch.noWrite")}</p>}
          {result && <p role="status" className="mt-2 text-[12px] text-success-ink" data-batch-result>{result}</p>}
          {!projects.length && <p className="mt-2 text-[12px] text-ink-tertiary">{t("board.batch.noProjects")}</p>}
        </div>
      ) : (
        <>
          <p className="mt-1 text-[11px] text-ink-tertiary">{t("board.unclassified.note", { count: conversations.length })}</p>
          <ul aria-label={t("board.unclassified.title")} className="mt-1 divide-y divide-hairline/25">
            {shown.map((conversation) => (
              <li key={conversation.threadId} className="flex min-h-10 flex-wrap items-center gap-2 py-1.5">
                <button type="button" onClick={() => onOpen(conversation)}
                  className="min-h-6 min-w-0 flex-1 truncate rounded py-0.5 text-start text-[13px] text-ink hover:underline focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus"
                  title={conversation.title}>
                  {conversation.title}
                </button>
                <span className="shrink-0 text-[11px] text-ink-tertiary">{conversation.botName}</span>
                <ProjectAssignment botId={conversation.botId} threadId={conversation.threadId} variant="row" emptyLabel={t("board.unclassified.classify")} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function threadOf(conversation: ConversationRef): BatchThread {
  return { threadId: conversation.threadId, botId: conversation.botId };
}

function BatchCount({ value, label, className }: { value: number; label: string; className: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-full px-1.5 text-[10.5px] font-medium tabular-nums", className)}>{label} {value}</span>;
}
