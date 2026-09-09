// What this bot could connect, before you have asked it for anything.
//
// A new bot's first screen is a greeting and four suggested jobs, which is
// enough to start but says nothing about reach. This is the answer to "what
// can it actually do?" — the real catalog, so the breadth is the product's
// rather than a marketing list, and it disappears the moment the conversation
// starts. It is discoverability, not a control: nothing here is clickable,
// because connecting happens when a job needs it, not from a directory.
import { useEffect, useState } from "react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";

interface CatalogCard {
  slug: string;
  label: string;
  logo?: string | null;
  domain?: string | null;
}

/** How many to show. The catalog runs to well over a thousand; a row is a
 * hint at the size of the thing, not an index of it. */
const SHOWN = 24;

function AppChip({ card }: { card: CatalogCard }) {
  const [broken, setBroken] = useState(false);
  const source = !broken && card.logo
    ? card.logo
    : !broken && card.domain
      ? `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(card.domain)}`
      : null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-hairline/40 bg-card px-2.5 py-1">
      {source ? (
        <img src={source} alt="" onError={() => setBroken(true)} className="size-4 rounded" />
      ) : (
        <span className="flex size-4 items-center justify-center rounded bg-control text-[9px] font-semibold text-ink-secondary">
          {card.label.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="text-[12.5px] text-ink-secondary">{card.label}</span>
    </span>
  );
}

export function ConnectableApps() {
  const [cards, setCards] = useState<CatalogCard[] | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let alive = true;
    api("/api/connectors/catalog")
      .then((result) => {
        if (!alive) return;
        // Not configured means there is nothing true to say here, so say
        // nothing rather than advertising apps that cannot be connected.
        if (!result.configured) return setCards([]);
        const all: CatalogCard[] = Array.isArray(result.cards) ? result.cards : [];
        setTotal(all.length);
        setCards(all.slice(0, SHOWN));
      })
      .catch(() => alive && setCards([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!cards?.length) return null;
  return (
    <div className="mx-auto w-full max-w-[840px] px-1 pb-2">
      <div className="mb-1.5 text-[11.5px] uppercase tracking-[0.16em] text-ink-secondary">
        {total > SHOWN ? t("connectable.headingMore", { count: total }) : t("connectable.heading")}
      </div>
      {/* one scrolling row, and the page never scrolls sideways with it */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {cards.map((card) => <AppChip key={card.slug} card={card} />)}
      </div>
    </div>
  );
}
