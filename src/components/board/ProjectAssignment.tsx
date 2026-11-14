import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, Check, FolderTree, Loader2 } from "lucide-react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useBoard, loadBoard, putTask, removeTask, boardErrorText, boardErrorKey, BoardWriteError } from "@/state/board";
import { MENU_ROW, MENU_SHEET } from "../menu-recipe";

interface Props {
  botId: string;
  threadId: string;
  /** The trigger's own words when the conversation has no place yet. */
  emptyLabel?: string;
  className?: string;
  /** A row in the board's "waiting to be classified" list rather than the conversation's chip. */
  variant?: "chip" | "row";
  onAssigned?: (assigned: { projectId?: string; subprojectId?: string; removed?: boolean }) => void;
}

const PANEL_WIDTH = 280;
const PANEL_MAX_HEIGHT = 320;

/** The conversation's place on the board: a chip that opens project, then subproject. One control writes the
 * same row the board page edits, so both places show one answer. */
export function ProjectAssignment({ botId, threadId, emptyLabel, className, variant = "chip", onAssigned }: Props) {
  const board = useBoard();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const wasOpen = useRef(false);

  const close = useCallback(() => {
    if (!saving) setOpen(false);
  }, [saving]);
  usePopoverDismiss(open, root, close);
  useEffect(() => { void loadBoard(); }, []);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const first = panel.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
      first?.focus({ preventScroll: true });
    } else if (wasOpen.current) {
      wasOpen.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [open, projectId]);

  const task = board.board?.tasks.find((candidate) => candidate.threadId === threadId);
  const projects = board.board?.projects ?? [];
  const subprojects = board.board?.subprojects ?? [];
  const currentProject = task?.projectId ? projects.find((project) => project.id === task.projectId) : undefined;
  const currentSubproject = task?.subprojectId ? subprojects.find((subproject) => subproject.id === task.subprojectId) : undefined;
  const chosen = projectId ? projects.find((project) => project.id === projectId) : undefined;
  const chosenSubprojects = chosen ? subprojects.filter((subproject) => subproject.projectId === chosen.id) : [];

  const place = () => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    const left = Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8));
    const below = box.bottom + 6;
    const top = below + PANEL_MAX_HEIGHT > window.innerHeight && box.top > PANEL_MAX_HEIGHT
      ? Math.max(8, box.top - 6 - Math.min(PANEL_MAX_HEIGHT, panel.current?.offsetHeight ?? PANEL_MAX_HEIGHT))
      : below;
    setPosition({ left, top });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, projectId, board.revision]);

  const toggle = () => {
    if (saving) return;
    setError(null);
    setProjectId(null);
    setOpen((current) => !current);
    if (!open && board.status !== "ready") void loadBoard();
  };

  const save = async (next: { projectId?: string | null; subprojectId?: string | null }, removed = false) => {
    setSaving(true);
    setError(null);
    try {
      if (removed) await removeTask(threadId);
      else await putTask(threadId, { botId, ...next });
      setOpen(false);
      onAssigned?.({ projectId: next.projectId ?? undefined, subprojectId: next.subprojectId ?? undefined, removed });
    } catch (cause) {
      setError(t(boardErrorText(cause)));
      if (cause instanceof BoardWriteError && cause.code === "BOARD_VERSION_CONFLICT") void loadBoard();
    } finally {
      setSaving(false);
    }
  };

  const label = task
    ? [currentProject?.name, currentSubproject?.name].filter(Boolean).join(" · ")
    : emptyLabel ?? t("board.assign.empty");

  return (
    <div ref={root} data-project-assignment className={cn("relative", className)}>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t("board.assign.title")}: ${label}`}
        title={label}
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-hairline/40 text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus",
          variant === "chip" ? "h-7 bg-raised/40 px-2.5 text-[12px]" : "h-8 bg-transparent px-2 text-[12.5px]",
        )}
      >
        <FolderTree size={13} aria-hidden className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={t("board.assign.title")}
          data-board-assign-panel
          style={{ position: "fixed", left: position?.left ?? -9999, top: position?.top ?? -9999, width: Math.min(PANEL_WIDTH, typeof window === "undefined" ? PANEL_WIDTH : window.innerWidth - 16) }}
          className={cn(MENU_SHEET, "z-[70] max-h-[320px] overflow-y-auto")}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const rows = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
            if (!rows.length) return;
            event.preventDefault();
            const at = rows.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
              : event.key === "ArrowDown" ? (at + 1) % rows.length : (at <= 0 ? rows.length - 1 : at - 1);
            rows[next]?.focus();
          }}
        >
          {board.status === "loading" && !board.board ? (
            <p role="status" className="flex items-center gap-2 px-2 py-3 text-[12px] text-ink-secondary"><Loader2 size={13} className="animate-spin" />{t("board.loading")}</p>
          ) : board.status === "error" && !board.board ? (
            <div className="px-2 py-3">
              <p role="alert" className="text-[12px] text-danger">{t(boardErrorKey(board.code))}</p>
              <button type="button" onClick={() => void loadBoard({ force: true })} className="mt-2 text-[12px] font-medium text-accent-text hover:underline">{t("common.tryAgain")}</button>
            </div>
          ) : chosen ? (
            <>
              <button type="button" onClick={() => setProjectId(null)} className={cn(MENU_ROW, "text-ink-secondary")}>
                <ChevronLeft size={14} aria-hidden className="shrink-0" />{t("board.assign.back")}
              </button>
              <p className="px-2 pb-1 text-[12px] font-medium text-ink-tertiary">{chosen.name}</p>
              <SubprojectRow
                label={t("board.assign.wholeProject")}
                checked={Boolean(task?.projectId === chosen.id && !task?.subprojectId)}
                disabled={saving}
                onSelect={() => void save({ projectId: chosen.id, subprojectId: null })}
              />
              {chosenSubprojects.map((subproject) => (
                <SubprojectRow
                  key={subproject.id}
                  label={subproject.name}
                  checked={task?.subprojectId === subproject.id}
                  disabled={saving}
                  onSelect={() => void save({ projectId: chosen.id, subprojectId: subproject.id })}
                />
              ))}
              {!chosenSubprojects.length && <p className="px-2 py-1.5 text-[12px] text-ink-tertiary">{t("board.assign.noSubprojects")}</p>}
            </>
          ) : projects.length ? (
            <>
              <p className="px-2 pb-1 text-[12px] font-medium text-ink-tertiary">{t("board.assign.pickProject")}</p>
              {projects.map((project) => (
                <button key={project.id} type="button" role="menuitem" onClick={() => setProjectId(project.id)} disabled={saving} className={MENU_ROW}>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {task?.projectId === project.id && <Check size={14} aria-hidden className="shrink-0 text-accent-text" />}
                </button>
              ))}
              {task && (
                <button type="button" role="menuitem" onClick={() => void save({}, true)} disabled={saving} className={cn(MENU_ROW, "text-danger hover:bg-danger/10")}>
                  {t("board.assign.remove")}
                </button>
              )}
            </>
          ) : (
            <p className="px-2 py-2 text-[12px] leading-relaxed text-ink-secondary">{t("board.assign.noProjects")}</p>
          )}
          {error && <p role="alert" className="px-2 py-1.5 text-[12px] text-danger">{error}</p>}
          {saving && <p role="status" className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" />{t("board.saving")}</p>}
        </div>
      )}
    </div>
  );
}

function SubprojectRow({ label, checked, disabled, onSelect }: { label: string; checked: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onSelect} disabled={disabled} className={MENU_ROW}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check size={14} aria-hidden className="shrink-0 text-accent-text" />}
    </button>
  );
}
