import { memo, useMemo, useRef } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { connectorDescription } from "@/lib/app-catalog";
import { reusableConnectionUrl, type PendingAuthorization } from "@/lib/connector-oauth";
import {
  accountToReconnect,
  connectorActionLabel,
  hasActiveConnection,
  needsReconnect,
  type ConnectorAccount,
  type ConnectorInventoryPhase,
  type ConnectorStatus,
} from "@/lib/connector-status";
import type { AppState, Bot } from "@/state/store";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import { BotAvatar } from "./Avatar";
import { ServiceIcon, type ToolkitCard } from "./ServiceIcon";

export const USED_BY_AVATAR_SIZE = 16;

export interface AppTileActions {
  connect(slug: string, alias?: string, replacing?: ConnectorAccount): void;
  openUrl(url: string): void;
  /** Opens the app's account-name form, or closes it when it is the one open. */
  toggleAlias(slug: string): void;
  setAliasDraft(value: string): void;
  aliasRequired(): void;
  changeBots(slug: string): void;
  disconnect(target: { slug: string; label: string; account: ConnectorAccount }): void;
  openBotApps(botId: string): void;
}

export interface AppTileProps {
  card: ToolkitCard;
  serviceStatus: ConnectorStatus | undefined;
  pendingUrl: PendingAuthorization | undefined;
  /** The account name being typed for this app; null while its form is closed. */
  aliasDraft: string | null;
  busy: boolean;
  configured: boolean;
  inventoryPhase: ConnectorInventoryPhase;
  mode: "managed" | "self-hosted" | "unavailable";
  policy: NonNullable<AppState["config"]>["managedPolicy"] | undefined;
  usedBy: readonly Bot[];
  /** The bots that may use only some of this app's tools. */
  limited: readonly Bot[];
  canChangeBots: boolean;
  actions: AppTileActions;
}

export function tileStanding(card: ToolkitCard, serviceStatus: ConnectorStatus | undefined) {
  const failed = Boolean(serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status));
  const pending = Boolean(serviceStatus?.pending && !failed);
  const accounts = serviceStatus?.accounts ?? [];
  const included = card.noAuth === true
    || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
  return { failed, pending, accounts, included, connected: hasActiveConnection(serviceStatus) };
}

/** Actions that stay the same objects from render to render, each calling the newest one given, so a tile is not rendered
 * again for a handler that was only made anew. */
export function useTileActions(actions: AppTileActions): AppTileActions {
  const latest = useRef(actions);
  latest.current = actions;
  return useMemo<AppTileActions>(() => ({
    connect: (slug, alias, replacing) => latest.current.connect(slug, alias, replacing),
    openUrl: (url) => latest.current.openUrl(url),
    toggleAlias: (slug) => latest.current.toggleAlias(slug),
    setAliasDraft: (value) => latest.current.setAliasDraft(value),
    aliasRequired: () => latest.current.aliasRequired(),
    changeBots: (slug) => latest.current.changeBots(slug),
    disconnect: (target) => latest.current.disconnect(target),
    openBotApps: (botId) => latest.current.openBotApps(botId),
  }), []);
}

