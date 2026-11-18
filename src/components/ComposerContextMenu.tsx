import { useEffect, useRef, useState } from "react";
import { Gauge, RotateCcw, Shrink } from "lucide-react";

import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { cn } from "@/lib/cn";
import { compactedSinceReading } from "@/lib/context-warning";
import { contextReading, contextRowLabel, contextRows, roomContextReadings, type ContextReading, type ContextRow } from "@/lib/context-usage";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { formatTokens, type ContextTone } from "@/lib/usage";
import { api } from "@/state/api";
import { visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import type { ContextBreakdown } from "../../shared/context-breakdown";
import { useContextAction } from "./ContextWarning";
import { MENU_ICON, MENU_LABEL, MENU_NOTE, MENU_ROW, MENU_SEPARATOR, MENU_SHEET } from "./menu-recipe";

const TONE_INK: Record<ContextTone, string> = { quiet: "", warning: "text-warning", danger: "text-danger" };
const TONE_FILL: Record<ContextTone, string> = { quiet: "bg-ink-tertiary", warning: "bg-warning", danger: "bg-danger" };
const RING = 16;
const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ContextRing({ percent }: { percent: number }) {
  const filled = RING_LENGTH * Math.min(100, Math.max(4, percent)) / 100;
  return (
    <svg aria-hidden="true" width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} fill="none" stroke="currentColor" strokeWidth={1.75} className="-rotate-90">
      <circle cx={RING / 2} cy={RING / 2} r={RING_RADIUS} opacity={0.3} />
      <circle cx={RING / 2} cy={RING / 2} r={RING_RADIUS} strokeLinecap="round" strokeDasharray={`${filled} ${RING_LENGTH}`} />
    </svg>
  );
}

function tokensLine(reading: ContextReading): string {
  return reading.window
    ? t("contextMenu.tokensOfWindow", { tokens: formatTokens(reading.tokens), window: formatTokens(reading.window) })
    : t("contextMenu.tokens", { tokens: formatTokens(reading.tokens) });
}

function Meter({ reading, name, detailed }: { reading: ContextReading; name?: string; detailed: boolean }) {
  const tokens = detailed ? tokensLine(reading) : "";
  const used = reading.percent === undefined ? tokens : t("contextMenu.used", { percent: reading.percent });
  return (
    <div data-context-meter={reading.percent ?? ""} className="flex flex-col gap-1.5 px-2 py-1">
      <div className="flex items-baseline gap-3 text-[13px] leading-[18px]">
        <span className={cn("min-w-0 truncate font-medium tabular-nums", TONE_INK[reading.tone] || "text-ink")}>{name ?? used}</span>
        <span className="ms-auto shrink-0 text-[12px] leading-4 tabular-nums text-ink-tertiary">
          {name ? used : reading.percent === undefined ? "" : tokens}
        </span>
      </div>
      {reading.percent !== undefined && (
        <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-ink/[0.08]">
          <div className={cn("h-full rounded-full", TONE_FILL[reading.tone])} style={{ width: `${Math.min(100, reading.percent)}%` }} />
        </div>
      )}
      {name && detailed && reading.percent !== undefined && (
        <div className="min-w-0 truncate text-[12px] leading-4 tabular-nums text-ink-tertiary">{tokens}</div>
      )}
    </div>
  );
}

