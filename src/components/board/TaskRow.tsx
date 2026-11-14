import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Check, Loader2, MessageSquare, PauseCircle, Plus, RotateCcw } from "lucide-react";

import { t } from "@/lib/i18n";
import { Select } from "@/components/Select";
import { cn } from "@/lib/cn";
import { PHASE_LABEL, TASK_STATUS_LABEL, TASK_STATUS_CLASS, subtaskProgress, childTasks } from "@/lib/project-board";
import { boardErrorText, decideTask, putTask } from "@/state/board";
import type { BoardSnapshot, BoardTask } from "../../../shared/board";
import type { Bot } from "@/state/store";
import { ProjectAssignment } from "./ProjectAssignment";

export interface TaskRowProps {
  task: BoardTask;
  board: BoardSnapshot;
  bots: readonly Bot[];
  title: string;
  botName: string | undefined;
  projectName: string;
  subprojectName: string;
  manage: boolean;
  depth: number;
  onOpen: (task: BoardTask) => void;
  onNewSubtask?: (task: BoardTask) => void;
  /** While filtering: the tasks the filter kept, so a kept parent does not bring every child with it. */
  visible?: ReadonlySet<string>;
}

const SMALL_PILL = "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium";

/** One conversation on the board: its status and stage at a glance, the full task metadata on demand, and its
 * children indented under it so a parent and its parts are one row of reading. */
