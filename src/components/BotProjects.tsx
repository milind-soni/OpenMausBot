import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ChevronDown, Folder, FolderPlus, MoreHorizontal, Pencil, Plus, X } from "lucide-react";
import { useStore, type Bot, type BotProject } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

const FOLDER_EMOJI = ["📁", "💼", "🏠", "📬", "💡", "🚀", "🎨", "🧪", "📚", "🌱", "⭐", "🛠️"];

export function FolderIcon({ emoji, size = 13 }: { emoji?: string; size?: number }) {
  return emoji ? <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center leading-none" style={{ width: size, fontSize: size }}>{emoji}</span>
    : <Folder aria-hidden="true" size={size} className="shrink-0" />;
}

export function navigateThreadMenu(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

export function FolderActions({ project, canMoveUp, canMoveDown, saving, onEdit, onMove }: {
  project: BotProject;
  canMoveUp: boolean;
  canMoveDown: boolean;
  saving: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1, onSaved: () => void) => void;
}) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => { setMenu(null); actionRef.current?.focus(); };
  useEffect(() => {
    if (saving && menu) menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [saving, menu]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !actionRef.current?.contains(event.target)) setMenu(null);
    };
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [menu]);
  const move = (direction: -1 | 1) => onMove(direction, close);
  return <>
    <button ref={actionRef} type="button" aria-label={t("folder.actions", { name: project.name })} title={t("folder.actions", { name: project.name })} aria-haspopup="menu" aria-expanded={Boolean(menu)}
      onClick={(event) => { if (menu) { close(); return; } const rect = event.currentTarget.getBoundingClientRect(); setMenu({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 228)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 160)) }); }}
      className="flex size-6 shrink-0 items-center justify-center rounded opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/folder:opacity-100 max-md:opacity-70"><MoreHorizontal size={13} /></button>
    {menu && createPortal(<div ref={menuRef} role="menu" aria-label={t("folder.actions", { name: project.name })} aria-busy={saving || undefined} data-thread-overlay style={menu}
      className="fixed z-50 w-[220px] rounded-lg border border-hairline/50 bg-card p-1 shadow-xl"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } else navigateThreadMenu(event); }}>
      <button type="button" role="menuitem" onClick={() => { close(); onEdit(); }} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised"><Pencil size={12} />{t("folder.settings")}</button>
      <button type="button" role="menuitem" disabled={!canMoveUp || saving} onClick={() => move(-1)} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised disabled:opacity-40"><ArrowUp size={12} />{t("folder.moveUp")}</button>
      <button type="button" role="menuitem" disabled={!canMoveDown || saving} onClick={() => move(1)} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised disabled:opacity-40"><ArrowDown size={12} />{t("folder.moveDown")}</button>
    </div>, document.body)}
  </>;
}

/** Folders only organize threads. The project-shaped API is retained for
 * compatibility; neither model settings nor working directories live here. */
export function BotProjectDialog({ bot, project, onClose, onCreated }: {
  bot: Bot;
  project?: BotProject;
  onClose: () => void;
  onCreated?: (project: BotProject) => void;
}) {
  const { dispatch } = useStore();
  const [name, setName] = useState(project?.name ?? "");
  const [emoji, setEmoji] = useState(project?.emoji ?? "");
  const [choosingIcon, setChoosingIcon] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (saving) dialogRef.current?.focus();
    else if (error) nameRef.current?.focus();
  }, [saving, error]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>(`[data-sidebar-bot-row="${CSS.escape(bot.id)}"]`)?.focus();
    };
  }, []);
  return createPortal(
    <div data-thread-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); }
        if (event.key !== "Tab") return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])");
        if (!controls?.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div ref={dialogRef} role="dialog" tabIndex={-1} aria-modal="true" aria-busy={saving || undefined} aria-label={t(project ? "folder.settings" : "folder.create")}
        className="max-h-[85dvh] w-full max-w-[420px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-ink">{t(project ? "folder.settings" : "folder.create")}</h2>
          <button type="button" onClick={onClose} aria-label={t("folder.close")} className="rounded p-1 text-ink-secondary hover:bg-raised"><X size={16} /></button>
        </div>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || saving) return;
          setSaving(true);
          setError(null);
          const onError = (message: string) => { setSaving(false); setError(message); };
          if (project) {
            dispatch({ type: "updateProject", botId: bot.id, projectId: project.id, patch: { name: name.trim(), emoji: emoji.trim() || null }, onSaved: onClose, onError });
          } else {
            dispatch({ type: "createProject", botId: bot.id, name: name.trim(), emoji: emoji.trim() || null, onError,
              onCreated: (created) => { onCreated?.(created); onClose(); } });
          }
        }}>
          <label className="block text-[12px] text-ink-secondary">{t("folder.name")}
            <input ref={nameRef} value={name} maxLength={80} disabled={saving} onChange={(event) => setName(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus:border-accent/60 focus:outline-none" />
          </label>
          <button ref={iconRef} type="button" disabled={saving} aria-label={t("folder.icon")} aria-expanded={choosingIcon} onClick={() => setChoosingIcon((open) => !open)}
            className="mt-3 flex items-center gap-2 rounded-lg border border-hairline/50 px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised"><FolderIcon emoji={emoji} size={18} />{t("folder.icon")}</button>
          {choosingIcon && <div className="mt-2 rounded-lg border border-hairline/40 bg-inset p-3"
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setChoosingIcon(false); iconRef.current?.focus(); } }}>
            <p className="mb-2 text-[12px] text-ink-secondary">{t("folder.emojiHint")}</p>
            <div className="flex flex-wrap gap-1">
              <button type="button" disabled={saving} aria-label={t("folder.defaultIcon")} aria-pressed={!emoji} onClick={() => setEmoji("")} className="flex size-8 items-center justify-center rounded hover:bg-raised aria-pressed:bg-raised"><FolderIcon size={18} /></button>
              {FOLDER_EMOJI.map((icon) => <button key={icon} type="button" disabled={saving} aria-label={icon} aria-pressed={emoji === icon} onClick={() => setEmoji(icon)} className="size-8 rounded text-lg hover:bg-raised aria-pressed:bg-raised">{icon}</button>)}
            </div>
            <label className="mt-2 block text-[12px] text-ink-secondary">{t("folder.emoji")}
              <input value={emoji} disabled={saving} maxLength={64} onChange={(event) => setEmoji(event.target.value)} className="mt-1 w-full rounded border border-hairline/50 bg-panel px-2 py-1.5 text-[14px] text-ink focus:outline-none" />
            </label>
          </div>}
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("folder.detail", { name: bot.name })}</p>
          {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">{t("common.cancel")}</button>
            <button type="submit" disabled={!name.trim() || saving} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40">{t(saving ? "folder.saving" : project ? "folder.save" : "folder.create")}</button>
          </div>
        </form>
        {project && <div className="mt-4 border-t border-hairline/40 pt-3">
          {deleting ? <>
            <p className="text-[12px] leading-relaxed text-ink-secondary">{t("folder.deleteBody")}</p>
            <div className="mt-2 flex items-center gap-3">
              <button type="button" disabled={saving} onClick={() => {
                setSaving(true); setError(null);
                dispatch({ type: "deleteProject", botId: bot.id, projectId: project.id, onDeleted: onClose, onError: (message) => { setSaving(false); setError(message); } });
              }} className="text-[12px] text-danger hover:underline disabled:opacity-40">{t("folder.deleteConfirm")}</button>
              <button type="button" onClick={() => setDeleting(false)} className="text-[12px] text-ink-secondary hover:underline">{t("common.cancel")}</button>
            </div>
          </> : <button type="button" disabled={saving} onClick={() => setDeleting(true)} className="text-[12px] text-danger hover:underline disabled:opacity-40">{t("folder.delete")}</button>}
        </div>}
      </div>
    </div>, document.body,
  );
}

