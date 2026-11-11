import { useEffect, useState } from "react";

import { botAppScope } from "@/lib/bot-app-access";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";
import type { ConnectorScope } from "../../../shared/connector-scopes";
import { EMAIL_SLUG, type EmailStatus } from "../../../shared/email";
import { preloadConnectedApps, type ConnectorInventory } from "@/lib/connected-apps";
import type { ToolkitCard } from "../ServiceIcon";

export interface BotApp {
  slug: string;
  label: string;
  blurb: string;
  card: Pick<ToolkitCard, "logo" | "domain" | "label">;
  scope: ConnectorScope | null;
}

export interface BotApps {
  phase: "loading" | "ready" | "unknown";
  apps: BotApp[];
  connectedSlugs: string[];
}

let cardsRequest: Promise<Map<string, ToolkitCard>> | null = null;
export function loadAppCards(): Promise<Map<string, ToolkitCard>> {
  cardsRequest ??= api("/api/connectors/catalog")
    .then((response: { cards?: ToolkitCard[] }) => new Map((response.cards ?? []).map((card) => [card.slug, card])))
    .catch(() => {
      cardsRequest = null;
      return new Map<string, ToolkitCard>();
    });
  return cardsRequest;
}

function slugLabel(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[_-]+/g, " ");
}

/** Email is connected natively, not through the Composio inventory, so it brings its own card. */
export function emailAppCard(): Pick<ToolkitCard, "logo" | "domain" | "label"> & { blurb: string } {
  return { logo: null, domain: null, label: t("email.title"), blurb: t("email.description") };
}

export function botAppsFrom(
  bot: Pick<Bot, "composio" | "connectorScopes" | "connectorTools">,
  inventory: ConnectorInventory | null,
  cards: ReadonlyMap<string, ToolkitCard>,
  email: EmailStatus | null = null,
): BotApps {
  if (!inventory) return { phase: "loading", apps: [], connectedSlugs: [] };
  if (!inventory.authoritative) return { phase: "unknown", apps: [], connectedSlugs: [] };
  const connectedSlugs = Object.entries(inventory.services)
    .filter(([, status]) => status.connected)
    .map(([slug]) => slug);
  if (email?.state === "connected" && !connectedSlugs.includes(EMAIL_SLUG)) connectedSlugs.push(EMAIL_SLUG);
  connectedSlugs.sort((a, b) => a.localeCompare(b));
  const apps = connectedSlugs.map((slug) => {
    if (slug === EMAIL_SLUG && email?.state === "connected") {
      const { blurb, ...card } = emailAppCard();
      return { slug, label: card.label, blurb, card, scope: botAppScope(bot, slug) };
    }
    const card = cards.get(slug);
    const label = card?.label ?? slugLabel(slug);
    return {
      slug,
      label,
      blurb: card?.blurb ?? "",
      card: { logo: card?.logo ?? null, domain: card?.domain ?? null, label },
      scope: botAppScope(bot, slug),
    };
  });
  return { phase: "ready", apps, connectedSlugs };
}

export function useBotApps(bot: Bot): BotApps {
  const [inventory, setInventory] = useState<ConnectorInventory | null>(null);
  const [cards, setCards] = useState<ReadonlyMap<string, ToolkitCard>>(() => new Map());
  const [email, setEmail] = useState<EmailStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void preloadConnectedApps().then((result) => {
      if (!cancelled) setInventory(result);
    });
    void loadAppCards().then((result) => {
      if (!cancelled) setCards(result);
    });
    void api("/api/email").then((result: EmailStatus) => { if (!cancelled) setEmail(result); }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return botAppsFrom(bot, inventory, cards, email);
}
