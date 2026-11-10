import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { appSwitchPatch, botAppScope } from "@/lib/bot-app-access";
import type { ConnectorStatus } from "@/lib/connector-status";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Action, type Bot, type InstanceInfo } from "@/state/store";
import { EMAIL_SLUG } from "../../shared/email";
import { BotAvatar } from "./Avatar";
import { BotSwitch } from "./bot-panel/rows";

let connectingFromBot: string | null = null;

/** The Apps pop-up, opened from inside a bot: the prompt after a connect starts with that bot on. */
export function connectAppFromBot(dispatch: (action: Action) => void, botId: string) {
  connectingFromBot = botId;
  dispatch({ type: "toggleSettings", open: false });
  dispatch({ type: "togglePlugins", open: true, surface: "apps" });
}

function takeConnectingBot(): string | null {
  const botId = connectingFromBot;
  connectingFromBot = null;
  return botId;
}

/** The bots whose access an app can be given from here: a Team Cloud member's own helper is theirs alone. */
export function botsForApps(bots: Bot[], instances: InstanceInfo[]): Bot[] {
  return bots.filter((bot) =>
    !bot.hidden &&
    !bot.defaultBot?.person &&
    instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.composioMcp === true);
}

function connectedAppSlugs(status: Record<string, ConnectorStatus>, emailConnected: boolean | null): string[] {
  const slugs = Object.entries(status).filter(([, service]) => service.connected).map(([slug]) => slug);
  return emailConnected && !slugs.includes(EMAIL_SLUG) ? [...slugs, EMAIL_SLUG] : slugs;
}

/** Security: only an owner or admin is ever asked or allowed to change which bots use an app; on a Team Cloud a change
 * reaches every member who chats with that bot, so it is always asked, never made silently. */
export function useAppGrants({ status, emailConnected, inventoryReady }: { status: Record<string, ConnectorStatus>; emailConnected: boolean | null; inventoryReady: boolean }) {
  const { state, dispatch } = useStore();
  const admin = useOwnerOrAdmin();
  const [startingBot] = useState(takeConnectingBot);
  const [prompt, setPrompt] = useState<{ slug: string; start: string | null } | null>(null);
  const team = Boolean(state.config?.team);
  const bots = botsForApps(state.bots, state.instances);
  const canChange = admin === true && inventoryReady && bots.length > 0;

  const write = (bot: Bot, slug: string, on: boolean) => {
    const patch = appSwitchPatch(bot, connectedAppSlugs(status, emailConnected), slug, on);
    if (Object.keys(patch).length > 0) dispatch({ type: "updateBot", botId: bot.id, patch });
  };
  const latest = useRef({ admin, canChange, bots, team, startingBot, write });
  latest.current = { admin, canChange, bots, team, startingBot, write };

  const appConnected = useCallback((slug: string) => {
    const now = latest.current;
    if (now.admin !== true || !now.bots.length) return;
    if (now.bots.length === 1 && !now.team) now.write(now.bots[0]!, slug, true);
    else if (now.canChange) setPrompt({ slug, start: now.startingBot });
  }, []);
  const change = useCallback((slug: string) => setPrompt({ slug, start: null }), []);
  const dismiss = useCallback(() => setPrompt(null), []);

  const done = (on: ReadonlySet<string>) => {
    const slug = prompt?.slug;
    if (slug) {
      for (const bot of bots) if (on.has(bot.id) !== (botAppScope(bot, slug) !== null)) write(bot, slug, on.has(bot.id));
    }
    setPrompt(null);
  };

  return { canChange, appConnected, change, dismiss, done, prompt, bots };
}

export function AppGrantPrompt({ app, slug, bots, start, onDone, onDismiss }: {
  app: string;
  slug: string;
  bots: Bot[];
  start: string | null;
  onDone: (on: ReadonlySet<string>) => void;
  onDismiss: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set(
    bots.filter((bot) => botAppScope(bot, slug) !== null || bot.id === start).map((bot) => bot.id),
  ));

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    // In the capture phase, so the Apps pop-up behind this neither closes on Escape nor pulls Tab back to itself.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      } else if (event.key === "Tab") {
        event.stopPropagation();
        const controls = cardRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus();
    };
  }, [onDismiss]);

  const toggle = (botId: string) => setOn((current) => {
    const next = new Set(current);
    if (!next.delete(botId)) next.add(botId);
    return next;
  });

  return (
    <div
      data-app-grant-prompt={slug}
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onDismiss()}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-grant-title"
        tabIndex={-1}
        className="flex max-h-full w-full max-w-[360px] flex-col rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 id="app-grant-title" className="min-w-0 text-[15px] font-semibold text-ink">{t("apps.whichBots", { app })}</h3>
          <button type="button" aria-label={t("common.close")} onClick={onDismiss} className="-mt-1 -me-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {bots.map((bot) => (
            <div key={bot.id} className="flex min-h-11 items-center gap-2.5">
              <BotAvatar bot={bot} size={24} animated={false} />
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{bot.name}</span>
              <BotSwitch color={bot.color} checked={on.has(bot.id)} aria-label={t("botSettings.simple.appToggle", { name: bot.name, app })} onClick={() => toggle(bot.id)} />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={() => onDone(on)} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110">
            {t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
