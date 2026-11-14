import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";

import { t } from "@/lib/i18n";
import { Select } from "@/components/Select";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { boardErrorText, createConversationOnBoard, createMilestone, createProject, createSubproject, decideMilestone } from "@/state/board";
import type { Bot } from "@/state/store";

/** One small board form. Portalled to the body for the same reason the other dialogs are: a translated sidebar is a
 * containing block for a fixed child. */
export function BoardDialog({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useModalDialog(dialog, () => { if (!busy) onClose(); });
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-label={title} className="ui-modal animate-pop-in w-full max-w-[440px] p-5 text-ink motion-reduce:animate-none">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>}
        <BoardDialogContext value={setBusy}>{children}</BoardDialogContext>
      </div>
    </div>,
    document.body,
  );
}

const BoardDialogContext = createContext<(busy: boolean) => void>(() => {});
function useDialogBusy(): (busy: boolean) => void {
  return useContext(BoardDialogContext);
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mt-4 block text-[12px] text-ink-secondary">
      {label}
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-tertiary">{hint}</span>}
    </label>
  );
}

export const FIELD_CLASS = "mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-focus focus:outline-none disabled:opacity-50";

export function DialogButtons({ busy, disabled, submitLabel, busyLabel, onCancel, extra }: {
  busy: boolean; disabled?: boolean; submitLabel: string; busyLabel: string; onCancel: () => void; extra?: ReactNode;
}) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2">
      {extra}
      <button type="button" disabled={busy} onClick={onCancel} className="ui-button">{t("common.cancel")}</button>
      <button type="submit" disabled={busy || disabled} className="ui-button ui-button-primary">
        {busy && <Loader2 size={14} className="animate-spin" />}
        {busy ? busyLabel : submitLabel}
      </button>
    </div>
  );
}

export function useBoardForm<T>(submit: () => Promise<T>, onDone: () => void) {
  const setBusy = useDialogBusy();
  const [busy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setLocalBusy(true);
    setBusy(true);
    setError(null);
    try {
      await submit();
      onDone();
    } catch (cause) {
      setError(t(boardErrorText(cause)));
    } finally {
      setLocalBusy(false);
      setBusy(false);
    }
  };
  return { busy, error, run, clearError: () => setError(null) };
}

export function FormError({ error }: { error: string | null }) {
  return error ? <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p> : null;
}

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [description, setDescription] = useState("");
  const form = useBoardForm(() => createProject(name, owner, goal, acceptance, description), onClose);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <BoardDialog title={t("board.dialog.newProject")} onClose={onClose}>
      <form onSubmit={form.run}>
        <Field label={t("board.dialog.projectName")}>
          <input ref={input} value={name} maxLength={120} onChange={(event) => { setName(event.target.value); form.clearError(); }} placeholder={t("board.dialog.projectNamePlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.task.owner")}>
          <input value={owner} maxLength={80} onChange={(event) => { setOwner(event.target.value); form.clearError(); }} placeholder={t("board.task.ownerPlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.dialog.projectGoal")}>
          <textarea value={goal} maxLength={4000} rows={2} onChange={(event) => { setGoal(event.target.value); form.clearError(); }} placeholder={t("board.dialog.projectGoalPlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.task.acceptance")}>
          <textarea value={acceptance} maxLength={4000} rows={2} onChange={(event) => { setAcceptance(event.target.value); form.clearError(); }} placeholder={t("board.task.acceptancePlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.dialog.description")}>
          <textarea value={description} maxLength={2000} rows={2} onChange={(event) => setDescription(event.target.value)} placeholder={t("board.dialog.descriptionPlaceholder")} className={FIELD_CLASS} />
        </Field>
        <FormError error={form.error} />
        <DialogButtons busy={form.busy} disabled={!name.trim() || !owner.trim() || !goal.trim() || !acceptance.trim()} submitLabel={t("board.dialog.create")} busyLabel={t("board.dialog.creating")} onCancel={onClose} />
      </form>
    </BoardDialog>
  );
}

export function NewSubprojectDialog({ projectName, projectId, onClose }: { projectName: string; projectId: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const form = useBoardForm(() => createSubproject(projectId, name, owner, deliverable, acceptance), onClose);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <BoardDialog title={t("board.dialog.newSubproject")} description={projectName} onClose={onClose}>
      <form onSubmit={form.run}>
        <Field label={t("board.dialog.subprojectName")}>
          <input ref={input} value={name} maxLength={120} onChange={(event) => { setName(event.target.value); form.clearError(); }} placeholder={t("board.dialog.subprojectNamePlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.task.owner")}>
          <input value={owner} maxLength={80} onChange={(event) => { setOwner(event.target.value); form.clearError(); }} placeholder={t("board.task.ownerPlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.dialog.deliverable")}>
          <textarea value={deliverable} maxLength={4000} rows={2} onChange={(event) => { setDeliverable(event.target.value); form.clearError(); }} placeholder={t("board.dialog.deliverablePlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.task.acceptance")}>
          <textarea value={acceptance} maxLength={4000} rows={2} onChange={(event) => { setAcceptance(event.target.value); form.clearError(); }} placeholder={t("board.task.acceptancePlaceholder")} className={FIELD_CLASS} />
        </Field>
        <FormError error={form.error} />
        <DialogButtons busy={form.busy} disabled={!name.trim() || !owner.trim() || !deliverable.trim() || !acceptance.trim()} submitLabel={t("board.dialog.create")} busyLabel={t("board.dialog.creating")} onCancel={onClose} />
      </form>
    </BoardDialog>
  );
}