export function TaskRow(props: TaskRowProps) {
  const { task, board, bots, title, botName, projectName, subprojectName, manage, depth, onOpen, onNewSubtask } = props;
  const [open, setOpen] = useState(false);
  const children = useMemo(() => childTasks(task, board.tasks).filter((child) => !props.visible || props.visible.has(child.threadId)), [task, board.tasks, props.visible]);
  const progress = subtaskProgress(task, board.tasks);
  return (
    <li data-board-task={task.threadId} data-task-status={task.status} data-task-phase={task.phase}>
      <div className={cn("group flex min-h-12 items-start gap-2 rounded-lg py-1.5 pe-1 hover:bg-raised/40", depth > 0 && "ms-3")}>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls={`task-body-${task.threadId}`}
          aria-label={t("board.task.details")}
          className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus"
        >
          <ChevronRight size={14} aria-hidden className={cn("transition-transform", open && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              className="min-w-0 max-w-full truncate rounded text-start text-[13px] font-medium text-ink hover:underline focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus"
              title={title}
            >
              {title}
            </button>
            <span className={cn(SMALL_PILL, TASK_STATUS_CLASS[task.status] ?? "bg-raised text-ink-secondary")}>{taskStatusText(task.status)}</span>
            <span className={cn(SMALL_PILL, "bg-raised text-ink-secondary")} title={t("board.task.phase")}>{taskPhaseText(task.phase)}</span>
            {task.blocked && <span className={cn(SMALL_PILL, "bg-danger/12 text-danger")}><AlertTriangle size={11} aria-hidden />{t("board.task.blocked")}</span>}
            {task.paused && <span className={cn(SMALL_PILL, "bg-raised text-ink-secondary")}><PauseCircle size={11} aria-hidden />{t("board.task.paused")}</span>}
            {task.verdict?.decision === "accepted" && <span className={cn(SMALL_PILL, "bg-success/15 text-success-ink")}><Check size={11} aria-hidden />{t("board.task.done")}</span>}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
            {botName && <span className="truncate">{botName}</span>}
            {task.owner && <span className="truncate">{t("board.task.owner")} · {task.owner}</span>}
            {children.length > 0 && <span className="tabular-nums">{t("board.task.subtasks", progress)}</span>}
            {!task.acceptance && <span>{t("board.task.noAcceptance")}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpen(task)}
          title={t("board.task.open")}
          aria-label={`${t("board.task.open")}: ${title}`}
          className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus"
        >
          <MessageSquare size={14} aria-hidden />
        </button>
      </div>
      <div id={`task-body-${task.threadId}`} hidden={!open} className="ms-8 mb-2 rounded-xl border border-hairline/35 bg-card/50 p-3">
        {open && <TaskDetail task={task} bots={bots} projectName={projectName} subprojectName={subprojectName} manage={manage} onNewSubtask={onNewSubtask} />}
      </div>
      {children.length > 0 && (
        <ul aria-label={t("board.task.subtasks", progress)} className="border-s border-hairline/35 ps-1">
          {children.map((child) => (
            <TaskRow
              key={child.threadId}
              {...props}
              task={child}
              title={titleOf(child.threadId, bots) ?? child.threadId}
              botName={botNameOf(child.botId, bots)}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function taskStatusText(status: string): string {
  const key = TASK_STATUS_LABEL[status as BoardTask["status"]];
  return key ? t(key) : status;
}

function taskPhaseText(phase: string): string {
  const key = PHASE_LABEL[phase as BoardTask["phase"]];
  return key ? t(key) : phase;
}

function titleOf(threadId: string, bots: readonly Bot[]): string | undefined {
  for (const bot of bots) {
    const found = bot.tasks?.find((task) => task.threadId === threadId);
    if (found?.title) return found.title;
  }
  return undefined;
}

function botNameOf(botId: string, bots: readonly Bot[]): string | undefined {
  return bots.find((bot) => bot.id === botId)?.name;
}

function TaskDetail({ task, bots, projectName, subprojectName, manage, onNewSubtask }: {
  task: BoardTask; bots: readonly Bot[]; projectName: string; subprojectName: string; manage: boolean; onNewSubtask?: (task: BoardTask) => void;
}) {
  const [phase, setPhase] = useState(task.phase);
  const [status, setStatus] = useState(task.status);
  const [owner, setOwner] = useState(task.owner ?? "");
  const [acceptance, setAcceptance] = useState(task.acceptance ?? "");
  const [blocked, setBlocked] = useState(Boolean(task.blocked));
  const [paused, setPaused] = useState(Boolean(task.paused));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [deciding, setDeciding] = useState<"accepted" | "rejected" | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    setPhase(task.phase); setStatus(task.status); setOwner(task.owner ?? ""); setAcceptance(task.acceptance ?? "");
    setBlocked(Boolean(task.blocked)); setPaused(Boolean(task.paused));
  }, [task.threadId]);

  const dirty = phase !== task.phase || status !== task.status || owner.trim() !== (task.owner ?? "") ||
    acceptance.trim() !== (task.acceptance ?? "") || blocked !== Boolean(task.blocked) || paused !== Boolean(task.paused);

  const save = async () => {
    if (!manage || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await putTask(task.threadId, {
        botId: task.botId,
        phase,
        status,
        owner: owner.trim() || null,
        acceptance: acceptance.trim() || null,
        blocked,
        paused,
      });
      if (live.current) setSaved(true);
    } catch (cause) {
      if (live.current) setError(t(boardErrorText(cause)));
    } finally {
      if (live.current) setSaving(false);
    }
  };

  const verdict = async (decision: "accepted" | "rejected") => {
    if (!manage || deciding || !evidence.trim()) return;
    setDeciding(decision);
    setError(null);
    try {
      await decideTask(task.threadId, decision, evidence);
      if (live.current) setEvidence("");
    } catch (cause) {
      if (live.current) setError(t(boardErrorText(cause)));
    } finally {
      if (live.current) setDeciding(null);
    }
  };

  return (
    <div data-board-task-detail={task.threadId}>
      <div className="flex flex-wrap items-center gap-2">
        <ProjectAssignment botId={task.botId} threadId={task.threadId} variant="row" className="max-w-full" />
        <span className="sr-only">{projectName}{subprojectName ? ` · ${subprojectName}` : ""}</span>
        {manage && onNewSubtask && (
          <button type="button" onClick={() => onNewSubtask(task)} className="ui-button ui-button-sm ms-auto">
            <Plus size={13} aria-hidden />{t("board.task.newSubtask")}
          </button>
        )}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-[11px] font-medium text-ink-secondary">
          {t("board.task.phase")}
          <Select value={phase} disabled={!manage || saving} onChange={(event) => setPhase(event.target.value as BoardTask["phase"])} className="mt-1 w-full" aria-label={t("board.task.phase")}>
            {(Object.keys(PHASE_LABEL) as BoardTask["phase"][]).filter((value) => value !== "done" || phase === "done").map((value) => (
              <option key={value} value={value}>{t(PHASE_LABEL[value])}</option>
            ))}
          </Select>
        </label>
        <label className="block text-[11px] font-medium text-ink-secondary">
          {t("board.task.status")}
          <Select value={status} disabled={!manage || saving} onChange={(event) => setStatus(event.target.value as BoardTask["status"])} className="mt-1 w-full" aria-label={t("board.task.status")}>
            {(Object.keys(TASK_STATUS_LABEL) as BoardTask["status"][]).filter((value) => value !== "done" || status === "done").map((value) => (
              <option key={value} value={value}>{t(TASK_STATUS_LABEL[value])}</option>
            ))}
          </Select>
        </label>
        <label className="block text-[11px] font-medium text-ink-secondary">
          {t("board.task.owner")}
          <input list={`board-owners-${task.threadId}`} value={owner} disabled={!manage || saving} maxLength={80} onChange={(event) => setOwner(event.target.value)} placeholder={t("board.task.ownerPlaceholder")} className={SELECT} />
          <datalist id={`board-owners-${task.threadId}`}>{bots.map((bot) => <option key={bot.id} value={bot.name} />)}</datalist>
        </label>
        <div className="flex items-end gap-2">
          <button type="button" aria-pressed={blocked} disabled={!manage || saving} onClick={() => setBlocked((current) => !current)} className={cn("ui-button", blocked && "bg-danger/12 text-danger")}>
            <AlertTriangle size={13} aria-hidden />{t("board.task.blocked")}
          </button>
          <button type="button" aria-pressed={paused} disabled={!manage || saving} onClick={() => setPaused((current) => !current)} className={cn("ui-button", paused && "bg-raised")}>
            <PauseCircle size={13} aria-hidden />{t("board.task.paused")}
          </button>
        </div>
      </div>
      <label className="mt-3 block text-[11px] font-medium text-ink-secondary">
        {t("board.task.acceptance")}
        <textarea value={acceptance} disabled={!manage || saving} maxLength={4000} rows={2} onChange={(event) => setAcceptance(event.target.value)} placeholder={t("board.task.acceptancePlaceholder")} className={cn(SELECT, "resize-y")} />
      </label>
      {manage && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void save()} disabled={!dirty || saving} className="ui-button ui-button-primary">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} aria-hidden />}
            {saving ? t("board.saving") : t("board.task.save")}
          </button>
          {saved && <span role="status" className="text-[11px] text-success-ink">{t("board.task.saved")}</span>}
          {!task.acceptance && <span className="text-[11px] text-ink-tertiary">{t("board.task.noAcceptance")}</span>}
        </div>
      )}
      <div className="mt-3 rounded-lg border border-hairline/35 p-2.5">
        <p className="text-[11px] font-medium text-ink-secondary">{t("board.task.acceptanceTitle")}</p>
        {task.verdict ? (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            {task.verdict.decision === "accepted" ? t("board.task.verdict", { evidence: task.verdict.evidence }) : `${t("board.task.reject")} · ${task.verdict.evidence}`}
          </p>
        ) : manage ? (
          <>
            <p className="mt-1 text-[11px] text-ink-tertiary">{t("board.task.doneViaVerdict")}</p>
            <textarea value={evidence} maxLength={4000} rows={2} onChange={(event) => setEvidence(event.target.value)} placeholder={t("board.task.evidencePlaceholder")} className={cn(SELECT, "mt-1.5 resize-y")} aria-label={t("board.task.evidence")} />
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => void verdict("accepted")} disabled={!evidence.trim() || Boolean(deciding)} className="ui-button ui-button-primary">
                {deciding === "accepted" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} aria-hidden />}{t("board.task.accept")}
              </button>
              <button type="button" onClick={() => void verdict("rejected")} disabled={!evidence.trim() || Boolean(deciding)} className="ui-button">
                {deciding === "rejected" ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} aria-hidden />}{t("board.task.reject")}
              </button>
            </div>
          </>
        ) : <p className="mt-1 text-[11px] text-ink-tertiary">{t("board.readOnly")}</p>}
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

const SELECT = "mt-1 w-full rounded-lg border border-hairline/45 bg-inset px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-focus focus:outline-none disabled:opacity-50";