/** One-click new thread in the current folder; the arrow chooses a folder.
 * The popover escapes the sidebar/picker. */
export function NewThreadButton({ bot, className, compact = false, onCreated }: { bot: Bot; className?: string; compact?: boolean; onCreated?: () => void }) {
  const { dispatch } = useStore();
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const projects = bot.projects ?? [];
  const currentProject = projects.find((project) => project.id === bot.tasks?.find((task) => task.threadId === bot.threadId)?.projectId);
  const newThread = (projectId?: string) => {
    dispatch({ type: "newTask", botId: bot.id, ...(projectId ? { projectId } : {}) });
    setMenu(null);
    onCreated?.();
  };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setMenu(null);
    };
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [menu]);
  return <>
    <div ref={rootRef} className={cn("flex items-center rounded-lg text-[12px] text-ink-secondary", className)}>
      <button type="button" onClick={() => newThread(currentProject?.id)} title={currentProject ? t("task.newIn", { name: currentProject.name }) : t("task.newShort")}
        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-l-[inherit] px-2.5 text-left hover:bg-raised/60 hover:text-ink", compact ? "py-1 @max-4xl/chathead:h-[30px] @max-4xl/chathead:px-2" : "py-2")}><Plus size={12} /> <span className={cn("truncate", compact && "@max-4xl/chathead:hidden")}>{t("task.newShort")}</span></button>
      <button type="button" aria-label={t("folder.choose")} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (menu || !rect) { setMenu(null); return; }
        setMenu({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 300)) });
      }} className="self-stretch rounded-r-[inherit] px-2 hover:bg-raised/60 hover:text-ink"><ChevronDown size={12} /></button>
    </div>
    {menu && createPortal(<div ref={menuRef} data-thread-overlay role="menu" aria-label={t("folder.choose")} className="fixed z-50 max-h-[280px] w-[240px] overflow-y-auto rounded-xl border border-hairline/50 bg-card p-1 shadow-2xl" style={menu}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); rootRef.current?.querySelectorAll<HTMLButtonElement>("button")[1]?.focus(); } else navigateThreadMenu(event); }}>
      <p className="px-2.5 py-1.5 text-[11px] text-ink-secondary">{t("folder.newIn")}</p>
      {([{ id: "", name: t("folder.none") }, ...projects] as BotProject[]).map((project) => <button key={project.id} type="button" role="menuitem" onClick={() => newThread(project.id || undefined)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised">{project.id && <FolderIcon emoji={project.emoji} />}<span className="truncate">{project.name}</span></button>)}
      <button type="button" role="menuitem" onClick={() => { setMenu(null); rootRef.current?.querySelectorAll<HTMLButtonElement>("button")[1]?.focus(); setCreatingProject(true); }} className="mt-1 flex w-full items-center gap-2 border-t border-hairline/40 px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised"><FolderPlus size={13} /> {t("folder.new")}…</button>
    </div>, document.body)}
    {creatingProject && <BotProjectDialog bot={bot} onClose={() => setCreatingProject(false)} />}
  </>;
}
