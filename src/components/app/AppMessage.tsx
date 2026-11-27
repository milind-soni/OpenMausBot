import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useStore, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { AppDocument, AppPayload } from "../../../shared/app";
import { appBlockedLine } from "./app-blocked";
import { APP_FRAME_LIMITS } from "../../../shared/app-frame/bridge";
import { AppDocumentError, fetchAppDocument, type AppFetchFailure } from "./app-api";
import { APP_POOL_LIMITS, useAppPoolSlot, type AppPool } from "./app-pool";
import { AppDone, AppHeader, AppInfo, AppOpenButton, AppPlaceholder, AppStrip, APP_SURFACE, PageCardFooter } from "./AppChrome";
import { AppFrame, type AppFrameHandle, type AppFrameProblem } from "./AppFrame";
import type { AppSelection } from "./app-frame-host";
import { PageCitationButton } from "../CitationUI";
import { appendComposerDraft, appendDraftAttachments } from "@/lib/drafts";
import { returnFocusToComposer } from "../AskCard";
import { useCanWriteIn } from "@/lib/cloud-guest";
import { closePage, onPageOpened, openPage, openPageFor } from "@/lib/open-page";
import { useSaveAsApp } from "./SaveAsApp";
import { PAGE_HEIGHT, PAGE_PREVIEW_HEIGHT, PageFullScreen, PageNotes, PagePaneContext, PageToolbar, usePagePin, usePagePoint, usePageSave, usePageShare, usePageVersion } from "./PageTools";

const WIDTH = "max-w-[760px]";
const CARD_WIDTH = "max-w-[560px]";
const CARD_TITLE = "truncate px-5 pt-5 text-[17px] font-semibold leading-6 text-ink";
const CARD_TITLE_HEIGHT = 44;
const DOC_REUSE_MS = 60_000;

const heights = new Map<string, number>();
/** Whether a page opens with a heading of its own, as it last said: by message id and version. */
const headings = new Map<string, boolean>();
/** How long a card waits for its page to say, before it shows the preview with the title above it for good. */
const HEADING_WAIT_MS = 1_500;
/** The same once the page has said it is still drawing itself. */
const HEADING_DRAWING_MS = 10_000;
const docs = new Map<string, { doc: AppDocument; at: number }>();

function rememberHeading(key: string, opens: boolean) {
  headings.delete(key);
  headings.set(key, opens);
  while (headings.size > 200) headings.delete(headings.keys().next().value!);
}

export function forgetAppRows(): void {
  heights.clear();
  headings.clear();
  docs.clear();
}

function rememberDoc(key: string, doc: AppDocument) {
  docs.set(key, { doc, at: Date.now() });
  while (docs.size > 8) docs.delete(docs.keys().next().value!);
}

function isAppPayload(value: unknown): value is AppPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<AppPayload>;
  return typeof payload.title === "string" && (payload.source === "html" || payload.source === "mcp") && typeof payload.doc === "string";
}

function useAutoMount(botId: string, threadId: string | undefined, messageId: string): boolean {
  const { state } = useStore();
  const bot = state?.bots?.find((candidate) => candidate.id === botId);
  const messages = bot && (!threadId || bot.threadId === threadId) ? bot.messages : undefined;
  const newest = useMemo(() => {
    if (!messages) return null;
    const ids = messages.filter((message) => message.kind === "app").map((message) => message.id);
    return new Set(ids.slice(-APP_POOL_LIMITS.autoMountNewest));
  }, [messages]);
  // a row the store does not hold (a test page, a row just arrived) is new
  return !newest || newest.has(messageId) || !messages?.some((message) => message.id === messageId);
}

