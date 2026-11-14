import { RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { useReactor } from "@/lib/cloud-guest";
import { shownPersonName } from "../../shared/bot-owner";
import { PERSON_STOPPED_TURN_NAME } from "../../shared/client-cancel";
import type { ResolvedSender } from "../../shared/wire";

/** What a stopped row says: who stopped it when that was someone else, "You stopped this." to whoever did. */
export function stoppedWords(name: string | undefined, stoppedBy: ResolvedSender | undefined, viewer: string): string {
  if (name !== PERSON_STOPPED_TURN_NAME) return t("chat.turnStopped");
  return stoppedBy?.id && stoppedBy.id !== viewer ? t("chat.turnStoppedBy", { name: shownPersonName(stoppedBy.name) }) : t("chat.turnStoppedByYou");
}

/** A stopped turn, never an error. `name` is the row's tool name: a turn a person stopped says so, and who. */
export function CancelledTurnRow({ onRetry, name, stoppedBy }: { onRetry?: () => void; name?: string; stoppedBy?: ResolvedSender }) {
  const viewer = useReactor();
  return (
    <div role="status" className="flex w-fit max-w-full flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
      <span>{stoppedWords(name, stoppedBy, viewer)}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-full border border-hairline/40 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <RefreshCw size={12} /> {t("chat.retry")}
        </button>
      )}
    </div>
  );
}
