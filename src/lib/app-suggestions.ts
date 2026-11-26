import { useEffect, useRef, useState } from "react";

import type { ToolkitCard } from "@/components/ServiceIcon";
import { api } from "@/state/store";
import { SUGGESTED_CARD_SIZE, type AppPickState } from "../../shared/app-suggestions";

export interface AppSuggestions {
  cards: ToolkitCard[];
  pick: AppPickState;
}

const NONE: AppSuggestions = { cards: [], pick: "available" };

const read = (answer: Partial<AppSuggestions> | null | undefined): AppSuggestions =>
  Array.isArray(answer?.cards) ? { cards: answer.cards, pick: answer.pick ?? "available" } : NONE;

/** The apps a connect card offers beside its own. Nothing, without a word, when they can't be read. */
export async function cardSuggestions(botId: string, slug: string): Promise<ToolkitCard[]> {
  const query = new URLSearchParams({ botId, for: slug, limit: String(SUGGESTED_CARD_SIZE) });
  return api(`/api/connectors/suggestions?${query}`).then((answer) => read(answer).cards).catch(() => []);
}

/** The Apps page's Suggested section. `reload` changes when what is connected does. */
export function useSuggestedApps(enabled: boolean, reload: string) {
  const [suggestions, setSuggestions] = useState<AppSuggestions>(NONE);
  const [picking, setPicking] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const request = ++latest.current;
    void api("/api/connectors/suggestions").then((answer) => { if (request === latest.current) setSuggestions(read(answer)); }).catch(() => {});
  }, [enabled, reload]);

  /** Whatever goes wrong, the list on screen stays and nothing is said. */
  const pick = () => {
    if (picking) return;
    setPicking(true);
    const request = ++latest.current;
    void api("/api/connectors/suggestions/pick", { method: "POST" })
      .then((answer) => { if (request === latest.current && read(answer).cards.length) setSuggestions(read(answer)); })
      .catch(() => {})
      .finally(() => setPicking(false));
  };

  return { suggestions, picking, pick };
}
