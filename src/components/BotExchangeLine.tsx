// The bots' exchanges for the person's request: a line over the message box while they work; an ended one leaves it.
import { use, useState } from "react";
import { ArrowLeftRight, Square } from "lucide-react";
import { BotAvatar, InitialsAvatar } from "./Avatar";
import { ELEVATED_FLOAT, ELEVATED_TINT } from "./elevated";
import { OpenExchangeContext } from "./HandoffExchange";
import { exchangeEnded, type BotExchangeEntry } from "@/lib/bot-exchanges";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotExchangesContext } from "@/lib/use-bot-exchanges";
import { formatDuration } from "@/lib/usage-trace";
import { ApiError } from "@/state/api";
import type { Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

const took = (entry: BotExchangeEntry, now = Date.now()) =>
  formatDuration(Math.max(1, Math.round(((entry.finishedAt ?? now) - entry.createdAt) / 1_000)) * 1_000);

function lineState(entry: BotExchangeEntry): string {
  if (entry.state === "asking") return t("chat.botExchange.asking");
  return entry.state === "needs-you" ? t("chat.botExchange.needsYou") : t("chat.botExchange.working");
}

export function BotExchangeLine() {
  const { exchanges: all } = use(BotExchangesContext);
  const open = use(OpenExchangeContext);
  const bots = useStoreSelector((state) => state.bots);
  const exchanges = all.filter((entry) => !exchangeEnded(entry.state));
  if (!open || !exchanges.length) return null;
  const botOf = (id: string | undefined) => id ? bots.find((candidate) => candidate.id === id) : undefined;
  return (
    <div role="status" data-bot-exchange-line className="pointer-events-none mx-5 mb-2 flex flex-wrap justify-center gap-2">
      {exchanges.map((entry) => {
        const asker = botOf(entry.asker.botId), helper = botOf(entry.helper.botId);
        const label = t("chat.botExchange.open", { asker: entry.asker.name, helper: entry.helper.name });
        const state = lineState(entry);
        return (
          <button
            key={entry.id}
            type="button"
            data-bot-exchange={entry.id}
            data-state={entry.state}
            aria-label={`${label} · ${state}`}
            title={`${entry.asker.name} ⇄ ${entry.helper.name} · ${state}`}
            onClick={() => open({
              id: entry.id, threadId: entry.threadId,
              asker: { botId: entry.asker.botId ?? "", name: entry.asker.name, color: asker?.color },
              helper: { botId: entry.helper.botId, name: entry.helper.name, color: helper?.color },
            })}
            className={cn("pointer-events-auto flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full ps-1.5 pe-3 text-[13px] leading-[18px] text-ink",
              ELEVATED_FLOAT, ELEVATED_TINT)}
          >
            <Face bot={asker} name={entry.asker.name} />
            <span dir="auto" className="min-w-0 max-w-[160px] truncate font-medium">{entry.asker.name}</span>
            <ArrowLeftRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
            <Face bot={helper} name={entry.helper.name} />
            <span dir="auto" className="min-w-0 max-w-[160px] truncate font-medium">{entry.helper.name}</span>
            <span aria-hidden="true" className="shrink-0 text-ink-tertiary">·</span>
            <span className={cn("shrink-0 tabular-nums", entry.state === "needs-you" ? "font-medium text-ink" : "text-ink-secondary")}>{state}</span>
          </button>
        );
      })}
    </div>
  );
}

function Face({ bot, name }: { bot: Bot | undefined; name: string }) {
  if (bot) return <BotAvatar bot={bot} state="happy" size={20} animated={false} />;
  return <InitialsAvatar initials={name.slice(0, 1).toUpperCase()} size={20} />;
}

function statusText(entry: BotExchangeEntry): string {
  const names = { asker: entry.asker.name, helper: entry.helper.name };
  switch (entry.state) {
    case "asking": return t("chat.botExchange.status.asking", names);
    case "working": return t("chat.botExchange.status.working", names);
    case "needs-you": return t("chat.botExchange.status.needsYou", names);
    case "answered": return t("chat.botExchange.status.answered", { ...names, duration: took(entry) });
    case "stopped": return t("chat.botExchange.status.stopped", { duration: took(entry) });
    case "expired": return t("chat.botExchange.status.expired", { duration: took(entry) });
    case "failed": return t("chat.botExchange.status.failed", names);
  }
}

/** Under an opened exchange: how it stands, and Stop while the helper still works on it. */
export function BotExchangeStatus({ id }: { id: string }) {
  const { exchanges, stop } = use(BotExchangesContext);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = exchanges.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const stoppable = !exchangeEnded(entry.state);
  const stopNow = async () => {
    setStopping(true);
    setError(null);
    try {
      await stop(entry.id);
    } catch (failure) {
      const status = failure instanceof ApiError ? failure.status : 0;
      setError(status === 403 ? t("chat.botExchange.notYours") : status === 404 ? t("chat.botExchange.gone") : t("chat.botExchange.stopFailed"));
    } finally {
      setStopping(false);
    }
  };
  return (
    <div data-bot-exchange-status={entry.state} className="chat-column mx-auto flex w-full items-center gap-3 px-4 pb-4 pt-2">
      <div className="min-w-0 flex-1">
        <p role="status" dir="auto" className="truncate text-[13px] leading-[18px] text-ink-secondary" title={statusText(entry)}>{statusText(entry)}</p>
        {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      </div>
      {stoppable && (
        <button type="button" data-bot-exchange-stop onClick={stopNow} disabled={stopping}
          className="ui-button ui-button-pill shrink-0">
          <Square size={12} aria-hidden="true" className="fill-current" />
          {stopping ? t("chat.botExchange.stopping") : t("chat.stop")}
        </button>
      )}
    </div>
  );
}
