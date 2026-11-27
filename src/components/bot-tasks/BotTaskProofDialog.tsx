import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BotTaskStatus, BotTaskSummary } from "../../../shared/bot-tasks";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { moveBotTask, proofClaim, STATUS_LABEL, type ProofKind } from "@/lib/bot-tasks";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ApiError } from "@/state/api";
import { Select } from "../Select";

const KIND_LABEL: Record<ProofKind, LocaleKey> = {
  commit: "botTasks.proof.kind.commit", ci_run: "botTasks.proof.kind.ciRun", review_url: "botTasks.proof.kind.review", command: "botTasks.proof.kind.command",
};
const VALUE_LABEL: Record<ProofKind, LocaleKey> = {
  commit: "botTasks.proof.sha", ci_run: "botTasks.proof.url", review_url: "botTasks.proof.url", command: "botTasks.proof.command",
};
const KINDS: readonly ProofKind[] = ["commit", "ci_run", "review_url", "command"];

/** A move into done (or review) needs proof under the rule. The server checks it against GitHub and answers; a refusal
 * stays in this dialog with its reason, and the task has not moved. */
export function BotTaskProofDialog({ task, to, onClose, onMoved }: {
  task: BotTaskSummary;
  to: BotTaskStatus;
  onClose: () => void;
  onMoved: (task: BotTaskSummary["id"], to: BotTaskStatus) => void;
}) {
  const [kind, setKind] = useState<ProofKind>("commit");
  const [value, setValue] = useState("");
  const [exitCode, setExitCode] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const close = () => { if (!pending.current) onClose(); };
  useModalDialog(dialog, close);
  const claim = proofClaim(kind, value, exitCode);
  const status = t(STATUS_LABEL[to]);

  const submit = async () => {
    if (!claim || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await moveBotTask(task.id, to, [claim]);
      onMoved(task.id, to);
      pending.current = false;
      onClose();
    } catch (failure) {
      pending.current = false;
      setSaving(false);
      setError(failure instanceof ApiError ? failure.message : t("botTasks.board.moveFailed"));
    }
  };

  return createPortal(
    <div data-thread-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="bot-task-proof-title" aria-describedby="bot-task-proof-body" aria-busy={saving || undefined}
        data-bot-task-proof={task.id} className="w-full max-w-[460px] rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl">
        <h2 id="bot-task-proof-title" className="text-[15px] font-semibold leading-6">{t("botTasks.proof.title", { status })}</h2>
        <p id="bot-task-proof-body" dir="auto" className="mt-2 text-[13px] leading-[18px] text-ink-secondary">{t("botTasks.proof.body", { title: task.title, status })}</p>
        <form className="mt-4 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="flex flex-col gap-1 text-[12px] leading-4 text-ink-secondary">{t("botTasks.proof.kind")}
            <Select size="sm" value={kind} disabled={saving} onChange={(event) => { setKind(event.target.value as ProofKind); setError(""); }}>
              {KINDS.map((item) => <option key={item} value={item}>{t(KIND_LABEL[item])}</option>)}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] leading-4 text-ink-secondary">{t(VALUE_LABEL[kind])}
            <input autoFocus dir="ltr" value={value} disabled={saving} autoComplete="off" spellCheck={false} data-bot-task-proof-value=""
              onChange={(event) => { setValue(event.target.value); setError(""); }}
              className="h-8 w-full rounded-lg border border-hairline/50 bg-inset px-2 font-mono text-[13px] text-ink outline-none focus-visible:border-focus disabled:opacity-50" />
          </label>
          {kind === "command" && (
            <label className="flex flex-col gap-1 text-[12px] leading-4 text-ink-secondary">{t("botTasks.proof.exitCode")}
              <input dir="ltr" inputMode="numeric" value={exitCode} disabled={saving} autoComplete="off"
                onChange={(event) => { setExitCode(event.target.value); setError(""); }}
                className="h-8 w-24 rounded-lg border border-hairline/50 bg-inset px-2 font-mono text-[13px] tabular-nums text-ink outline-none focus-visible:border-focus disabled:opacity-50" />
            </label>
          )}
          <p className="text-[12px] leading-4 text-ink-tertiary">{t(kind === "command" ? "botTasks.proof.hintCommand" : "botTasks.proof.hintGithub")}</p>
          {error && <p role="alert" data-bot-task-proof-error="" dir="auto" className="text-[12px] leading-4 text-danger">{error}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className="ui-button ui-button-md rounded-full" disabled={saving} onClick={close}>{t("common.cancel")}</button>
            <button type="submit" className="ui-button ui-button-md ui-button-primary rounded-full" disabled={saving || !claim}>
              {t(saving ? "botTasks.proof.checking" : "botTasks.proof.move", { status })}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
