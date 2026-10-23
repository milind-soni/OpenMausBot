import { Pin, X } from "lucide-react";
import type { Bot, Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { peerLine } from "@/lib/peer-message";
import { citationPreviewText } from "@/lib/citations";

/** The chat's pinned message above the transcript: who said it, a one-line preview that jumps to it, and Unpin. */
export function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin?: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const pinnedPeer = peerLine(pinned);
  const sender =
    pinned.role === "user" ? (pinnedPeer?.name ?? t("chat.you")) : (pinned.from?.name ?? bot.name);
  const text = citationPreviewText(pinnedPeer?.body ?? pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Pin size={12} className="shrink-0 text-accent" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title={t("chat.pinnedJump")}
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
          <span dir="auto" className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        {onUnpin && <button
          onClick={onUnpin}
          aria-label={t("chat.unpinMessage")}
          title={t("chat.unpin")}
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>}
      </div>
    </div>
  );
}
