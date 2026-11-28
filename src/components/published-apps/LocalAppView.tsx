import { useEffect, useRef, useState } from "react";
import { AppWindowMac, Check, ChevronDown, Loader2, MessageSquare, MoreHorizontal } from "lucide-react";

import type { AppDocument } from "../../../shared/app";
import type { LocalApp } from "../../../shared/local-apps";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { changeLocalApp, fetchLocalAppDocument, loadLocalApps, useLocalApps } from "@/lib/local-apps";
import type { Bot } from "@/state/store";
import { AppFrame, type AppFrameHandle, type AppFrameProblem } from "../app/AppFrame";
import { desktopFailedText, InstalledMark, installItems, LocalAppMark, type InstallActions } from "./LocalAppCard";
import { addLocalAppToDesktop, installLocalApp, readInstalled, removeLocalAppFromDesktop, uninstallLocalApp, useAppInstall } from "@/lib/local-app-install";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../SidebarPopoverMenu";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "../ToolPageShell";

/** How often an open app looks for a version the bot made meanwhile. */
const FOLLOW_MS = 15_000;
const HEADER_BUTTON = "ui-button ui-button-md";

function VersionMenu({ app }: { app: LocalApp }) {
  const newest = app.versions.at(-1)?.rev ?? app.rev;
  const label = t("localApps.view.version", { n: app.rev + 1 });
  if (app.versions.length < 2) return <span data-local-app-version className="text-[13px] text-ink-tertiary tabular-nums">{label}</span>;
  const pin = (rev: number | null) => void changeLocalApp(app.id, { pinnedRev: rev }).catch(() => undefined);
  const mark = (on: boolean) => (on ? <Check size={14} aria-hidden="true" className="text-accent-text" /> : undefined);
  const items: SidebarMenuItem[] = [
    { key: "newest", label: t("localApps.view.newest"), subtitle: t("localApps.view.newestDetail"), checked: app.pinnedRev === undefined,
      trailing: mark(app.pinnedRev === undefined), onSelect: () => pin(null) },
    ...[...app.versions].reverse().map((version, index) => ({
      key: `v${version.rev}`, label: t("localApps.view.version", { n: version.rev + 1 }), checked: app.pinnedRev === version.rev, trailing: mark(app.pinnedRev === version.rev),
      separatorBefore: index === 0, onSelect: () => pin(version.rev === newest && app.pinnedRev === undefined ? null : version.rev),
    })),
  ];
  return (
    <SidebarPopoverMenu items={items} ariaLabel={t("localApps.view.versions")} placement="below" align="end" triggerTitle={t("localApps.view.versions")}
      triggerClassName="ui-pill tabular-nums" renderTrigger={() => (
        <span data-local-app-version className="flex items-center gap-1">
          {app.pinnedRev !== undefined ? t("localApps.view.kept", { n: app.rev + 1 }) : label}<ChevronDown size={12} aria-hidden="true" />
        </span>
      )} />
  );
}

type Loaded = { key: string; doc: AppDocument } | { key: string; failed: true };

