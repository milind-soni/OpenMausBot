import { isValidElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import type { TranscriptItem } from "@/lib/activity-runs";
import { peerLine, peerRequest } from "@/lib/peer-message";
import { t } from "@/lib/i18n";
import { localDay } from "@/lib/transcript-derivations";
import { MENU_MOTION_MS, useMenuMotion } from "../MenuMotion";
import { reducedMotion } from "@/lib/onboarding";
import { DaySeparator } from "../DaySeparator";
import "./chat-v2.css";

function exchange(item: TranscriptItem, botId: string) {
  if (item.kind !== "message") return null;
  const m = item.message;
  if (m.comm) return { id: m.comm.withBotId, name: m.comm.withName, direction: m.roomRequest?.phase };
  const peer = peerLine(m) ?? peerRequest(m, botId);
  return peer && { id: peer.botId ?? peer.name, name: peer.name, direction: "result" };
}

export function ExchangeTimeline({ items, botId, focusId, unreadId, render, working = false, ready = true, storedKeys }: {
  items: TranscriptItem[];
  botId: string;
  working?: boolean;
  ready?: boolean;
  storedKeys?: ReadonlySet<string>;
  focusId: string | null;
  unreadId: string | null;
  render: (item: TranscriptItem, index: number) => ReactNode;
}) {
  const rows: ReactNode[] = [];
  const today = localDay(Date.now());
  let previousDay: number | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const first = item.kind === "message" ? item.message : item.messages[0];
    if (first) {
      const day = localDay(first.at);
      if (day !== previousDay) rows.push(<DaySeparator key={`day:${first.id}`} at={first.at} today={today} />);
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
  return <TimelineRows rows={rows} working={working} ready={ready} storedKeys={storedKeys} />;
}

function TimelineRows({ rows, working, ready, storedKeys }: {
  rows: ReactNode[];
  working: boolean;
  ready: boolean;
  storedKeys?: ReadonlySet<string>;
}) {
  const previous = useRef<{ rows: ReactNode[]; working: boolean; storedKeys?: ReadonlySet<string> } | null>(null);
  const old = previous.current;
  const liveUpdate = ready && old !== null && (working || old.working);
  const [leaving, setLeaving] = useState<{ row: ReactElement; before: string | null }[]>([]);
  const keys = new Set(rows.filter(isValidElement).map(row => row.key));
  const removed = liveUpdate && !reducedMotion() ? old.rows.flatMap((row, index) => {
    if (!isValidElement(row) || !row.key || keys.has(row.key)) return [];
    const work = row.key.startsWith("work:") || row.key.startsWith("work-step:");
    const deleted = old.storedKeys?.has(row.key) && !storedKeys?.has(row.key);
    if (!work && !deleted) return [];
    return [{ row, before: old.rows.slice(index + 1).filter(isValidElement).find(next => keys.has(next.key))?.key ?? null }];
  }) : [];
  const exits = [...leaving.filter(item => !removed.some(next => next.row.key === item.row.key)), ...removed];
  useLayoutEffect(() => {
    previous.current = ready ? { rows, working, storedKeys } : null;
    if (removed.length) setLeaving(exits);
  });
  useLayoutEffect(() => {
    if (!leaving.length) return;
    const timer = window.setTimeout(() => setLeaving([]), MENU_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const pending = exits.filter(({ row }) => !keys.has(row.key));
  return <>
    {rows.flatMap<ReactNode>(row => isValidElement(row) ? [
      ...pending.filter(item => item.before === row.key).map(item => <TimelineRow key={item.row.key} row={item.row} leaving />),
      <TimelineRow key={row.key} row={row} entering={liveUpdate} />,
    ] : [row])}
    {pending.filter(item => !keys.has(item.before)).map(item => <TimelineRow key={item.row.key} row={item.row} leaving />)}
  </>;
}

function TimelineRow({ row, entering, leaving }: { row: ReactElement; entering?: boolean; leaving?: boolean }) {
  const [animated] = useState(Boolean(entering));
  return <div className="v2-timeline-row" data-live-entry={animated || undefined} data-leaving={leaving || undefined}
    inert={leaving || undefined} aria-hidden={leaving || undefined}>
    <div className="v2-timeline-content">{row}</div>
  </div>;
}

function Exchange({ label, contents }: { label: string; contents: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="v2-exchange">
      <summary><MessagesSquare size={15} aria-hidden /> <span>{label}</span>
        <span className="text-ink-tertiary">· {t("chat.v2.records", { count: contents.length })}</span><ChevronRight size={14} aria-hidden /></summary>
      <div className="min-h-0 overflow-clip" inert={!open} aria-hidden={!open || undefined}>
        {motion.shown && <div className="grid min-w-0 gap-2 border-s border-hairline ps-3 pt-2">{contents}</div>}
      </div>
    </details>;
}
