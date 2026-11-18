import { useEffect, useMemo, useState } from "react";
import { Check, Circle, Clock3, ListTodo, Loader2, ShieldAlert, Square, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { RoomActivityEntry, RoomActivityStatus } from "@/lib/roomActivity";
import { useRoomActivity, useStore, type Bot, type Group, type Message } from "@/state/store";
import { RoomBuddyAvatar } from "./LiveBuddyAvatar";

type DisplayStatus = RoomActivityStatus | "queued";

const statusMeta: Record<DisplayStatus, { label: string; className: string }> = {
  waiting: { label: "Idle", className: "bg-raised text-ink-secondary" },
  queued: { label: "Queued", className: "bg-accent/10 text-accent" },
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  approval: { label: "Needs input", className: "bg-warning/10 text-warning" },
  completed: { label: "Completed", className: "bg-success/10 text-success" },
  cancelled: { label: "Stopped", className: "bg-raised text-ink-secondary" },
  failed: { label: "Failed", className: "bg-danger/10 text-danger" },
};

function elapsed(from: number | undefined, now: number): string | null {
  if (!from) return null;
  const seconds = Math.max(0, Math.floor((now - from) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function EntryIcon({ entry }: { entry: Pick<RoomActivityEntry, "status" | "kind"> }) {
  if (entry.status === "running") return <Loader2 size={13} className="animate-spin text-accent" />;
  if (entry.status === "waiting" || entry.kind === "approval") return <ShieldAlert size={13} className="text-warning" />;
  if (entry.status === "failed") return <XCircle size={13} className="text-danger" />;
  if (entry.status === "cancelled") return <Square size={11} className="fill-current text-ink-secondary" />;
  return <Check size={13} className="text-success" />;
}

function persistedEntries(messages: Message[], botId: string): RoomActivityEntry[] {
  const seen = new Set<string>();
  const entries: RoomActivityEntry[] = [];
  for (const message of [...messages].reverse()) {
    if (message.kind !== "activity" || message.from?.botId !== botId || !message.tool) continue;
    const title = message.tool.name;
    if (seen.has(title)) continue;
    seen.add(title);
    entries.push({
      id: message.id,
      kind: title.startsWith("error:") ? "error" : "tool",
      title: title.replace(/^error:\s*/i, ""),
      status: message.tool.ok === false ? "failed" : "completed",
      startedAt: message.at,
      updatedAt: message.at,
    });
    if (entries.length === 3) break;
  }
  return entries;
}

function AgentActivityCard({
  bot,
  group,
  now,
}: {
  bot: Bot;
  group: Group;
  now: number;
}) {
  const { dispatch } = useStore();
  const roomActivity = useRoomActivity(group.threadId);
  const live = roomActivity[bot.id];
  const queueIndex = (group.queuedBotIds ?? []).indexOf(bot.id);
  const active = group.busyBotId === bot.id;
  const status: DisplayStatus = active
    ? live?.status === "approval" || live?.status === "failed" ? live.status : "running"
    : queueIndex >= 0
      ? "queued"
      : (live?.status ?? "waiting");
  const current = live?.entries.find((entry) => entry.status === "running" || entry.status === "waiting");
  const recent = useMemo(() => {
    const liveSettled = (live?.entries ?? []).filter((entry) => entry.status === "completed" || entry.status === "failed");
    const combined = [...liveSettled, ...persistedEntries(group.messages, bot.id)];
    const seen = new Set<string>();
    return combined.filter((entry) => !seen.has(`${entry.title}:${entry.status}`) && Boolean(seen.add(`${entry.title}:${entry.status}`))).slice(0, 3);
  }, [bot.id, group.messages, live?.entries]);
  const duration = elapsed(live?.startedAt, now);
  const meta = statusMeta[status];
  const stoppable = status === "queued" || status === "running" || status === "approval";

  return (
    <article className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="flex items-center gap-2.5">
        <RoomBuddyAvatar bot={bot} group={group} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{bot.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-secondary">
            {status === "queued" ? `Position ${queueIndex + 1}` : duration && (status === "running" || status === "approval") ? duration : bot.title || "Room member"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", meta.className)}>{meta.label}</span>
          {stoppable && (
            <button
              type="button"
              onClick={() => dispatch({ type: "stopGroupActivity", groupId: group.id, botId: bot.id })}
              aria-label={`Stop ${bot.name}'s activity`}
              title={status === "queued" ? "Remove from queue" : "Stop activity"}
              className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger"
            >
              <Square size={11} className="fill-current" />
            </button>
          )}
        </div>
      </div>

      {current && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-inset px-2.5 py-2">
          <EntryIcon entry={current} />
          <span className="min-w-0 flex-1 break-words font-mono text-[11px] leading-4 text-ink-secondary" title={current.title}>
            {current.title}
          </span>
        </div>
      )}

      {!current && status === "queued" && (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-secondary">
          <Clock3 size={13} /> Waiting for earlier agents to finish
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-hairline/30 pt-2.5">
          {recent.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 text-[11px] leading-4 text-ink-secondary">
              <EntryIcon entry={entry} />
              <span className="min-w-0 flex-1 truncate" title={entry.title}>{entry.title}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function RoomActivityPanel({
  group,
  members,
  onClose,
  className,
}: {
  group: Group;
  members: Bot[];
  onClose?: () => void;
  className?: string;
}) {
  const activity = useRoomActivity(group.threadId);
  const liveTimerNeeded = Boolean(group.busyBotId) || Object.values(activity).some((item) => item.status === "approval");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!liveTimerNeeded) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [liveTimerNeeded]);

  const queued = group.queuedBotIds ?? [];
  const ordered = useMemo(() => [...members].sort((a, b) => {
    if (a.id === group.busyBotId) return -1;
    if (b.id === group.busyBotId) return 1;
    const aQueue = queued.indexOf(a.id);
    const bQueue = queued.indexOf(b.id);
    if (aQueue >= 0 || bQueue >= 0) return aQueue < 0 ? 1 : bQueue < 0 ? -1 : aQueue - bQueue;
    return members.indexOf(a) - members.indexOf(b);
  }), [group.busyBotId, members, queued]);
  const activeCount = Number(Boolean(group.busyBotId)) + queued.length;

  return (
    <aside className={cn("flex h-full w-[320px] shrink-0 flex-col border-l border-hairline/40 bg-panel", className)} aria-label="Room activity">
      <div className="shrink-0 border-b border-hairline/40 px-4 py-3">
        <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <ListTodo size={16} className="text-accent" /> Activity
          </div>
          <div className="mt-0.5 text-[11px] text-ink-secondary">
            {activeCount ? `${activeCount} active or queued` : "All agents idle"}
          </div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close activity panel" className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        )}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {ordered.length ? ordered.map((bot) => <AgentActivityCard key={bot.id} bot={bot} group={group} now={now} />) : (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[12px] leading-5 text-ink-secondary">
            <Circle size={20} className="mb-3 text-ink-secondary/60" />
            Agent turns and tools will appear here.
          </div>
        )}
      </div>
    </aside>
  );
}