export function AppMessage({ botId, botName, threadId, message, pool, room }: {
  botId: string;
  botName: string;
  threadId?: string;
  message: Message;
  pool?: AppPool;
  /** Shown in a room: view-only. */
  room?: boolean;
}) {
  const payload = message.app;
  if (!isAppPayload(payload) || !threadId) {
    return message.text
      ? <div className="chat-text w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">{message.text}</div>
      : null;
  }
  return <AppRow botId={botId} botName={botName} threadId={threadId} message={message} payload={payload} pool={pool} room={room} />;
}

type Loaded =
  | { key: string; doc: AppDocument; failure?: undefined }
  | { key: string; doc?: undefined; failure: AppFetchFailure };

function AppRow({ botId, botName, threadId, message, payload, pool, room }: {
  botId: string;
  botName: string;
  threadId: string;
  message: Message;
  payload: AppPayload;
  pool?: AppPool;
  room?: boolean;
}) {
  const { dispatch, state: store } = useStore();
  const uid = useId();
  const page = payload.source === "html";
  const version = usePageVersion(payload);
  const rev = page ? version.rev : payload.rev ?? 0;
  const bordered = payload.border !== false;
  const docKey = payload.doc ? `${message.id}:${payload.doc}:${rev}` : "";
  const [height, setHeight] = useState(() => heights.get(`${message.id}:${rev}`) ?? heights.get(`${message.id}:${rev - 1}`) ?? payload.height
    ?? (page ? PAGE_HEIGHT.start : APP_FRAME_LIMITS.defaultHeight));
  const [infoOpen, setInfoOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fetching, setFetching] = useState(false);
  const [problem, setProblem] = useState<AppFrameProblem | null>(null);
  // Text the person selected in the page, to cite in the composer as chat text is; never in a room.
  const [selection, setSelection] = useState<AppSelection | null>(null);
  const [heading, setHeading] = useState<{ key: string; opens: boolean | null } | null>(null);
  const yourAccess = store?.bots?.find((candidate) => candidate.id === botId)?.yourAccess;
  const canWrite = useCanWriteIn(threadId, yourAccess) !== false;
  const frame = useRef<AppFrameHandle | null>(null);
  const wide = useRef<AppFrameHandle | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  // A page is a compact card where it has somewhere to open: the chat's page pane, or over the window in a room.
  const paneSlot = useContext(PagePaneContext);
  const pane = page && !room ? paneSlot : null;
  const compact = Boolean(pane) || (page && Boolean(room));
  const paneOpen = Boolean(pane && fullScreen);
  const row = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const auto = useAutoMount(botId, threadId, message.id) && !collapsed && Boolean(docKey);
  const evict = useCallback(async () => {
    await frame.current?.teardown();
    frame.current = null;
  }, []);
  const slot = useAppPoolSlot({ key: `${threadId}:${message.id}`, target: row, auto, evict, held: paneOpen, ...(pool ? { pool } : {}) });

  const wanted = slot.live && docKey ? `${docKey}:${reload}` : "";
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    setFetching(true);
    const reuse = reload === 0 ? docs.get(docKey) : undefined;
    const fetched = reuse && Date.now() - reuse.at < DOC_REUSE_MS
      ? Promise.resolve(reuse.doc)
      : fetchAppDocument(threadId, message.id, controller.signal, page && !version.latest ? rev : undefined).then((doc) => { rememberDoc(docKey, doc); return doc; });
    void fetched.then(
      async (doc) => {
        if (frame.current) await evict();
        if (!controller.signal.aborted && mounted.current) {
          setProblem(null);
          setFetching(false);
          setLoaded({ key: wanted, doc });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted || !mounted.current) return;
        setFetching(false);
        setLoaded({ key: wanted, failure: error instanceof AppDocumentError ? error.failure : { offline: true } });
      },
    );
    return () => {
      controller.abort();
      setFetching(false);
    };
  }, [wanted, docKey, reload, threadId, message.id, evict, page, version.latest, rev]);

  useEffect(() => {
    if (!slot.live) setLoaded(null);
  }, [slot.live]);

  const onHeight = useCallback((next: number) => {
    heights.set(`${message.id}:${rev}`, next);
    if (mounted.current) setHeight(next);
  }, [message.id, rev]);
  const arrived = Boolean(wanted) && loaded?.key === wanted;
  const onHeading = useCallback((next: boolean | null) => {
    if (!arrived) return;
    const key = `${message.id}:${rev}`;
    if (next !== null) rememberHeading(key, next);
    // Once the card has an answer, or stopped waiting for one, "still drawing" cannot take the preview away again.
    else if (headings.has(key)) return;
    if (mounted.current) setHeading((was) => (next === null && was?.key === key && was.opens !== null ? was : { key, opens: next }));
  }, [arrived, message.id, rev]);

  const current = slot.live ? loaded?.doc : undefined;
  const point = usePagePoint({
    frame: () => (fullScreen ? wide.current : frame.current)?.iframe, view: fullScreen ? "full" : "inline", frameKey: loaded?.key,
    // In the pane the message box stays usable, so the page stays open while the person writes about what they picked.
    threadId, appId: message.id, rev, title: payload.title, picked: () => { if (!pane) setFullScreen(false); },
  });
  useEffect(() => {
    if (!paneOpen) return;
    openPage(threadId, { appId: message.id, rev });
    const off = onPageOpened(() => { if (openPageFor(threadId)?.appId !== message.id) setFullScreen(false); });
    return () => { off(); closePage(threadId, message.id); };
  }, [paneOpen, threadId, message.id, rev]);
  const draft = (text: string) => {
    appendComposerDraft(`bot:${botId}:${threadId}`, text);
    if (!pane) { point.stop(); setFullScreen(false); }
    returnFocusToComposer();
  };
  const onDraft = page && !room ? { onDraft: draft } : {};
  const share = usePageShare(threadId, message.id, message.publishedPage);
  const save = usePageSave(threadId, message.id, payload.title);
  const pin = usePagePin({ botId, threadId, messageId: message.id }, payload.title);
  const saveApp = useSaveAsApp({ botId, threadId, messageId: message.id }, room || !page || !payload.doc);
  const tools = { version, point, share, save, room, pin, saveApp, ready: Boolean(current), fullScreen: { open: fullScreen, pane: Boolean(pane), toggle: () => { point.stop(); setFullScreen((open) => !open); } } };

  const reloadNow = () => {
    setProblem(null);
    setCollapsed(false);
    setReload((count) => count + 1);
    if (!slot.live) slot.open();
  };

  const { close } = slot;
  const onTeardownRequested = useCallback(() => {
    void evict().then(() => {
      if (!mounted.current) return;
      setCollapsed(true);
      close();
    });
  }, [evict, close]);

  const origin = payload.source === "mcp"
    ? t("app.origin.mcp", { server: payload.mcp?.serverTitle || payload.mcp?.server || payload.title })
    : t("app.origin.page", { bot: botName });
  const serverName = payload.mcp?.serverTitle || payload.mcp?.server;
  const signIn = () => dispatch({ type: "togglePlugins", open: true, surface: "mcp" });

  const strip = (() => {
    if (problem?.kind === "sign-in") return { text: t("app.strip.signIn", { server: serverName || problem.server }), action: { label: t("app.strip.signInAction"), onClick: signIn } };
    if (problem?.kind === "offline") return { text: t("app.strip.offline"), action: { label: t("app.strip.retry"), onClick: reloadNow } };
    if (problem?.kind === "blocked") return { text: appBlockedLine(problem.reason, serverName, problem.text) };
    if (loaded?.failure) {
      return loaded.failure.offline
        ? { text: t("app.strip.offline"), action: { label: t("app.strip.retry"), onClick: reloadNow } }
        : { text: loaded.failure.error };
    }
    const blocked = current?.blocked;
    if (blocked) {
      const text = appBlockedLine(blocked.reason, serverName, blocked.text);
      return blocked.reason === "signed-out" ? { text, action: { label: t("app.strip.signInAction"), onClick: signIn } } : { text };
    }
    if (payload.blocked) return { text: appBlockedLine(payload.blocked, serverName) };
    return null;
  })();

  const noPage = !docKey || Boolean(loaded?.failure && !loaded.failure.offline);
  const state = collapsed ? "collapsed" : current ? "live" : noPage ? "unavailable" : slot.live ? "loading" : "idle";
  const infoId = `${uid}-info`;

  // The page says, once it has rendered, whether it opens with a heading of its own; a card whose page does not gets
  // the title above the preview. Until the page has spoken the preview stays covered, so nothing moves under the eye.
  const said = heading?.key === `${message.id}:${rev}` ? heading.opens : undefined;
  const opens = said ?? headings.get(`${message.id}:${rev}`);
  const undecided = compact && Boolean(current) && opens === undefined;
  const timing = undecided && arrived;
  const drawing = said === null;
  const frameKey = loaded?.key;
  useEffect(() => {
    if (!timing) return;
    const key = `${message.id}:${rev}`;
    const timer = setTimeout(() => {
      rememberHeading(key, false);
      setHeading({ key, opens: false });
    }, drawing ? HEADING_DRAWING_MS : HEADING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [timing, drawing, frameKey, message.id, rev]);
  // The title stays while the frame is away (the pool took its slot), so the card keeps its height.
  const titled = compact && opens === false;
  // The compact card clips the page at its natural size, so it reads as a preview of the real thing.
  const previewHeight = height + (titled ? CARD_TITLE_HEIGHT : 0);
  const boxHeight = compact ? Math.min(previewHeight, PAGE_PREVIEW_HEIGHT) : height;
  const body = collapsed ? null : fullScreen && current ? (
    <div data-app-box className={cn("relative w-full", bordered && !compact && "border-t border-ink/[0.08]")} style={{ height: boxHeight }}>
      {compact
        ? <AppPlaceholder height={boxHeight}><span className="ui-pill">{t("chat.preview.closePage")}</span></AppPlaceholder>
        : <AppPlaceholder height={boxHeight} open={() => setFullScreen(false)} label={t("chat.preview.exitFullScreen")} />}
    </div>
  ) : noPage ? (
    message.text ? <div dir="auto" className={cn("line-clamp-6 whitespace-pre-wrap text-[13px] leading-[18px] text-ink-secondary", compact ? "px-4 pt-3" : bordered ? "px-4 pb-3" : "pb-2")}>{message.text}</div> : null
  ) : (
    <div data-app-box className={cn("relative w-full", compact && "overflow-hidden", bordered && !compact && "border-t border-ink/[0.08]", point.pointing && "ring-2 ring-inset ring-accent/60")}
      // The whole card opens the page, so the keyboard must not reach what the preview shows underneath it.
      inert={(compact && Boolean(current) && !point.pointing) || undefined}
      style={{ height: boxHeight }}>
      {titled && <div data-page-title title={payload.title} className={CARD_TITLE}><bdi dir="auto">{payload.title}</bdi></div>}
      {current ? (
        <AppFrame
          key={loaded!.key}
          doc={current}
          botId={botId}
          threadId={threadId}
          title={payload.title}
          height={height}
          handle={frame}
          onHeight={onHeight}
          {...(compact ? { onHeading } : {})}
          onProblem={setProblem}
          onTeardownRequested={onTeardownRequested}
          {...(page ? { maxHeight: PAGE_HEIGHT.cap } : {})}
          {...(!room ? { onSelection: setSelection } : {})}
          {...onDraft}
        />
      ) : (
        <AppPlaceholder height={boxHeight - (titled ? CARD_TITLE_HEIGHT : 0)} loading={slot.live} open={slot.live ? undefined : reloadNow} />
      )}
      {undecided && (
        <div data-page-settling className="absolute inset-0 bg-composer">
          <AppPlaceholder height={boxHeight} loading />
        </div>
      )}
      {compact && current && !undecided && previewHeight > PAGE_PREVIEW_HEIGHT && (
        <div data-page-fade aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-composer to-transparent" />
      )}
    </div>
  );
  const info = infoOpen && <AppInfo id={infoId} network={payload.network ?? { connect: [], resources: [] }} bytes={payload.bytes ?? 0} bordered={bordered || compact} />;
  const reopen = collapsed && (
    <div className={cn("flex", bordered || compact ? "px-4 pb-3.5" : "pb-2", compact && "pt-3.5")}>
      <AppOpenButton label={t("app.openAgain")} onClick={reloadNow} />
    </div>
  );
  const kind = t("chat.preview.kind");

  return (
    <div
      ref={row}
      role="group"
      aria-label={t("app.aria.row", { title: payload.title })}
      data-app={message.id}
      data-app-state={state}
      data-app-source={payload.source}
      {...(page ? { "data-app-rev": rev } : {})}
      {...(room ? { "data-app-room": "" } : {})}
      className={cn("w-full text-start", compact ? CARD_WIDTH : WIDTH)}
    >
      {compact ? (
        <div className={APP_SURFACE}>
          <div className="group/page relative">
            {reopen}
            {body}
            <PageCardFooter
              title={payload.title}
              detail={version.last > 0 ? `${kind} · ${t("chat.preview.version", { n: version.rev + 1 })}` : kind}
              updated={version.flash}
              infoId={infoId}
              infoOpen={infoOpen}
              onInfo={() => setInfoOpen((open) => !open)}
              onReload={docKey ? reloadNow : undefined}
              reloading={fetching && Boolean(current)}
            />
            {current && !point.pointing && (
              <button type="button" data-page-open onClick={tools.fullScreen.toggle} aria-pressed={fullScreen}
                aria-label={t(fullScreen ? "chat.preview.closePage" : "chat.preview.openPage")}
                className="absolute inset-0 cursor-pointer rounded-2xl transition-colors duration-[120ms] hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-reduce:transition-none" />
            )}
          </div>
          {info}
          {payload.done && <AppDone done={payload.done} bordered />}
          {strip && <AppStrip text={strip.text} action={strip.action} bordered />}
        </div>
      ) : (
        <div className={cn(bordered ? APP_SURFACE : "w-full")}>
          <AppHeader
            title={payload.title}
            origin={origin}
            infoId={infoId}
            infoOpen={infoOpen}
            onInfo={() => setInfoOpen((open) => !open)}
            onReload={docKey ? reloadNow : undefined}
            reloading={fetching && Boolean(current)}
            bordered={bordered}
          />
          {page && <PageToolbar {...tools} className={bordered ? "px-4 pb-3" : "pb-2"} />}
          {page && <PageNotes version={version} point={point} share={share} save={save} room={room} className={bordered ? "px-4 pb-3" : "pb-2"} />}
          {info}
          {reopen}
          {body}
          {payload.done && <AppDone done={payload.done} bordered={bordered} />}
          {strip && <AppStrip text={strip.text} action={strip.action} bordered={bordered} />}
        </div>
      )}
      {!room && canWrite && (
        <PageCitationButton
          selection={selection && { text: selection.text, point: { left: selection.left, top: selection.bottom + 8 } }}
          source={{ ownerType: "bot", ownerId: botId, threadId, messageId: message.id }}
          onAdd={(citation) => appendDraftAttachments(`bot:${botId}:${threadId}`, [citation])}
          onDismiss={() => setSelection(null)}
        />
      )}
      {page && fullScreen && current && (
        <PageFullScreen {...tools} title={payload.title} doc={current} botId={botId} threadId={threadId} handle={wide} close={() => { point.stop(); setFullScreen(false); }} pane={pane}
          {...(!room ? { onSelection: setSelection } : {})} {...onDraft} />
      )}
    </div>
  );
}