/** One app in the Apps panel. Props only and no hooks: it is rendered again only when something it shows changed. */
export function AppTileView({ card, serviceStatus, pendingUrl, aliasDraft, busy, configured, inventoryPhase, mode, policy, usedBy, limited, canChangeBots, actions }: AppTileProps) {
  const { failed, pending, accounts, included, connected } = tileStanding(card, serviceStatus);
  const pendingAuthorization = pending && !failed ? pendingUrl : undefined;
  const authorizationUrl = reusableConnectionUrl(pendingAuthorization);
  const reconnect = pending ? undefined : accountToReconnect(serviceStatus);
  const addingAccount = aliasDraft !== null && !included;
  const unavailableReason = policy?.apps && !policy.apps.allowAll && !policy.apps.allowlist.includes(card.slug) ? t("policy.managedBy", { organization: policy.organizationName })
    : managedConnectorUnavailableReason(mode, card.slug) ? t("connectors.selfHostOnlyReason") : null;
  const usedByLabel = t("apps.usedBy", { names: usedBy.map((candidate) => candidate.name).join(", ") });
  const description = unavailableReason ?? (
    pending
      ? authorizationUrl
        ? t("connectors.finishSetup")
        : t("connectors.finishSetupOrDisconnect")
      : reconnect
        ? t("connectors.signedOut")
        : failed && !accounts.length
          ? t("connectors.authExpired")
          : connectorDescription(card)
  );
  return (
    <div
      data-app-tile={card.slug}
      className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40"
    >
      <div className="flex items-center gap-3">
        <ServiceIcon card={card} className="size-10 shrink-0 rounded-[8px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{card.label}</span>
            {connected && !pending && (
              <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />
            )}
            {usedBy.length > 0 && (
              <span
                className="ms-1 flex shrink-0 -space-x-1.5 rtl:space-x-reverse"
                title={usedByLabel}
                aria-label={usedByLabel}
                role="img"
              >
                {usedBy.slice(0, 3).map((candidate) => (
                  <span
                    key={candidate.id}
                    data-used-by-avatar={candidate.id}
                    className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-menu ring-2 ring-menu"
                  >
                    <BotAvatar bot={candidate} size={USED_BY_AVATAR_SIZE} animated={false} />
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="truncate text-[13px] leading-[18px] text-ink-secondary" title={description}>
            {description}
          </div>
        </div>
        <button
          type="button"
          disabled={!configured || inventoryPhase !== "ready" || busy || included || Boolean(unavailableReason)}
          title={unavailableReason ?? undefined}
          onClick={() => {
            if (pending && !failed) {
              const url = reusableConnectionUrl(pendingAuthorization);
              if (url) {
                actions.openUrl(url);
              } else {
                actions.connect(card.slug);
              }
            } else if (reconnect) {
              actions.connect(card.slug, reconnect.alias, reconnect);
            } else {
              actions.toggleAlias(card.slug);
            }
          }}
          className="inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
        >
          {unavailableReason ? (
            t("connectors.selfHostOnly")
          ) : busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            connectorActionLabel(inventoryPhase, {
              busy,
              included,
              canContinue: Boolean(pendingAuthorization),
              pending,
              reconnect: Boolean(reconnect),
              hasAccounts: accounts.length > 0,
              failed: Boolean(failed),
            })
          )}
        </button>
      </div>
      <div className="ps-[52px]">
        {authorizationUrl && (
          <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            if (!reusableConnectionUrl(pendingAuthorization)) {
              event.preventDefault();
              actions.connect(card.slug);
            }
          }} className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
            {t("connectors.openAuthorizationPage")}
          </a>
        )}
        {connected && !pending && (
          <div data-app-bots={card.slug} className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-5 text-ink-secondary">
            <span className="min-w-0 truncate" title={usedBy.length ? usedByLabel : undefined}>
              {usedBy.length ? usedByLabel : t("apps.usedByNone")}
            </span>
            {canChangeBots && (
              <button
                type="button"
                onClick={() => actions.changeBots(card.slug)}
                aria-label={t("apps.whichBots", { app: card.label })}
                className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-raised-hover"
              >
                {t("apps.usedByChange")}
              </button>
            )}
          </div>
        )}
        {accounts.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {accounts.map((account) => {
              const active = /^active$/i.test(account.status);
              const reconnectable = needsReconnect(account) && account.id !== reconnect?.id;
              return (
                <div key={account.id} className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
                  {active ? <Check size={12} className="shrink-0 text-success" /> : <span className="size-3 shrink-0" />}
                  <span className="min-w-0 truncate text-ink" title={`${account.alias ? `${account.id} · ` : ""}${account.status.toLowerCase()}`}>
                    {account.alias || account.id}
                    <span className="text-ink-secondary"> · {account.status.toLowerCase()}</span>
                  </span>
                  {reconnectable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => actions.connect(card.slug, account.alias, account)}
                      className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-raised-hover disabled:opacity-40"
                      aria-label={t("connectors.reconnectAria", { account: account.alias || account.id, service: card.label })}
                    >
                      {t("connectors.action.reconnect")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => actions.disconnect({ slug: card.slug, label: card.label, account })}
                    className={cn("shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40", !reconnectable && "ms-auto")}
                    aria-label={t("connectors.disconnectAria", {
                      account: account.alias || account.id,
                      service: card.label,
                    })}
                  >
                    {t("connectors.disconnect")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {(serviceStatus?.connected || included) && (() => {
          if (!limited.length) return null;
          const names = limited.slice(0, 4).map((candidate, index) => (
            <span key={candidate.id}>
              {index > 0 && ", "}
              <button
                type="button"
                onClick={() => actions.openBotApps(candidate.id)}
                className="font-medium text-ink underline underline-offset-2 hover:text-accent-text"
              >
                {candidate.name}
              </button>
            </span>
          ));
          return (
            <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
              <span>{t("connectors.grants.limited", { count: limited.length })}</span>{" "}
              {names}
              {limited.length > 4 && <span>{t("connectors.grants.more", { count: limited.length - 4 })}</span>}
            </div>
          );
        })()}
        {addingAccount && (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const alias = (aliasDraft ?? "").trim();
              if (!alias) {
                actions.aliasRequired();
                return;
              }
              actions.connect(card.slug, alias);
            }}
          >
            <input
              autoFocus
              value={aliasDraft ?? ""}
              maxLength={64}
              onChange={(event) => actions.setAliasDraft(event.target.value)}
              placeholder={t("connectors.aliasPlaceholder")}
              aria-label={accounts.length > 0
                ? t("connectors.aliasAriaAnother", { service: card.label })
                : t("connectors.aliasAriaNew", { service: card.label })}
              className="h-8 min-w-0 flex-1 rounded-full bg-inset px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={busy || !(aliasDraft ?? "").trim()}
              className="inline-flex h-7 shrink-0 items-center rounded-full bg-accent px-3 text-[13px] font-medium leading-5 text-accent-ink disabled:opacity-40"
            >
              {t("connectors.action.continue")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export const AppTile = memo(AppTileView);
