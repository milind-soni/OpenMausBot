import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { cardSuggestions } from "@/lib/app-suggestions";
import { preloadConnectedApps } from "@/lib/connected-apps";
import { reserveConnectionPage } from "@/lib/connector-oauth";
import { pollConnector } from "@/lib/connector-poll";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { connectorConnect } from "@/lib/product-events";
import { api } from "@/state/store";
import { ServiceIcon, type ToolkitCard } from "./ServiceIcon";

const MIN_SHOWN = 2;

/** A connect card's "Also useful" row: each app connects in one tap, on the same sign-in page the Apps page opens. */
export function ConnectorAlsoUseful({ botId, slug }: { botId: string; slug: string }) {
  const [cards, setCards] = useState<ToolkitCard[]>([]);
  const [state, setState] = useState<Record<string, "busy" | "connected">>({});
  const [error, setError] = useState<string | { key: LocaleKey } | null>(null);
  const stops = useRef(new Set<() => void>());

  useEffect(() => {
    let alive = true;
    void cardSuggestions(botId, slug).then((found) => { if (alive) setCards(found); });
    return () => { alive = false; };
  }, [botId, slug]);
  useEffect(() => () => {
    for (const stop of stops.current) stop();
    stops.current.clear();
  }, []);

  if (cards.length < MIN_SHOWN) return null;

  const connect = async (card: ToolkitCard) => {
    if (state[card.slug]) return;
    const launch = reserveConnectionPage();
    setState((current) => ({ ...current, [card.slug]: "busy" }));
    setError(null);
    const settle = (connected: boolean) => setState((current) => {
      const { [card.slug]: _, ...rest } = current;
      return connected ? { ...current, [card.slug]: "connected" } : rest;
    });
    try {
      const result = await api(`/api/connectors/${encodeURIComponent(card.slug)}/authorize`, { method: "POST" });
      const url = mcpSignInLink(typeof result.url === "string" ? result.url : null);
      if (!url) throw new Error(t("connectors.invalidAuthorizationUrl"));
      if (!await launch.open(url)) setError({ key: "connectors.card.popupBlocked" });
      const stop = pollConnector(undefined, () => api(`/api/connectors?services=${encodeURIComponent(card.slug)}`).then((answer) => answer.services?.[card.slug]), (end) => {
        stops.current.delete(stop);
        connectorConnect(card.slug, end);
        settle(end === "connected");
        if (end === "connected") void preloadConnectedApps(true).catch(() => {});
      });
      stops.current.add(stop);
    } catch (cause) {
      settle(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      launch.cancel();
    }
  };

  return (
    <div data-also-useful="" className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="me-0.5 text-[12px] text-ink-tertiary">{t("connectors.card.alsoUseful")}</span>
        {cards.map((card) => {
          const now = state[card.slug];
          return (
            <button
              key={card.slug}
              type="button"
              data-also-useful-app={card.slug}
              disabled={Boolean(now)}
              onClick={() => void connect(card)}
              aria-label={now === "connected" ? `${card.label} · ${t("connectors.card.connected")}` : t("hostedMcp.connect", { service: card.label })}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-control/70 ps-1.5 pe-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-raised-hover disabled:opacity-70"
            >
              {now === "busy" ? <Loader2 size={14} className="animate-spin" /> : now === "connected" ? <Check size={14} className="text-success" /> : <ServiceIcon card={card} className="size-4 rounded" />}
              {card.label}
            </button>
          );
        })}
      </div>
      {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</p>}
    </div>
  );
}
