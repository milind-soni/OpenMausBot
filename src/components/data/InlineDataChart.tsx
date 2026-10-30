import { useEffect, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import type { DataCard } from "../../../shared/data-surface";
import { useStore } from "@/state/store";
import { useColorScheme } from "@/lib/color-scheme";
import { t } from "@/lib/i18n";
import { DataChart } from "./DataChart";

const loads = new Map<string, "loading" | "failed">();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const settle = (botId: string, state: "loading" | "failed") => {
  loads.set(botId, state);
  for (const listener of listeners) listener();
};

/** The card a chat receipt names, from its bot's sheet. The sheet loads once per bot, then follows the server's
 * broadcasts. `undefined` while it loads; `null` when there is no such card or the sheet cannot be read. */
export function useDataCard(botId: string, cardId: string, enabled = true): DataCard | null | undefined {
  const { state, dispatch } = useStore();
  const sheet = state.dataSheets?.[botId];
  const load = useSyncExternalStore(subscribe, () => loads.get(botId));
  useEffect(() => {
    if (!enabled || sheet || loads.has(botId)) return;
    settle(botId, "loading");
    dispatch({ type: "loadDataSheet", botId, onError: () => settle(botId, "failed") });
  }, [enabled, botId, sheet, dispatch]);
  if (!enabled) return null;
  if (!sheet) return load === "failed" ? null : undefined;
  return sheet.cards.find((card) => card.id === cardId) ?? null;
}

/** A chart result drawn in the message itself, at chat width, in the app's light or dark scheme. */
export function InlineDataChart({ botId, cardId, title }: { botId: string; cardId: string; title: string }) {
  const card = useDataCard(botId, cardId);
  const theme = useColorScheme();
  if (card === null || (card && (card.status === "failed" || (card.status === "ready" && (card.kind !== "chart" || !card.vegaLite))))) return null;
  return (
    <div role="img" aria-label={title} data-testid="inline-data-chart" className="flex h-[280px] flex-col border-t border-hairline/40 px-2 pt-1 pb-2">
      {card?.status === "ready" && card.vegaLite
        ? <DataChart botId={botId} cardId={card.id} spec={card.vegaLite} rowCount={card.rowCount} theme={theme} revision={card.result ?? card.updatedAt} inline />
        : <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-secondary" role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("data.chart.loading")}
          </div>}
    </div>
  );
}
