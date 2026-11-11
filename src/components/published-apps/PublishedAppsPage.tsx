import { useCallback, useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";

import type { PublishedApp, PublishedAppDeleteRefusal, PublishedAppsList } from "../../../shared/published-apps";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { showAppBesideChat } from "@/lib/page-open";
import { rememberPublishedApps } from "@/lib/published-apps";
import { api, ApiError } from "@/state/api";
import { useStore, type AppState } from "@/state/store";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageHeader } from "../ToolPageShell";
import { PublishedAppCard, type DeleteProblem } from "./PublishedAppCard";

const DELETE_PROBLEMS: Record<PublishedAppDeleteRefusal, LocaleKey> = {
  gone: "publishedApps.delete.failed", failed: "publishedApps.delete.failed", forbidden: "publishedApps.delete.forbidden",
  no_token: "publishedApps.delete.noToken", token_refused: "publishedApps.delete.tokenRefused",
};

/** Where the bot's chat about this app opens: the conversation it was published in when the bot still has it, else
 * the bot's chat, else the room that conversation belongs to. Null when the bot and the room are gone. */
export function chatFor(app: PublishedApp, state: Pick<AppState, "bots" | "groups">): { type: "switchTask"; botId: string; threadId: string } | { type: "select"; id: string } | null {
  const bot = state.bots.find((candidate) => candidate.id === app.bot.id);
  const holds = (owner: { threadId: string; tasks?: ReadonlyArray<{ threadId: string }> }) => owner.threadId === app.threadId || (owner.tasks ?? []).some((task) => task.threadId === app.threadId);
  if (bot && app.threadId && holds(bot)) return { type: "switchTask", botId: bot.id, threadId: app.threadId };
  const room = app.threadId ? state.groups.find(holds) : undefined;
  return room ? { type: "select", id: room.id } : bot ? { type: "select", id: bot.id } : null;
}

/** Everything the person's bots put online, as cards. */
export function PublishedAppsPage() {
  const { state, dispatch } = useStore();
  const [apps, setApps] = useState<PublishedApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const loading = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    try {
      const list = await api<PublishedAppsList>("/api/published-apps", { signal: controller.signal });
      if (controller.signal.aborted) return;
      rememberPublishedApps(list.apps);
      setApps(list.apps);
      setFailed(false);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); return () => loading.current?.abort(); }, [load]);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);

  const open = (url: string) => void openExternalLink(url).catch(() => undefined);
  const openChat = (app: PublishedApp): boolean => {
    const action = chatFor(app, state);
    if (action) dispatch(action);
    return action !== null;
  };
  const preview = (app: PublishedApp) => {
    if (!openChat(app)) dispatch({ type: "showChat" });
    showAppBesideChat(dispatch, { url: app.url, title: app.title, ...(app.access === "netlify-team" ? { loginOnly: true } : {}) });
  };
  const remove = async (app: PublishedApp): Promise<DeleteProblem | null> => {
    try {
      await api("/api/published-apps/delete", { method: "POST", body: JSON.stringify({ id: app.id }) });
    } catch (error) {
      const body = error instanceof ApiError ? error.body : undefined;
      const code = typeof body?.code === "string" && Object.hasOwn(DELETE_PROBLEMS, body.code) ? body.code as PublishedAppDeleteRefusal : "failed";
      if (code !== "gone") return { text: t(DELETE_PROBLEMS[code]), ...(typeof body?.manageUrl === "string" && body.manageUrl === app.manageUrl ? { manageUrl: app.manageUrl } : {}) };
    }
    setApps((current) => current?.filter((one) => one.id !== app.id) ?? current);
    void load();
    return null;
  };

  return (
    <ToolPage label={t("publishedApps.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("publishedApps.title")}</h1>
      </ToolPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-published-apps={apps ? apps.length : "loading"}>
        <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
          {failed && !apps ? (
            <section role="alert" className="px-6 py-16 text-center">
              <p className="text-[14px] text-ink-secondary">{t("publishedApps.loadFailed")}</p>
              <button type="button" className="ui-button mt-4" onClick={() => void load()}>{t("common.tryAgain")}</button>
            </section>
          ) : apps && apps.length === 0 ? (
            <section aria-label={t("publishedApps.empty.title")} className="px-6 py-16 text-center">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Globe size={22} /></div>
              <h2 className="text-[17px] font-semibold text-ink">{t("publishedApps.empty.title")}</h2>
              <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-ink-secondary">{t("publishedApps.empty.body")}</p>
            </section>
          ) : apps ? (
            <ul aria-label={t("publishedApps.title")} className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
              {apps.map((app) => (
                <PublishedAppCard key={app.id} app={app} onOpen={open} onPreview={() => preview(app)}
                  onAsk={app.bot.name && chatFor(app, state) ? () => void openChat(app) : undefined} onDelete={() => remove(app)} />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </ToolPage>
  );
}
