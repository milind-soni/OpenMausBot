import { useEffect, useRef, useState } from "react";
import { Grid2x2Plus } from "lucide-react";
import { cn } from "@/lib/cn";

import type { LocalApp } from "../../../shared/local-apps";
import { t } from "@/lib/i18n";
import { changeLocalApp, hideLocalApp, loadLocalApps, openLocalApp, removeLocalApp, useLocalApps } from "@/lib/local-apps";
import { addLocalAppToDesktop, installLocalApp, removeLocalAppFromDesktop, uninstallLocalApp, useAppInstall } from "@/lib/local-app-install";
import type { Action, AppState } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { desktopFailedText, LocalAppCard, type InstallActions } from "./LocalAppCard";

export const REMOVE_UNDO_MS = 6_000;
export const SECTION_TITLE = "text-[17px] font-semibold text-ink";
export const APP_GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-4";

/** The page's empty state: an icon tile, a title and one line. `big` when nothing at all is on the page yet. */
export function AppsEmpty({ title, hint, big = false, data }: { title: string; hint: string; big?: boolean; data: string }) {
  return (
    <div {...{ [`data-${data}`]: "" }} className={cn("px-6 text-center", big ? "py-16" : "py-10")}>
      <div aria-hidden="true" className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Grid2x2Plus size={22} /></div>
      <h3 className="text-[17px] font-semibold text-ink">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-balance text-[14px] leading-relaxed text-ink-secondary">{hint}</p>
    </div>
  );
}

/** The chat a saved app came from, while its bot still has it; else the bot's own chat; null once the bot is gone. */
export function chatOfApp(app: LocalApp, state: Pick<AppState, "bots">): Action | null {
  const bot = state.bots.find((candidate) => candidate.id === app.botId);
  if (!bot) return null;
  const holds = bot.threadId === app.threadId || (bot.tasks ?? []).some((task) => task.threadId === app.threadId);
  return app.chat && holds ? { type: "switchTask", botId: bot.id, threadId: app.threadId } : { type: "select", id: bot.id };
}

export function openAppWindow(id: string): (() => void) | undefined {
  const bridge = window.ogb?.localApps;
  return bridge ? () => void bridge.openWindow(id).catch(() => undefined) : undefined;
}

type Line = { kind: "removed"; app: LocalApp; undo(): void } | { kind: "failed"; text: string };

/** "On this computer" (or "In this Cloud"): the apps saved here, as tiles, each opening in its own view. */
/** `alone`: the published list is empty too, so an empty section speaks for the whole page. */
export function LocalAppsSection({ place, alone = false }: { place: "computer" | "cloud"; alone?: boolean }) {
  const bots = useStoreSelector((state) => state.bots);
  const dispatch = useStoreDispatch();
  const { apps, status } = useLocalApps();
  const [line, setLine] = useState<Line | null>(null);
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => { void loadLocalApps(); }, []);
  useEffect(() => {
    const timers = pending.current;
    return () => {
      // Leaving the page settles every removal still waiting for its Undo.
      for (const [id, timer] of timers) { clearTimeout(timer); void removeLocalApp(id).catch(() => undefined); }
      timers.clear();
    };
  }, []);

  const remove = (app: LocalApp) => {
    const hidden = hideLocalApp(app.id);
    const timer = setTimeout(() => {
      pending.current.delete(app.id);
      setLine((now) => (now?.kind === "removed" && now.app.id === app.id ? null : now));
      void removeLocalApp(app.id).catch(() => {
        hidden.restore();
        setLine({ kind: "failed", text: t("localApps.removeFailed", { name: app.name }) });
      });
    }, REMOVE_UNDO_MS);
    pending.current.set(app.id, timer);
    setLine({ kind: "removed", app, undo: () => {
      clearTimeout(timer);
      pending.current.delete(app.id);
      hidden.restore();
      setLine(null);
    } });
  };
  const rename = (app: LocalApp, name: string) => {
    void changeLocalApp(app.id, { name }).catch(() => setLine({ kind: "failed", text: t("localApps.renameFailed") }));
  };
  const install = useAppInstall();
  const installOf = (app: LocalApp): InstallActions | undefined => {
    if (!install?.available) return undefined;
    const installed = install.ids.has(app.id);
    const onDesktop = Boolean(install.desktop?.has(app.id));
    return {
      installed,
      run: () => void (installed ? uninstallLocalApp(app.id) : installLocalApp(app)).catch(() =>
        setLine({ kind: "failed", text: t(installed ? "localApps.install.uninstallFailed" : "localApps.install.failed", { name: app.name }) })),
      ...(install.canDesktop ? { desktop: { on: onDesktop, run: () => void (onDesktop ? removeLocalAppFromDesktop(app.id) : addLocalAppToDesktop(app))
        .catch((error: unknown) => setLine({ kind: "failed", text: desktopFailedText(error, onDesktop, app.name) })) } } : {}),
    };
  };
  const goToChat = (app: LocalApp) => {
    const action = chatOfApp(app, { bots });
    return action ? () => dispatch(action) : undefined;
  };

  const title = t(place === "cloud" ? "localApps.section.cloud" : "localApps.section.computer");
  return (
    <section aria-labelledby="local-apps-title" data-local-apps={apps ? apps.length : status}>
      <h2 id="local-apps-title" className={cn(SECTION_TITLE, alone && apps?.length === 0 && "sr-only")}>{title}</h2>
      <div role="status" aria-live="polite" className="empty:hidden mt-3">
        {line?.kind === "removed" && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-inset px-3 py-2 text-[13px] text-ink-secondary">
            <span dir="auto" className="min-w-0 truncate">{t("localApps.removed", { name: line.app.name })}</span>
            <button type="button" onClick={line.undo} className="ms-auto font-medium text-accent-text hover:underline">{t("common.undo")}</button>
          </p>
        )}
        {line?.kind === "failed" && <p role="alert" className="rounded-lg bg-inset px-3 py-2 text-[13px] text-danger">{line.text}</p>}
      </div>
      {status === "failed" && !apps ? (
        <p role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-ink-secondary">
          {t("localApps.loadFailed")}
          <button type="button" className="ui-button ui-button-md" onClick={() => void loadLocalApps()}>{t("common.tryAgain")}</button>
        </p>
      ) : apps && apps.length === 0 ? (
        alone
          ? <AppsEmpty data="apps-empty" title={t("localApps.emptyAll.title")} hint={t("localApps.emptyAll.body")} big />
          : <AppsEmpty data="local-apps-empty" title={t("localApps.emptyTitle")} hint={t("localApps.empty")} />
      ) : apps ? (
        <ul aria-label={title} className={`mt-3 ${APP_GRID}`}>
          {apps.map((app) => (
            <LocalAppCard key={app.id} app={app} bot={bots.find((bot) => bot.id === app.botId)}
              onOpen={() => openLocalApp(app.id)} onOpenWindow={openAppWindow(app.id)} onRename={(name) => rename(app, name)}
              onGoToChat={goToChat(app)} onRemove={() => remove(app)} install={installOf(app)} />
          ))}
        </ul>
      ) : <div aria-hidden="true" className="mt-3 h-24" />}
    </section>
  );
}
