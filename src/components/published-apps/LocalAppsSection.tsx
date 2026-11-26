import { useEffect, useRef, useState } from "react";

import type { LocalApp } from "../../../shared/local-apps";
import { t } from "@/lib/i18n";
import { changeLocalApp, hideLocalApp, loadLocalApps, openLocalApp, removeLocalApp, useLocalApps } from "@/lib/local-apps";
import type { Action, AppState } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { LocalAppCard } from "./LocalAppCard";

export const REMOVE_UNDO_MS = 6_000;
export const SECTION_TITLE = "text-[17px] font-semibold text-ink";
export const APP_GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3";

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
export function LocalAppsSection({ place }: { place: "computer" | "cloud" }) {
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
  const goToChat = (app: LocalApp) => {
    const action = chatOfApp(app, { bots });
    return action ? () => dispatch(action) : undefined;
  };

  const title = t(place === "cloud" ? "localApps.section.cloud" : "localApps.section.computer");
  return (
    <section aria-labelledby="local-apps-title" data-local-apps={apps ? apps.length : status}>
      <h2 id="local-apps-title" className={SECTION_TITLE}>{title}</h2>
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
        <p data-local-apps-empty="" className="mt-3 rounded-xl border border-dashed border-hairline px-4 py-6 text-center text-[13px] text-ink-secondary">
          {t("localApps.empty")}
        </p>
      ) : apps ? (
        <ul aria-label={title} className={`mt-3 ${APP_GRID}`}>
          {apps.map((app) => (
            <LocalAppCard key={app.id} app={app} bot={bots.find((bot) => bot.id === app.botId)}
              onOpen={() => openLocalApp(app.id)} onOpenWindow={openAppWindow(app.id)} onRename={(name) => rename(app, name)}
              onGoToChat={goToChat(app)} onRemove={() => remove(app)} />
          ))}
        </ul>
      ) : <div aria-hidden="true" className="mt-3 h-24" />}
    </section>
  );
}
