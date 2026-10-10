import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";

/** An explicit pin is chosen while creating a thread, never by moving the
 * working directory of a provider session that already exists. */
export function NewTaskFolderDialog({ bot, onClose, onReturnFocus }: { bot: Bot; onClose: () => void; onReturnFocus?: () => void }) {
  const { dispatch } = useStore();
  const [cwd, setCwd] = useState(bot.cwd ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => { if (!pending.current) onClose(); };
  useModalDialog(dialog, close);
  // A menu item may disappear before this dialog closes. Its owner supplies
  // a stable fallback after the modal hook restores the original opener.
  const returnFocus = useRef(onReturnFocus);
  returnFocus.current = onReturnFocus;
  useEffect(() => () => { returnFocus.current?.(); }, []);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (saving) dialog.current?.focus();
    else if (error) input.current?.focus();
  }, [saving, error]);

  return createPortal(<div data-thread-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-label={t("task.folder.new")} aria-busy={saving || undefined}
      className="w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold"><FolderOpen size={16} />{t("task.folder.new")}</h2>
      <p id="new-task-folder-description" className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("task.folder.detail")}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!cwd.trim() || pending.current) return;
        pending.current = true;
        setSaving(true);
        setError(null);
        const currentProject = bot.tasks?.find((task) => task.threadId === bot.threadId)?.projectId;
        const projectId = bot.projects?.find((project) => project.id === currentProject)?.id;
        dispatch({ type: "newTask", botId: bot.id, projectId, cwd: cwd.trim(), onCreated: onClose,
          onError: (message) => { pending.current = false; setSaving(false); setError(message); } });
      }}>
        <label className="mt-4 block text-[12px] text-ink-secondary">{t("task.folder.path")}
          <input ref={input} value={cwd} disabled={saving} aria-describedby="new-task-folder-description" autoComplete="off" spellCheck={false}
            onChange={(event) => { setCwd(event.target.value); setError(null); }} placeholder={t("task.folder.placeholder")}
            className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 font-mono text-[13px] text-ink focus:border-focus focus:outline-none" />
        </label>
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={close} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised disabled:opacity-40">{t("common.cancel")}</button>
          <button type="submit" disabled={saving || !cwd.trim()} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40">{t(saving ? "task.folder.creating" : "task.newShort")}</button>
        </div>
      </form>
    </div>
  </div>, document.body);
}
