import { Eye } from "lucide-react";

import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

/** In place of the composer where this person may not write: a Cloud guest in someone else's conversation, or a team
 * bot they can only view. */
export function NewConversationInstead({ bot, room = false, onNew }: { bot?: Pick<Bot, "name" | "yourAccess">; room?: boolean; onNew: () => void }) {
  if (bot?.yourAccess === "view") {
    return (
      <div className="pointer-events-auto mx-5 mb-4 flex items-center gap-3 rounded-2xl border border-hairline/60 bg-raised px-4 py-3" data-testid="view-only-composer">
        <Eye size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <p className="min-w-0 flex-1 text-[13px] text-ink-secondary">{t(room ? "botAccess.viewOnlyRoom" : "botAccess.viewOnly", { bot: bot.name })}</p>
      </div>
    );
  }
  return (
    <div className="pointer-events-auto mx-5 mb-4 flex items-center justify-between gap-3 rounded-2xl border border-hairline/60 bg-raised px-4 py-3" data-testid="cloud-guest-composer">
      <p className="text-[13px] text-ink-secondary">{t("chat.cloudGuest.notYours")}</p>
      <button type="button" onClick={onNew} className="shrink-0 rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white">
        {t("chat.cloudGuest.newConversation")}
      </button>
    </div>
  );
}
