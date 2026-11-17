import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";

import { appSwitchPatch, botAppScope } from "@/lib/bot-app-access";
import type { ConnectorStatus } from "@/lib/connector-status";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Action, type Bot, type InstanceInfo } from "@/state/store";
import { EMAIL_SLUG } from "../../shared/email";
import { BotAvatar } from "./Avatar";
import { UndoToast } from "./bot-access/ShareBotButton";
import { BotSwitch } from "./bot-panel/rows";

let connectingFromBot: string | null = null;
let notice: { slug: string; text: string } | null = null;
let changeRequested: string | null = null;
const watchers = new Set<() => void>();

function tell() {
  for (const watch of Array.from(watchers)) watch();
}
function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/** The Apps pop-up, opened from inside a bot: an app connected there goes to that bot even if its apps were off. */
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

export function showAppGrantNotice(next: { slug: string; text: string } | null) {
  notice = next;
  tell();
}

/** "Your bots can now use Apollo · Change", for a few seconds. It outlives the Apps pop-up, which Change opens again. */
export function AppGrantNotice() {
  const { dispatch } = useStore();
  const shown = useSyncExternalStore(subscribe, () => notice, () => null);
  const done = useCallback(() => showAppGrantNotice(null), []);
  if (!shown) return null;
  return (
    <UndoToast
      key={shown.text}
      text={shown.text}
      actionLabel={t("apps.usedByChange")}
      onUndo={async () => {
        changeRequested = shown.slug;
        dispatch({ type: "togglePlugins", open: true, surface: "apps" });
        tell();
      }}
      onDone={done}
    />
  );
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

/** Security: only an owner or admin's connection gives an app to bots, and only they can change which bots use it. A bot
 * whose apps are off stays off, unless the connection was started from that bot. */
export function useAppGrants({ status, emailConnected, inventoryReady }: { status: Record<string, ConnectorStatus>; emailConnected: boolean | null; inventoryReady: boolean }) {
  const { state, dispatch } = useStore();
  const admin = useOwnerOrAdmin();
  const [startingBot] = useState(takeConnectingBot);
  const [changing, setChanging] = useState<string | null>(null);
  const requested = useSyncExternalStore(subscribe, () => changeRequested, () => null);
  const bots = botsForApps(state.bots, state.instances);
  const canChange = admin === true && inventoryReady && bots.length > 0;
  const allowed = state.config?.managedPolicy?.apps;

  useEffect(() => {
    if (!requested) return;
    changeRequested = null;
    setChanging(requested);
    tell();
  }, [requested]);

  const write = (bot: Bot, slug: string, on: boolean) => {
    const patch = appSwitchPatch(bot, connectedAppSlugs(status, emailConnected), slug, on);
    if (Object.keys(patch).length > 0) dispatch({ type: "updateBot", botId: bot.id, patch });
  };
  const latest = useRef({ admin, bots, allowed, startingBot, write });
  latest.current = { admin, bots, allowed, startingBot, write };

  const appConnected = useCallback((slug: string, app: string) => {
    const now = latest.current;
    if (now.admin !== true || !now.bots.length) return;
    if (now.allowed && !now.allowed.allowAll && !now.allowed.allowlist.includes(slug)) return;
    let using = 0;
    for (const bot of now.bots) {
      if (botAppScope(bot, slug) !== null) using += 1;
      else if (bot.composio !== false || bot.id === now.startingBot) {
        now.write(bot, slug, true);
        using += 1;
      }
    }
    showAppGrantNotice({ slug, text: t(using ? "apps.botsCanUse" : "apps.noBotsUse", { app }) });
  }, []);
  const dismiss = useCallback(() => setChanging(null), []);

  const done = (on: ReadonlySet<string>) => {
    if (changing) {
      for (const bot of bots) if (on.has(bot.id) !== (botAppScope(bot, changing) !== null)) write(bot, changing, on.has(bot.id));
    }
    setChanging(null);
  };

  return { canChange, appConnected, change: setChanging, dismiss, done, changing: canChange ? changing : null, bots };
}

export function AppGrantPrompt({ app, slug, bots, onDone, onDismiss }: {
  app: string;
  slug: string;
  bots: Bot[];
  onDone: (on: ReadonlySet<string>) => void;
  onDismiss: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set(
    bots.filter((bot) => botAppScope(bot, slug) !== null).map((bot) => bot.id),
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
