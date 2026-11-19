// A pinned web page shown in place of the chat, like Team map. The page is
// framed with a sandbox and no referrer; a page that refuses framing (or
// never loads) falls back to a button that opens it in the browser.
import { AppWindow, ExternalLink, Globe, MessageSquare, Pin, PinOff, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { SITE_FRAME_SANDBOX } from "@/lib/published-apps";
import { useShowThreads } from "@/lib/thread-preferences";
import { useWebPanels } from "@/lib/web-panel-preferences";
import { isAppOrigin, MAX_WEB_PANELS, type PinnedChatPage } from "@/lib/web-panels";
import { api } from "@/state/api";
import { openThread, useStore, type Bot } from "@/state/store";
import type { AppDocument } from "../../shared/app";
import { AppDocumentError, fetchAppDocument } from "./app/app-api";
import { AppFrame, type AppFrameHandle } from "./app/AppFrame";
import { AppPlaceholder } from "./app/AppChrome";
import { usePagePin } from "./app/PageTools";

const LOAD_TIMEOUT_MS = 10_000;

export function WebPanelPage() {
  const { state, dispatch } = useStore();
  const panels = useWebPanels();
  const opened = state.chatPage;
  const panel = opened ? undefined : panels.find((entry) => entry.id === state.webPanelId);
  const [reloads, setReloads] = useState(0);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const [refusedUrl, setRefusedUrl] = useState<string>();

  // A removed panel leaves nothing to show: go back to the conversation.
  useEffect(() => {
    if (!panel && !opened) dispatch({ type: "showChat" });
  }, [panel, opened, dispatch]);

  useEffect(() => {
    setStatus("loading");
    const timer = setTimeout(() => setStatus((current) => (current === "loading" ? "failed" : current)), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [panel?.url, reloads]);

  // The browser fires load on a frame it refused, so only the page's headers, read by the server, tell.
  useEffect(() => {
    const url = panel?.url;
    if (!url) return;
    const check = new AbortController();
    api<{ framing?: string }>(`/api/web-panels/framing?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(window.location.origin)}`, { background: true, signal: check.signal })
      .then(({ framing }) => setRefusedUrl(framing === "blocked" ? url : undefined), () => undefined);
    return () => check.abort();
  }, [panel?.url, reloads]);

  if (opened) return <ChatPageView key={`${opened.page.threadId}:${opened.page.messageId}`} name={opened.name} page={opened.page} />;
  if (!panel) return null;
  if (panel.page) return <ChatPageView key={panel.id} name={panel.name} page={panel.page} />;
  const refused = refusedUrl === panel.url;
  const openInBrowser = () => void openExternalLink(panel.url).catch(() => undefined);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-app" aria-label={panel.name}>
      <header className="flex items-center gap-2 border-b border-hairline/40 px-4 py-2.5">
        <Globe size={16} className="shrink-0 text-ink-secondary" />
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink" title={panel.url}>{panel.name}</h1>
        <button
          type="button"
          className="ui-icon-button shrink-0"
          aria-label={t("webPanels.page.reload")}
          title={t("webPanels.page.reload")}
          onClick={() => setReloads((n) => n + 1)}
        >
          <RotateCw size={16} />
        </button>
        <button type="button" className="ui-button" onClick={openInBrowser}>
          <ExternalLink size={14} />
          {t("webPanels.page.openInBrowser")}
        </button>
      </header>
      {refused || status === "failed" || isAppOrigin(panel.url, window.location.origin) ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[14px] font-medium text-ink">{t("webPanels.page.cantEmbed")}</p>
          <p className="max-w-sm text-[13px] text-ink-secondary">{refused ? t("webPanels.page.refusedBody", { site: new URL(panel.url).host }) : t("webPanels.page.cantEmbedBody")}</p>
          <button type="button" className="ui-button ui-button-primary" onClick={openInBrowser}>
            {t("webPanels.page.openInBrowser")}
          </button>
        </div>
      ) : (
        <iframe
          key={`${panel.id}:${reloads}`}
          src={panel.url}
          title={panel.name}
          sandbox={SITE_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("failed")}
          className="min-h-0 w-full flex-1 border-0 bg-app"
        />
      )}
    </main>
  );
}

type PageLoad = { doc: AppDocument } | { failure: string };

/** The page's current version when its chat is loaded in the app ("" when it isn't): a bot replacing the page, or a
 * live folder it watches changing, updates this, and the pinned view fetches the new page, as the chat does. */
function storedPageVersion(bots: readonly Bot[] | undefined, page: PinnedChatPage): string {
  const bot = bots?.find((candidate) => candidate.id === page.botId);
  if (!bot || bot.threadId !== page.threadId) return "";
  const app = bot.messages.find((message) => message.id === page.messageId)?.app;
  return app ? `${app.doc}:${app.rev ?? 0}` : "";
}

function ChatPageView({ name, page }: { name: string; page: PinnedChatPage }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const pin = usePagePin(page, name);
  // Only a new stored version means the page changed: while its chat is not loaded (switching threads) it stays put.
  const stored = storedPageVersion(state.bots, page);
  const [version, setVersion] = useState(stored);
  if (stored && stored !== version) setVersion(stored);
  const [reloads, setReloads] = useState(0);
  const [load, setLoad] = useState<PageLoad | null>(null);
  const handle = useRef<AppFrameHandle | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad(null);
    fetchAppDocument(page.threadId, page.messageId, controller.signal).then(
      (doc) => { if (!controller.signal.aborted) setLoad({ doc }); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ failure: error instanceof AppDocumentError && !error.failure.offline ? error.failure.error : t("app.strip.offline") });
      },
    );
    return () => controller.abort();
  }, [page.threadId, page.messageId, reloads, version]);

  const openInChat = () => {
    openThread(dispatch, page, state, showThreads);
    dispatch({ type: "focusMessage", threadId: page.threadId, messageId: page.messageId });
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-app" aria-label={name} data-pinned-page={page.messageId}>
      <header className="flex items-center gap-2 border-b border-hairline/40 px-4 py-2.5">
        <AppWindow size={16} className="shrink-0 text-ink-secondary" />
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{name}</h1>
        <button
          type="button"
          className="ui-icon-button shrink-0"
          aria-label={t("webPanels.page.reload")}
          title={t("webPanels.page.reload")}
          onClick={() => setReloads((n) => n + 1)}
        >
          <RotateCw size={16} />
        </button>
        <button type="button" className="ui-button" onClick={openInChat}>
          <MessageSquare size={14} />
          {t("webPanels.page.openInChat")}
        </button>
        {(pin.show || pin.pinned) && (
          <button type="button" className="ui-button" data-page-pin aria-pressed={pin.pinned} onClick={pin.toggle} disabled={pin.full}
            title={pin.full ? t("chat.preview.pinFull", { max: MAX_WEB_PANELS }) : t(pin.pinned ? "chat.preview.unpinHint" : "chat.preview.pinHint")}>
            {pin.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {t(pin.pinned ? "chat.preview.unpin" : "chat.preview.pin")}
          </button>
        )}
      </header>
      {load && "doc" in load ? (
        <div className="relative min-h-0 flex-1">
          <AppFrame
            doc={load.doc}
            botId={page.botId}
            threadId={page.threadId}
            title={name}
            height={600}
            handle={handle}
            onHeight={() => {}}
            onProblem={() => {}}
            onTeardownRequested={() => dispatch({ type: "showChat" })}
            fill
          />
        </div>
      ) : load ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[14px] font-medium text-ink">{t("webPanels.page.pageGone")}</p>
          <p className="max-w-sm text-[13px] text-ink-secondary">{load.failure}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <AppPlaceholder height={120} loading />
        </div>
      )}
    </main>
  );
}
