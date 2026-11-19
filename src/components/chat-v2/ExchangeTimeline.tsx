import { useState, type ReactNode } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import type { TranscriptItem } from "@/lib/activity-runs";
import { peerLine, peerRequest } from "@/lib/peer-message";
import { t } from "@/lib/i18n";
import { localDay } from "@/lib/transcript-derivations";
import { DaySeparator } from "../DaySeparator";
import "./chat-v2.css";

function exchange(item: TranscriptItem, botId: string) {
  if (item.kind !== "message") return null;
  const m = item.message;
  if (m.comm) return { id: m.comm.withBotId, name: m.comm.withName, direction: m.roomRequest?.phase };
  const peer = peerLine(m) ?? peerRequest(m, botId);
  return peer && { id: peer.botId ?? peer.name, name: peer.name, direction: "result" };
}

export function ExchangeTimeline({ items, botId, focusId, unreadId, render }: {
  items: TranscriptItem[];
  botId: string;
  focusId: string | null;
  unreadId: string | null;
  render: (item: TranscriptItem, index: number) => ReactNode;
}) {
  const rows: ReactNode[] = [];
  const today = localDay(Date.now());
  let previousDay: number | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === "message") {
      const day = localDay(item.message.at);
      if (day !== previousDay) rows.push(<DaySeparator key={`day:${item.message.id}`} at={item.message.at} today={today} />);
      previousDay = day;
    }
    const peer = exchange(item, botId);
    if (!peer || item.kind !== "message" || item.message.id === focusId || item.message.id === unreadId) {
      rows.push(render(item, i));
      continue;
    }
    const participants = new Map([[peer.id, peer.name]]);
    let direction = peer.direction;
    const contents = [render(item, i)];
    while (i + 1 < items.length) {
      const next = items[i + 1]!;
      const other = exchange(next, botId);
      if (!other || next.kind !== "message" || next.message.id === focusId || next.message.id === unreadId ||
          next.message.turnId !== item.message.turnId || localDay(next.message.at) !== localDay(item.message.at)) break;
      if (other.direction !== direction) direction = undefined;
      participants.set(other.id, other.name);
      contents.push(render(next, ++i));
    }
    const names = participants.size === 1 ? peer.name : t("chat.v2.bots", { count: participants.size });
    const label = direction === "request" ? t("chat.v2.sent", { names }) : direction === "result" ? t("chat.v2.received", { names }) : names;
    rows.push(<Exchange key={item.message.id} label={label} contents={contents} />);
  }
  return <>{rows}</>;
}

function Exchange({ label, contents }: { label: string; contents: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="v2-exchange">
      <summary><MessagesSquare size={15} aria-hidden /> <span>{label}</span>
        <span className="text-ink-tertiary">· {t("chat.v2.records", { count: contents.length })}</span><ChevronRight size={14} aria-hidden /></summary>
      <div className="grid min-w-0 gap-2 border-s border-hairline ps-3">{open && contents}</div>
    </details>;
}