/** One saved app filling the content area: the same frame, policy and bridge as the page in its chat, under a slim header. */
export function LocalAppView({ id, botOf, onBack, onGoToChat, onOpenWindow }: {
  id: string;
  botOf?: (botId: string) => Bot | undefined;
  /** Absent in the app's own window, which has nothing to go back to. */
  onBack?: () => void;
  onGoToChat?: (app: LocalApp) => (() => void) | undefined;
  onOpenWindow?: () => void;
}) {
  const { apps, status } = useLocalApps();
  const app = apps?.find((one) => one.id === id);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<AppFrameProblem | null>(null);
  const handle = useRef<AppFrameHandle | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const install = useAppInstall();
  const [installFailed, setInstallFailed] = useState<string | null>(null);
  useEffect(() => { if (!install) void readInstalled(); }, [install]);

  useEffect(() => { if (!apps) void loadLocalApps(); }, [apps]);
  useEffect(() => {
    const look = () => { if (document.visibilityState !== "hidden") void loadLocalApps(); };
    const timer = setInterval(look, FOLLOW_MS);
    window.addEventListener("focus", look);
    return () => { clearInterval(timer); window.removeEventListener("focus", look); };
  }, []);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);

  const appId = app?.id, rev = app?.rev;
  const key = appId === undefined ? "" : `${appId}:${rev}:${reload}`;
  useEffect(() => {
    if (!key || appId === undefined) return;
    const controller = new AbortController();
    void fetchLocalAppDocument(appId, rev, controller.signal).then(
      (doc) => { if (!controller.signal.aborted) { setProblem(null); setLoaded({ key, doc }); } },
      () => { if (!controller.signal.aborted) setLoaded({ key, failed: true }); },
    );
    return () => controller.abort();
  }, [key, appId, rev]);

  const maker = (app && botOf?.(app.botId)) ?? app?.bot ?? undefined;
  const current = loaded && loaded.key === key && "doc" in loaded ? loaded.doc : null;
  const failed = loaded && loaded.key === key && "failed" in loaded;
  const goToChat = app ? onGoToChat?.(app) : undefined;
  const title = app?.name ?? "";
  const installed = Boolean(app && install?.ids.has(app.id));
  const onDesktop = Boolean(app && install?.desktop?.has(app.id));
  const installOne: InstallActions | undefined = app && install?.available ? { installed, run: () => {
    setInstallFailed(null);
    void (installed ? uninstallLocalApp(app.id) : installLocalApp(app))
      .catch(() => setInstallFailed(t(installed ? "localApps.install.uninstallFailed" : "localApps.install.failed", { name: app.name })));
  }, ...(install.canDesktop ? { desktop: { on: onDesktop, run: () => {
    setInstallFailed(null);
    void (onDesktop ? removeLocalAppFromDesktop(app.id) : addLocalAppToDesktop(app))
      .catch((error: unknown) => setInstallFailed(desktopFailedText(error, onDesktop, app.name)));
  } } } : {}) } : undefined;

  const header = (
    <>
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-2.5">
        {app && <LocalAppMark app={app} bot={app ? botOf?.(app.botId) : undefined} size="sm" />}
        <h1 dir="auto" className={cn(TOOL_PAGE_TITLE, "min-w-0 truncate")} title={title}>{title}</h1>
        {app?.sample ? <span className="shrink-0 truncate text-[13px] text-ink-tertiary max-sm:hidden">{t("localApps.card.sample")}</span>
          : maker?.name && <span dir="auto" className="shrink-0 truncate text-[13px] text-ink-tertiary max-sm:hidden">{t("localApps.view.by", { bot: maker.name })}</span>}
        {installed && <span className="max-sm:hidden"><InstalledMark /></span>}
      </div>
      {app && (
        <ToolPageActions>
          <span className="flex items-center gap-1.5">
            <VersionMenu app={app} />
            {goToChat && (
              <button type="button" className={HEADER_BUTTON} onClick={goToChat} title={t("localApps.card.goToChat")}>
                <MessageSquare size={14} aria-hidden="true" /><span className="max-sm:sr-only">{t("localApps.card.goToChat")}</span>
              </button>
            )}
            {!goToChat && !app.chat && !app.sample && <span className="sr-only">{t("localApps.view.chatGone")}</span>}
            {onOpenWindow && (
              <button type="button" className="ui-icon-button hover:bg-ink/[0.06] hover:text-ink" onClick={onOpenWindow}
                aria-label={t("localApps.card.openWindow")} title={t("localApps.card.openWindow")}><AppWindowMac size={16} /></button>
            )}
            {installOne && (
              <SidebarPopoverMenu items={installItems(installOne)} ariaLabel={t("localApps.card.more", { name: app.name })} placement="below" align="end"
                triggerTitle={t("localApps.card.more", { name: app.name })} triggerClassName="ui-icon-button hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06]"
                renderTrigger={() => <MoreHorizontal size={16} aria-hidden="true" />} />
            )}
          </span>
        </ToolPageActions>
      )}
    </>
  );

  const body = !app ? (
    <Centered>
      {status === "failed" ? <Retry text={t("localApps.view.loadFailed")} onRetry={() => void loadLocalApps()} />
        : apps ? <p className="text-[13px] text-ink-secondary">{t("localApps.view.gone")}</p>
          : <Loader2 size={18} className="animate-spin text-ink-tertiary motion-reduce:animate-none" aria-hidden="true" />}
    </Centered>
  ) : failed ? (
    <Centered><Retry text={t("localApps.view.loadFailed")} onRetry={() => setReload((count) => count + 1)} /></Centered>
  ) : current ? (
    <AppFrame key={key} doc={current} botId={app.botId} threadId={app.threadId} title={app.name} height={600} handle={handle}
      onHeight={() => {}} onProblem={setProblem} onTeardownRequested={() => onBack?.()} fill
      {...(app.chat ? {} : { pageRefusal: t("localApps.view.chatGoneData") })} />
  ) : (
    <Centered><Loader2 size={18} className="animate-spin text-ink-tertiary motion-reduce:animate-none" aria-hidden="true" /></Centered>
  );

  return (
    <ToolPage label={title || t("localApps.view.back")}>
      {onBack ? (
        <ToolPageHeader backLabel={t("localApps.view.back")} onBack={onBack} backRef={back}>{header}</ToolPageHeader>
      ) : (
        <header className="shrink-0 border-b border-hairline/35 bg-app px-4 py-3"><div className="flex flex-wrap items-center gap-2">{header}</div></header>
      )}
      {app && !app.chat && app.manifest.uses?.length ? (
        <p role="status" data-local-app-chat-gone="" className="shrink-0 border-b border-hairline/35 px-4 py-2 text-[13px] text-ink-secondary">{t("localApps.view.chatGoneData")}</p>
      ) : null}
      {installFailed && <p role="alert" className="shrink-0 border-b border-hairline/35 px-4 py-2 text-[13px] text-danger">{installFailed}</p>}
      <div data-local-app-view={id} data-local-app-state={current ? "live" : failed ? "failed" : app ? "loading" : "absent"} className="relative min-h-0 flex-1 bg-app">
        {body}
      </div>
      {problem?.kind === "offline" && (
        <p role="status" className="shrink-0 border-t border-hairline/35 px-4 py-2 text-[13px] text-ink-secondary">{t("app.strip.offline")}</p>
      )}
    </ToolPage>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">{children}</div>;
}

function Retry({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <>
      <p role="alert" className="text-[13px] text-ink-secondary">{text}</p>
      <button type="button" className="ui-button ui-button-md" onClick={onRetry}>{t("common.tryAgain")}</button>
    </>
  );
}
