import { useState } from "react";
import { Check } from "lucide-react";
import { awakeCandidates, showBotLimit } from "@/lib/bot-limit";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api } from "@/state/api";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { PRIMARY_BUTTON } from "./NoticeCard";

type Candidate = Pick<Bot, "id" | "busy" | "tasks">;
const lastActive = (bot: Candidate) => Math.max(0, ...(bot.tasks ?? []).map((task) => task.updatedAt ?? task.createdAt ?? 0));

/** The bots offered awake: those awake now, or with `swapIn` chosen in place of the least recently active one not working. */
export function initialAwake(bots: readonly Candidate[], paused: ReadonlySet<string>, wanted: number, swapIn?: string): Set<string> {
  const awake = bots.filter((bot) => !paused.has(bot.id) && bot.id !== swapIn);
  if (!swapIn || !bots.some((bot) => bot.id === swapIn)) return new Set(awake.map((bot) => bot.id));
  const idleFirst = [...awake].sort((a, b) => Number(Boolean(a.busy)) - Number(Boolean(b.busy)) || lastActive(a) - lastActive(b));
  const kept = new Set(awake.map((bot) => bot.id));
  for (const bot of idleFirst) if (kept.size > wanted - 1) kept.delete(bot.id);
  return new Set([...kept, swapIn]);
}

/** Which of a Starter Cloud's bots stay awake: the plan's number of them, the rest paused until swapped in or an upgrade. */
export function AwakeBotsPicker({ limit, onSaved, swapIn }: { limit: number; onSaved: () => void; swapIn?: string }) {
  const { state } = useStore();
  const bots = awakeCandidates(state.bots);
  const paused = new Set(state.config?.pausedBots ?? []);
  const wanted = Math.min(limit, bots.length);
  const [chosen, setChosen] = useState<Set<string>>(() => initialAwake(bots, paused, wanted, swapIn));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggle = (id: string) => setChosen((before) => {
    const next = new Set(before);
    if (next.has(id)) next.delete(id);
    else if (next.size < wanted) next.add(id);
    return next;
  });
  const save = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api("/api/starter/awake", { method: "POST", body: JSON.stringify({ awake: [...chosen] }) });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 w-full text-start" data-awake-bots="">
      <p className="mb-1.5 text-[12px] text-ink-tertiary">{t("botLimit.paused.chosen", { chosen: chosen.size, count: wanted })}</p>
      <ul className="max-h-[220px] overflow-y-auto rounded-md border border-hairline">
        {bots.map((bot) => {
          const on = chosen.has(bot.id);
          return (
            <li key={bot.id}>
              <button type="button" role="checkbox" aria-checked={on} disabled={!on && chosen.size >= wanted} onClick={() => toggle(bot.id)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-[14px] hover:bg-raised disabled:opacity-50">
                <BotAvatar bot={bot} size={22} animated={false} />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                {!on && <span className="text-[12px] text-ink-tertiary">{t("botLimit.paused.badge")}</span>}
                {on && <Check size={15} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" disabled={busy || chosen.size !== wanted} onClick={() => void save()} className={cn(PRIMARY_BUTTON, "mt-3 w-full justify-center")}>
        {t("botLimit.paused.keep")}
      </button>
      {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("botLimit.paused.saveFailed")}</p>}
    </div>
  );
}

/** Opens the picker from settings while bots are paused. */
export function PausedBotsButton() {
  const { state } = useStore();
  const paused = state.config?.pausedBots?.length ?? 0;
  if (!paused || state.config?.awakeLimit === undefined) return null;
  return <button type="button" className="ui-button" onClick={() => showBotLimit("paused")}>{t("botLimit.paused.chooseAction", { count: paused })}</button>;
}
