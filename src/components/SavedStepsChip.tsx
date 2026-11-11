import { useRef, useState } from "react";
import { Repeat } from "lucide-react";

import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, type Message } from "@/state/store";

export function SavedStepsChip({ botId, message }: { botId: string; message: Message }) {
  const [status, setStatus] = useState<"idle" | "forgotten" | "failed">("idle");
  const inFlight = useRef(false);
  const canForget = useOwnerOrAdmin() === true;
  const saved = message.savedSteps;
  if (!saved) return null;

  const forget = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    api(`/api/bots/${botId}/saved-steps/${saved.recipeId}`, { method: "DELETE" })
      .then(() => setStatus("forgotten"))
      .catch(() => setStatus("failed"))
      .finally(() => { inFlight.current = false; });
  };

  return (
    <div className="flex flex-col items-start gap-1" data-testid="saved-steps-chip">
      <span className="ui-chip max-w-[min(520px,100%)] border border-hairline/40 bg-panel text-ink-secondary">
        <Repeat size={12} />
        <span className="truncate">{t(saved.replayed ? "chat.savedSteps.replayed" : "chat.savedSteps.learned")}</span>
        {status === "forgotten"
          ? <span className="shrink-0">{t("chat.savedSteps.forgotten")}</span>
          : canForget && <button type="button" onClick={forget} className="shrink-0 text-accent hover:underline" data-saved-steps-forget>{t("chat.savedSteps.forget")}</button>}
      </span>
      {status === "failed" && <span role="alert" className="text-[12px] text-danger">{t("chat.savedSteps.forgetFailed")}</span>}
    </div>
  );
}