export function NewMilestoneDialog({ projectId, subprojectId, subprojectName, onClose }: { projectId: string; subprojectId: string; subprojectName: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const form = useBoardForm(() => createMilestone({ projectId, subprojectId, title, ...(due ? { dueAt: new Date(`${due}T12:00:00`).getTime() } : {}) }), onClose);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <BoardDialog title={t("board.dialog.newMilestone")} description={subprojectName} onClose={onClose}>
      <form onSubmit={form.run}>
        <Field label={t("board.dialog.milestoneTitle")}>
          <input ref={input} value={title} maxLength={200} onChange={(event) => { setTitle(event.target.value); form.clearError(); }} placeholder={t("board.dialog.milestoneTitlePlaceholder")} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.milestone.dueLabel")}>
          <input type="date" value={due} onChange={(event) => setDue(event.target.value)} className={FIELD_CLASS} />
        </Field>
        <FormError error={form.error} />
        <DialogButtons busy={form.busy} disabled={!title.trim()} submitLabel={t("board.dialog.add")} busyLabel={t("board.dialog.adding")} onCancel={onClose} />
      </form>
    </BoardDialog>
  );
}

export function MilestoneDecisionDialog({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const [verdict, setVerdict] = useState("");
  const [evidence, setEvidence] = useState("");
  const [decision, setDecision] = useState<"accepted" | "rejected">("accepted");
  const form = useBoardForm(() => decideMilestone(id, decision, verdict, evidence), onClose);
  const verdictRef = useRef<HTMLInputElement>(null);
  useEffect(() => { verdictRef.current?.focus(); }, []);
  return (
    <BoardDialog title={t("board.milestone.decide")} description={title} onClose={onClose}>
      <form onSubmit={form.run}>
        <Field label={t("board.milestone.verdictLabel")}>
          <input ref={verdictRef} value={verdict} maxLength={2000} onChange={(event) => { setVerdict(event.target.value); form.clearError(); }} className={FIELD_CLASS} />
        </Field>
        <Field label={t("board.milestone.evidenceLabel")}>
          <textarea value={evidence} maxLength={4000} rows={2} onChange={(event) => { setEvidence(event.target.value); form.clearError(); }} placeholder={t("board.task.evidencePlaceholder")} className={FIELD_CLASS} />
        </Field>
        <div className="mt-4 flex gap-2" role="group" aria-label={t("board.milestone.decide")}>
          <button type="button" aria-pressed={decision === "accepted"} onClick={() => setDecision("accepted")} className={decision === "accepted" ? "ui-button ui-button-primary" : "ui-button"}>{t("board.milestone.accept")}</button>
          <button type="button" aria-pressed={decision === "rejected"} onClick={() => setDecision("rejected")} className={decision === "rejected" ? "ui-button ui-button-primary" : "ui-button"}>{t("board.milestone.reject")}</button>
        </div>
        <FormError error={form.error} />
        <DialogButtons busy={form.busy} disabled={!verdict.trim() || !evidence.trim()} submitLabel={t("board.milestone.decide")} busyLabel={t("board.saving")} onCancel={onClose} />
      </form>
    </BoardDialog>
  );
}

export function NewConversationDialog({ bots, projectId, subprojectId, subprojectName, parentThreadId, parentTitle, onCreated, onClose }: {
  bots: readonly Bot[]; projectId: string; subprojectId: string; subprojectName: string;
  parentThreadId?: string; parentTitle?: string;
  onCreated: (bot: Bot, threadId: string) => void;
  onClose: () => void;
}) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const form = useBoardForm(async () => {
    const created = await createConversationOnBoard({ botId, title, projectId, subprojectId, ...(parentThreadId ? { parentThreadId } : {}) });
    onCreated(created.bot as Bot, created.threadId);
  }, onClose);
  return (
    <BoardDialog title={t("board.dialog.newConversation")} description={parentTitle ? `${subprojectName} · ${parentTitle}` : subprojectName} onClose={onClose}>
      {bots.length ? (
        <form onSubmit={form.run}>
          <Field label={t("board.dialog.bot")}>
            <Select value={botId} onChange={(event) => setBotId(event.target.value)} className="mt-1 w-full" aria-label={t("board.dialog.bot")}>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </Select>
          </Field>
          <Field label={t("board.dialog.conversationTitle")}>
            <input value={title} maxLength={200} onChange={(event) => { setTitle(event.target.value); form.clearError(); }} placeholder={t("board.dialog.conversationTitlePlaceholder")} className={FIELD_CLASS} />
          </Field>
          <FormError error={form.error} />
          <DialogButtons busy={form.busy} disabled={!botId} submitLabel={t("board.dialog.create")} busyLabel={t("board.dialog.creating")} onCancel={onClose} />
        </form>
      ) : <p className="mt-4 text-[13px] text-ink-secondary">{t("board.assign.noProjects")}</p>}
    </BoardDialog>
  );
}
