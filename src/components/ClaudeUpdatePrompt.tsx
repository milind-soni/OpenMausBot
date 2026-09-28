import { useState } from "react";
import { Check, Copy, Download, Loader2, RefreshCw } from "lucide-react";

import { t } from "@/lib/i18n";
import { api, useStore, type InstanceInfo } from "@/state/store";

const UPDATE_COMMAND = "claude update";

type Phase =
  | { kind: "ask" }
  | { kind: "updating" }
  | { kind: "updated"; version: string }
  | { kind: "manual" }
  | { kind: "failed"; error: string };

/** Offered under a failed turn whose Claude Code is too old for the model.
 * The bot runs Claude Code's own updater through the same route as Engines
 * (which refuses while another Claude turn is running), or the person takes
 * the command and runs it themselves. Retry follows either path, because the
 * update alone does not resend the message that failed. */
export function ClaudeUpdatePrompt({
  instance,
  onRetry,
}: {
  instance: InstanceInfo;
  onRetry?: () => void;
}) {
  const { refreshInstances } = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const [copied, setCopied] = useState(false);

  const update = () => {
    if (phase.kind === "updating") return;
    setPhase({ kind: "updating" });
    api<{ version: string }>(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-update`, {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(async ({ version }) => {
        setPhase({ kind: "updated", version });
        await Promise.resolve(refreshInstances()).catch(() => {});
      })
      .catch((error: unknown) =>
        setPhase({ kind: "failed", error: error instanceof Error ? error.message : String(error) }),
      );
  };

  const retry = onRetry && (
    <button
      type="button"
      onClick={onRetry}
      className="flex items-center gap-1.5 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-raised-hover"
    >
      <RefreshCw size={12} aria-hidden="true" /> {t("chat.retry")}
    </button>
  );

  return (
    <div className="mt-2 rounded-lg border border-hairline/30 bg-card/60 px-3 py-2.5 text-[13px] text-ink" role="group" aria-label={t("chat.claudeUpdate.aria")}>
      {phase.kind === "ask" && (
        <>
          <p className="leading-relaxed">{t("chat.claudeUpdate.offer")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={update}
              className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:brightness-110"
            >
              <Download size={12} aria-hidden="true" /> {t("chat.claudeUpdate.doIt")}
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: "manual" })}
              className="rounded-full border border-hairline/40 px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              {t("chat.claudeUpdate.myself")}
            </button>
          </div>
        </>
      )}
      {phase.kind === "updating" && (
        <p className="flex items-center gap-2 text-ink-secondary" aria-live="polite">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t("chat.claudeUpdate.updating")}
        </p>
      )}
      {phase.kind === "updated" && (
        <>
          <p className="flex items-center gap-1.5 text-success" aria-live="polite">
            <Check size={13} aria-hidden="true" /> {t("engines.claudeUpdated", { version: phase.version })}
          </p>
          {retry && <div className="mt-2">{retry}</div>}
        </>
      )}
      {(phase.kind === "manual" || phase.kind === "failed") && (
        <>
          {phase.kind === "failed" && <p className="mb-1.5 break-words text-danger">{phase.error}</p>}
          <p className="leading-relaxed text-ink-secondary">{t("chat.claudeUpdate.manual")}</p>
          <div className="mt-1.5 flex items-center gap-1 rounded-md bg-inset/60 px-2 py-1 font-mono text-[12px]">
            <span className="flex-1 select-all">{UPDATE_COMMAND}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(UPDATE_COMMAND);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              aria-label={t("chat.claudeUpdate.copy")}
              title={t("chat.claudeUpdate.copy")}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {retry}
            {phase.kind === "failed" && (
              <button
                type="button"
                onClick={update}
                className="rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
              >
                {t("chat.claudeUpdate.tryAgain")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
