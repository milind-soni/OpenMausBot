import { useRef, useState } from "react";
import { Gauge, RotateCcw, Shrink } from "lucide-react";

import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { cn } from "@/lib/cn";
import { compactedSinceReading } from "@/lib/context-warning";
import { contextReading, contextRowLabel, contextRows, roomContextReadings, type ContextReading, type ContextRow } from "@/lib/context-usage";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { formatTokens, type ContextTone } from "@/lib/usage";
import { visibleMessages, type Bot, type Group, type Message } from "@/state/store";
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

function Meter({ reading, name }: { reading: ContextReading; name?: string }) {
  const used = reading.percent === undefined ? tokensLine(reading) : t("contextMenu.used", { percent: reading.percent });
  return (
    <div data-context-meter={reading.percent ?? ""} className="flex flex-col gap-1.5 px-2 py-1">
      <div className="flex items-baseline gap-3 text-[13px] leading-[18px]">
        <span className={cn("min-w-0 truncate font-medium tabular-nums", TONE_INK[reading.tone] || "text-ink")}>{name ?? used}</span>
        <span className="ms-auto shrink-0 text-[12px] leading-4 tabular-nums text-ink-tertiary">
          {name ? used : reading.percent === undefined ? "" : tokensLine(reading)}
        </span>
      </div>
      {reading.percent !== undefined && (
        <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-ink/[0.08]">
          <div className={cn("h-full rounded-full", TONE_FILL[reading.tone])} style={{ width: `${Math.min(100, reading.percent)}%` }} />
        </div>
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
            {row.percent === undefined ? formatTokens(row.tokens) : t("contextMenu.rowShare", { tokens: formatTokens(row.tokens), percent: row.percent })}
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

function ChatContext({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const advanced = useAdvancedMode();
  const compact = useContextAction();
  const fresh = useContextAction();
  const messages = visibleMessages(bot);
  const context = currentContext(bot, messages);
  const reading = contextReading(context?.tokens, context?.window);
  const rows = advanced ? contextRows(context) : null;
  const atFreshStart = messages.at(-1)?.compaction?.fresh === true;
  const idle = !bot.busy && !compact.pending && !fresh.pending && messages.length > 0 && !atFreshStart;
  return (
    <>
      <div className={MENU_LABEL}>{t("contextMenu.title")}</div>
      {reading ? <Meter reading={reading} /> : <p className={MENU_NOTE}>{t("contextMenu.empty")}</p>}
      {rows && <Breakdown rows={rows} />}
      {context?.breakdown?.providerCompacts && <p className={MENU_NOTE}>{t("contextMenu.providerCompacts")}</p>}
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

function RoomContext({ group, members }: { group: Group; members: readonly Bot[] }) {
  const { pending, run } = useContextAction();
  const [target, setTarget] = useState<string | null>(null);
  const readings = roomContextReadings(group, members);
  return (
    <>
      <div className={MENU_LABEL}>{t("contextMenu.roomTitle")}</div>
      {!readings.length && <p className={MENU_NOTE}>{t("contextMenu.roomEmpty")}</p>}
      {readings.map(({ bot, reading, requested }) => (
        <div key={bot.id} data-context-member={bot.id} className="flex flex-col">
          <Meter reading={reading} name={bot.name} />
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

/** How full the conversation's context is, beside the microphone, with the two ways to make it small again. In a room
 * every bot keeps its own context, so each one that has been measured there gets its own line. */
export function ComposerContextMenu({ bot, group, members, className }: { bot?: Bot; group?: Group; members?: readonly Bot[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  usePopoverDismiss(open, root, close);
  if (!bot && !group) return null;
  const context = bot && currentContext(bot, visibleMessages(bot));
  const fullest = group
    ? roomContextReadings(group, members ?? []).map((entry) => entry.reading).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0]
    : contextReading(context?.tokens, context?.window);
  const name = fullest?.percent === undefined ? t("contextMenu.title") : t("contextWarning.short", { percent: fullest.percent });
  return (
    <span ref={root} data-composer-context className="relative flex shrink-0">
      <button ref={trigger} type="button" aria-label={name} title={name} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn("flex shrink-0 items-center justify-center rounded-full", className, fullest && TONE_INK[fullest.tone], open && "bg-ink/[0.09] text-ink")}>
        {fullest?.percent === undefined ? <Gauge size={16} /> : <ContextRing percent={fullest.percent} />}
      </button>
      {open && (
        <div role="dialog" aria-label={t("contextMenu.title")} data-context-panel
          className={cn("animate-pop-in absolute bottom-full end-0 z-50 mb-2 max-h-[min(24rem,calc(100dvh-8rem))] w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain", MENU_SHEET)}>
          {group ? <RoomContext group={group} members={members ?? []} /> : bot && <ChatContext bot={bot} onDone={close} />}
        </div>
      )}
    </span>
  );
}
