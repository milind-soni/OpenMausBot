// Another bot's long request reads as one line in the chat. It opens in place, and its back-and-forth with this bot opens beside the chat.
import { createContext, use, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, MessagesSquare, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { formatTime } from "@/lib/clock-time";
import { normalizeState } from "@/lib/mascot";
import { peerExchange, type ExchangeLine, type PeerLine } from "@/lib/peer-message";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot, Message } from "@/state/store";

/** The thread's messages, so an opened request can show its whole exchange. */
export const PeerMessagesContext = createContext<readonly Message[]>([]);

const authorOf = (bots: readonly Bot[], peer: Pick<PeerLine, "botId" | "name">) =>
  bots.find((b) => b.id === peer.botId) ?? bots.find((b) => b.name === peer.name);

function PeerAvatar({ bot, name }: { bot?: Bot; name: string }) {
  return (
    <BotAvatar
      bot={bot ?? { name, color: "blue" }}
      state={normalizeState(bot?.mascotExpression) ?? "happy"}
      size={16}
      motion="none"
      motionKey={0}
      animated={false}
    />
  );
}

/** How the other bot reached this one, for its label. */
export const PEER_HOW = {
  delegate_bot: "chat.peer.handedTask",
  start_thread: "chat.peer.openedThread",
  coordinate_bots: "chat.peer.requested",
  ask_bot: "chat.peer.asked",
} as const satisfies Record<PeerLine["delivery"], string>;

/** The folded request: one line, opened by a click. */
export function PeerCompactRow({ preview, onOpen }: { preview: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("chat.showFull")}
      data-testid="peer-compact"
      className="flex w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] items-center gap-1.5 rounded-xl bg-card px-3 py-1.5 text-left text-[14px] text-ink-secondary hover:text-ink"
    >
      <ChevronRight size={14} className="shrink-0" />
      <span className="truncate">{preview}</span>
    </button>
  );
}

interface PeerContext {
  peer: PeerLine;
  bots: readonly Bot[];
  botId: string;
  botName: string;
}

/** Under an opened request: fold it again, or see the whole exchange beside the chat. */
export function PeerOpenedActions({ onFold, ...context }: PeerContext & { onFold: () => void }) {
  const [viewing, setViewing] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-3 pl-0.5 text-[13px] text-ink-secondary">
      <button type="button" onClick={onFold} className="hover:text-ink">{t("chat.showLess")}</button>
      <button type="button" onClick={() => setViewing(true)} className="flex items-center gap-1 hover:text-ink" data-testid="peer-view-exchange">
        <MessagesSquare size={13} />
        {t("chat.peer.viewExchange")}
      </button>
      {viewing && <PeerExchangePanel {...context} onClose={() => setViewing(false)} />}
    </div>
  );
}

function PeerExchangePanel({ peer, bots, botId, botName, onClose }: PeerContext & { onClose: () => void }) {
  const messages = use(PeerMessagesContext);
  const lines = useMemo(() => peerExchange(messages, botId, peer), [messages, botId, peer.botId, peer.name]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <PeerExchangeView lines={lines} peerName={peer.name} peerBot={authorOf(bots, peer)} botName={botName} self={bots.find((b) => b.id === botId)} onClose={onClose} />,
    document.body,
  );
}

export function PeerExchangeView({ lines, peerName, peerBot, botName, self, onClose }: {
  lines: readonly ExchangeLine[];
  peerName: string;
  peerBot?: Bot;
  botName: string;
  self?: Bot;
  onClose: () => void;
}) {
  const title = t("chat.peer.exchangeTitle", { peer: peerName, bot: botName });
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label={title} data-testid="peer-exchange" className="flex h-full w-[min(440px,100vw)] flex-col border-l border-hairline/50 bg-panel shadow-2xl shadow-black/50">
        <header className="flex items-center justify-between gap-3 border-b border-hairline/40 px-4 py-3">
          <h2 className="truncate text-[14px] font-medium text-ink">{title}</h2>
          <button type="button" autoFocus onClick={onClose} title={t("common.close")} aria-label={t("common.close")} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </header>
        <ol className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {lines.map((line) => {
            const name = line.from === "peer" ? peerName : botName;
            return (
              <li key={line.id} className="flex flex-col gap-1" data-from={line.from}>
                <div className="flex items-center gap-1.5 text-[11px] text-ink-tertiary">
                  <PeerAvatar bot={line.from === "peer" ? peerBot : self} name={name} />
                  <span className="font-medium text-ink-secondary">{name}</span>
                  <span>· {formatTime(line.at)}</span>
                </div>
                <div className={cn("whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl px-3 py-2 text-[14px] leading-relaxed text-ink", line.from === "peer" ? "bg-card" : "bg-inset/40")}>
                  {line.text}
                </div>
              </li>
            );
          })}
        </ol>
      </aside>
    </div>
  );
}