function Breakdown({ rows }: { rows: ContextRow[] }) {
  return (
    <dl data-context-breakdown className="flex flex-col gap-1 px-2 py-1 text-[12px] leading-4">
      {rows.map((row) => (
        <div key={row.id} className="flex items-baseline gap-3">
          <dt className={cn("min-w-0 truncate", row.id === "free" ? "text-ink-tertiary" : "text-ink-secondary")}>{contextRowLabel(row.id)}</dt>
          <dd className="ms-auto shrink-0 tabular-nums text-ink-tertiary">
            {t("contextMenu.rowShare", { tokens: formatTokens(row.tokens), percent: row.percent })}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A reading taken before the conversation was summarized says nothing about its size now. */
function currentContext(bot: Bot, messages: readonly Message[]) {
  return compactedSinceReading(messages) ? undefined : bot.tasks?.find((task) => task.threadId === bot.threadId)?.usage?.context;
}

/** A summary only reaches the engine's session with the next turn, so until that turn has ended the engine still counts
 * the conversation as it was before. */
function summaryNotCounted(messages: readonly Message[], busy: boolean): boolean {
  if (!busy) return compactedSinceReading(messages);
  const summary = messages.findLastIndex((message) => message.kind === "compaction");
  const asked = messages.findLastIndex((message) => message.role === "user");
  return compactedSinceReading(messages.slice(0, Math.max(asked, summary + 1)));
}

const lastBreakdown = new Map<string, { moment: string; breakdown: ContextBreakdown }>();
const newestRequest = new Map<string, number>();
let requests = 0;

/** The engine's own count, asked for while the panel is open in Advanced mode and again whenever a turn starts or ends. The last answer
 * shows until the new one lands; none is asked for or shown between a summary or fresh start and the end of the next turn,
 * and a count taken on one branch of the conversation is dropped when another is picked. */
function useContextBreakdown(bot: Bot | undefined, open: boolean): ContextBreakdown | null {
  const id = bot?.id;
  const threadId = bot?.threadId;
  const busy = Boolean(bot?.busy);
  const messages = bot ? visibleMessages(bot) : [];
  const slot = `${id}:${threadId ?? ""}`;
  const withheld = summaryNotCounted(messages, busy);
  const leaf = messages.at(-1)?.id;
  const [path, setPath] = useState({ slot, leaf, switches: 0 });
  if (path.slot !== slot || path.leaf !== leaf) {
    // A message that is still in the conversation but no longer shown means another branch was picked.
    const switched = path.slot === slot && !messages.some((message) => message.id === path.leaf) && Boolean(bot?.messages.some((message) => message.id === path.leaf));
    setPath({ slot, leaf, switches: path.slot === slot ? path.switches + Number(switched) : 0 });
  }
  const moment = `${messages.filter((message) => message.kind === "compaction").length}:${withheld}:${path.switches}`;
  const [answer, setAnswer] = useState<{ slot: string; moment: string; breakdown: ContextBreakdown | null } | null>(null);
  useEffect(() => {
    if (!path.switches) return;
    lastBreakdown.delete(slot);
    newestRequest.delete(slot);
  }, [slot, path.switches]);
  useEffect(() => {
    if (withheld) {
      lastBreakdown.delete(slot);
      newestRequest.delete(slot);
    }
    if (!open || !id || !threadId || withheld) return;
    let current = true;
    const request = ++requests;
    newestRequest.set(slot, request);
    void api<{ breakdown: ContextBreakdown | null }>(`/api/bots/${id}/context`, { method: "POST", body: JSON.stringify({ threadId }) })
      .then((reply) => reply?.breakdown ?? null, () => null)
      .then((breakdown) => {
        if (newestRequest.get(slot) !== request) return;
        if (breakdown) lastBreakdown.set(slot, { moment, breakdown }); else lastBreakdown.delete(slot);
        if (current) setAnswer({ slot, moment, breakdown });
      });
    return () => { current = false; };
  }, [open, id, threadId, slot, moment, busy, withheld]);
  if (!open || withheld) return null;
  if (answer?.slot === slot && answer.moment === moment) return answer.breakdown;
  const last = lastBreakdown.get(slot);
  return last?.moment === moment ? last.breakdown : null;
}

function ChatContext({ bot, reading, breakdown, detailed, onDone }: { bot: Bot; reading: ContextReading | null; breakdown: ContextBreakdown | null; detailed: boolean; onDone: () => void }) {
  const compact = useContextAction();
  const fresh = useContextAction();
  const messages = visibleMessages(bot);
  const rows = contextRows(breakdown);
  const atFreshStart = messages.at(-1)?.compaction?.fresh === true;
  const idle = !bot.busy && !compact.pending && !fresh.pending && messages.length > 0 && !atFreshStart;
  return (
    <>
      <div className={MENU_LABEL}>{t("contextMenu.title")}</div>
      {reading && (detailed || reading.percent !== undefined) ? <Meter reading={reading} detailed={detailed} /> : <p className={MENU_NOTE}>{t("contextMenu.empty")}</p>}
      {rows && <Breakdown rows={rows} />}
      {breakdown?.autoCompact === true && <p className={MENU_NOTE}>{t("contextMenu.providerCompacts")}</p>}
      <div className={MENU_SEPARATOR} />
      <button type="button" data-context-compact className={MENU_ROW} disabled={!idle || compactedSinceReading(messages)}
        title={t(bot.busy ? "contextWarning.busy" : "contextMenu.compactHint")}
        onClick={() => compact.run(`/api/bots/${bot.id}/compact`, { threadId: bot.threadId })}>
        <Shrink size={16} className={MENU_ICON} />
        <span className="min-w-0 truncate">{compact.pending ? t("contextWarning.compacting") : t("contextMenu.compact")}</span>
      </button>
      <button type="button" data-context-fresh className={MENU_ROW} disabled={!idle}
        title={t(bot.busy ? "contextWarning.busy" : "chat.startFresh.hint")}
        onClick={() => { fresh.run(`/api/bots/${bot.id}/start-fresh`, { threadId: bot.threadId }); onDone(); }}>
        <RotateCcw size={16} className={MENU_ICON} />
        <span className="min-w-0 truncate">{t("chat.startFresh")}</span>
      </button>
    </>
  );
}

function RoomContext({ group, members, detailed }: { group: Group; members: readonly Bot[]; detailed: boolean }) {
  const { pending, run } = useContextAction();
  const [target, setTarget] = useState<string | null>(null);
  const readings = roomContextReadings(group, members);
  return (
    <>
      <div className={MENU_LABEL}>{t("contextMenu.roomTitle")}</div>
      {!readings.length && <p className={MENU_NOTE}>{t("contextMenu.roomEmpty")}</p>}
      {readings.map(({ bot, reading, requested }) => (
        <div key={bot.id} data-context-member={bot.id} className="flex flex-col">
          <Meter reading={reading} name={bot.name} detailed={detailed} />
          {requested
            ? <p className={MENU_NOTE}>{t("contextWarning.roomRequested")}</p>
            : <button type="button" data-context-compact className={MENU_ROW} disabled={pending} title={t("contextWarning.roomHint")}
              onClick={() => { setTarget(bot.id); run(`/api/groups/${group.id}/members/${bot.id}/compact`, {}); }}>
              <Shrink size={16} className={MENU_ICON} />
              <span className="min-w-0 truncate">{pending && target === bot.id ? t("contextWarning.compacting") : t("contextMenu.compact")}</span>
            </button>}
        </div>
      ))}
    </>
  );
}

export function ComposerContextMenu({ bot, group, members, className }: { bot?: Bot; group?: Group; members?: readonly Bot[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  usePopoverDismiss(open, root, close);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  const advanced = useAdvancedMode();
  const breakdown = useContextBreakdown(group || !advanced ? undefined : bot, open);
  if (!bot && !group) return null;
  const context = bot && currentContext(bot, visibleMessages(bot));
  const fullest = group
    ? roomContextReadings(group, members ?? []).map((entry) => entry.reading).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0]
    : contextReading(breakdown?.tokens, breakdown?.window) ?? contextReading(context?.tokens, context?.window);
  const name = fullest?.percent === undefined ? t("contextMenu.title") : t("contextMenu.button", { percent: fullest.percent });
  return (
    <span ref={root} data-composer-context className="relative flex shrink-0">
      <button ref={trigger} type="button" aria-label={name} title={name} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn("flex shrink-0 items-center justify-center rounded-full", className, fullest && TONE_INK[fullest.tone], open && "bg-ink/[0.09] text-ink")}>
        {fullest?.percent === undefined ? <Gauge size={16} /> : <ContextRing percent={fullest.percent} />}
      </button>
      {open && (
        <div ref={panel} role="dialog" tabIndex={-1} aria-label={t("contextMenu.title")} data-context-panel
          className={cn("animate-pop-in absolute bottom-full end-0 z-50 mb-2 max-h-[min(28rem,calc(100dvh-8rem))] w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain outline-none", MENU_SHEET)}>
          {group ? <RoomContext group={group} members={members ?? []} detailed={advanced} /> : bot && <ChatContext bot={bot} reading={fullest ?? null} breakdown={breakdown} detailed={advanced} onDone={close} />}
        </div>
      )}
    </span>
  );
}
