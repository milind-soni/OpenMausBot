// The proactive bot's one suggestion to add a helper-model key (server/host/helper-suggestion.ts), in the person's own
// language. A suggestion, not an approval: Add key opens Settings on this device, Not now is kept and ends it.
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type Message } from "@/state/store";
import { ASK_PRIMARY_BUTTON, ASK_QUIET_BUTTON } from "./AskCard";

export function HelperKeySuggestion({ threadId, message }: { threadId?: string; message: Message }) {
  const { dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declined = message.setupSuggestion?.answer === "notNow";

  const notNow = async () => {
    if (saving || !threadId) return;
    setSaving(true);
    setError(null);
    try {
      await api("/api/helpers/suggestion/not-now", { method: "POST", body: JSON.stringify({ threadId, messageId: message.id }) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-setup-suggestion="helperKey" className="max-w-[600px] text-[15px] leading-relaxed text-ink">
      <p dir="auto">{t("chat.helperSuggestion.text")}</p>
      {declined ? (
        <p dir="auto" className="mt-1 text-[13px] text-ink-secondary">{t("chat.helperSuggestion.declined")}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="helper-suggestion-add"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "decisionModel" })}
            className={ASK_PRIMARY_BUTTON}
          >
            {t("chat.helperSuggestion.addKey")}
          </button>
          <button type="button" data-testid="helper-suggestion-not-now" onClick={() => void notNow()} disabled={saving} className={cn(ASK_QUIET_BUTTON, "my-0")}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : t("chat.helperSuggestion.notNow")}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
