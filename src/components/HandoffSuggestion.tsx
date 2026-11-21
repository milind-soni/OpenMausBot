import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, RefreshCw, X } from "lucide-react";

import type { ComputerHelpRef } from "../../shared/wire";
import { appSwitchPatch, botAppScope } from "@/lib/bot-app-access";
import { loadAppCatalog } from "@/lib/app-catalog-cache";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { pollConnector } from "@/lib/connector-poll";
import { reserveConnectionPage } from "@/lib/connector-oauth";
import type { ConnectorStatus } from "@/lib/connector-status";
import { t } from "@/lib/i18n";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { answerSignIn } from "@/lib/sign-in";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { browserScope } from "@/lib/team-browser";
import { cookieImportAvailable } from "./browser/cookie-import";
import { api } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { ASK_DARK_PRIMARY, ASK_QUIET_BUTTON } from "./AskCard";
import { ELEVATED_CARD } from "./elevated";
import { ServiceIcon, type ToolkitCard } from "./ServiceIcon";

/** Where the suggestion's Connect stands. */
export type SuggestionPhase = "checking" | "ready" | "starting" | "waiting" | "stalled" | "failed" | "blocked" | "connected";

const dismissedKey = (messageId: string) => `openmausbot.handoff-suggestion.${messageId}`;
function dismissedBefore(messageId: string): boolean {
  try { return sessionStorage.getItem(dismissedKey(messageId)) === "1"; } catch { return false; }
}
function rememberDismissed(messageId: string): void {
  try { sessionStorage.setItem(dismissedKey(messageId), "1"); } catch { /* no storage: dismissed for this view only */ }
}

const readStatus = (slug: string): Promise<ConnectorStatus | undefined> =>
  api(`/api/connectors?services=${encodeURIComponent(slug)}`).then((r: { services?: Record<string, ConnectorStatus> }) => r.services?.[slug]);

/** The app a waiting sign-in could use instead, once the catalogue lists it and the bot does not have it yet. */
export function useSuggestedApp(site: string, botId: string): { card: ToolkitCard; status: ConnectorStatus | undefined } | null {
  // The matcher reads the public-suffix list, which the launch bundle leaves out: it loads with the first request card.
  const [matched, setMatched] = useState<{ site: string; slug: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void import("../../shared/app-sites").then(({ appForSite }) => { if (live) setMatched({ site, slug: appForSite(site) }); }, () => undefined);
    return () => { live = false; };
  }, [site]);
  const slug = matched?.site === site ? matched.slug : null;
  const bot = useStoreSelector((state) => state.bots.find((one) => one.id === botId));
  const [found, setFound] = useState<{ card: ToolkitCard; status: ConnectorStatus | undefined } | null>(null);
  useEffect(() => {
    if (!slug) return;
    let live = true;
    void loadAppCatalog().then(async (catalog) => {
      const card = catalog.mode === "unavailable" ? undefined : catalog.cards.find((one) => one.slug === slug && !one.noAuth);
      if (!card) return;
      const status = await readStatus(slug).catch(() => undefined);
      if (live) setFound({ card, status });
    }, () => undefined);
    return () => { live = false; };
  }, [slug]);
  if (!slug || found?.card.slug !== slug || !bot) return null;
  return found.status?.connected && botAppScope(bot, found.card.slug) !== null ? null : found;
}

/** Whether the desktop app offers to bring the person's own sign-in for this site into the bot's browser (never for
 * Google, never into a temporary browser); the scope the import names. */
export function useSignInImport(botId: string, threadId: string, site: string): { site: string; threadId: string | null } | null {
  const ready = useStoreSelector((state) => cookieImportAvailable(state.config) && state.bots.find((bot) => bot.id === botId)?.browserProfile !== "guest");
  const scope = useStoreSelector((state) => browserScope(state.config?.team, threadId).threadId ?? null);
  const [offered, setOffered] = useState<string | null>(null);
  useEffect(() => {
    setOffered(null);
    const bridge = window.ogb?.browserCookies;
    if (!ready || !site || !bridge) return;
    let live = true;
    void bridge.offer({ botId, threadId: scope, site }).then((answer) => { if (live && answer.offered) setOffered(site); }, () => undefined);
    return () => { live = false; };
  }, [ready, site, botId, scope]);
  return offered && offered === site ? { site, threadId: scope } : null;
}

/**
 * Under a sign-in the bot asked for, when the site is an app it could use directly: Connect starts that app's own
 * connection, gives it to the bot, and answers the request as done so the bot goes on through the app.
 */
export function HandoffSuggestion({ app, status, request, botName, initialPhase = "ready", onDismiss }: {
  app: ToolkitCard;
  status: ConnectorStatus | undefined;
  request: Pick<ComputerHelpRef, "botId" | "threadId" | "messageId" | "place">;
  botName: string;
  initialPhase?: SuggestionPhase;
  onDismiss?: () => void;
}) {
  const dispatch = useStoreDispatch();
  const bot = useStoreSelector((state) => state.bots.find((one) => one.id === request.botId));
  const admin = useOwnerOrAdmin();
  const [phase, setPhase] = useState<SuggestionPhase>(initialPhase);
  const [link, setLink] = useState<string | null>(null);
  const [gone, setGone] = useState(() => dismissedBefore(request.messageId));
  const stopPoll = useRef<(() => void) | null>(null);
  useEffect(() => () => stopPoll.current?.(), []);

  const finish = async () => {
    if (bot && admin === true && botAppScope(bot, app.slug) === null) {
      const patch = appSwitchPatch(bot, [app.slug], app.slug, true);
      if (Object.keys(patch).length) dispatch({ type: "updateBot", botId: bot.id, patch });
    }
    setPhase("connected");
    await answerSignIn(request, "done", `connected ${app.label} instead`).catch(() => undefined);
  };

  const connect = async () => {
    if (phase === "starting") return;
    if (status?.connected) { await finish(); return; }
    const launch = reserveConnectionPage();
    setPhase("starting");
    try {
      const result = await api(`/api/connectors/${encodeURIComponent(app.slug)}/authorize`, { method: "POST" });
      const url = mcpSignInLink(typeof result.url === "string" ? result.url : null);
      if (!url) throw new Error("no link");
      setLink(url);
      if (!await launch.open(url)) { setPhase("blocked"); return; }
      setPhase("waiting");
      stopPoll.current?.();
      stopPoll.current = pollConnector(status, () => readStatus(app.slug), (end) => {
        if (end === "connected") void finish();
        else setPhase(end === "timed_out" ? "stalled" : "failed");
      });
    } catch {
      setPhase("failed");
    } finally {
      launch.cancel();
    }
  };

  const reopen = () => { if (link) void reserveConnectionPage().open(link); };
  if (gone) return null;
  const dismiss = () => { rememberDismissed(request.messageId); setGone(true); onDismiss?.(); };
  const line = phase === "connected" ? t("handoff.suggest.connected", { name: botName, app: app.label })
    : phase === "waiting" ? t("handoff.suggest.waiting", { app: app.label })
      : phase === "stalled" ? t("handoff.suggest.stalled", { app: app.label })
        : phase === "failed" ? t("handoff.suggest.failed", { app: app.label })
          : phase === "blocked" ? t("handoff.suggest.blocked")
            : t("handoff.suggest.line", { app: app.label, name: botName });
  const trouble = phase === "stalled" || phase === "failed" || phase === "blocked";

  return (
    <div role="group" aria-label={t("handoff.suggest.label", { app: app.label })} data-handoff-suggestion={phase}
      className={cn("mt-3 flex w-full max-w-[560px] items-center gap-2.5 rounded-[18px] p-4 text-start", ELEVATED_CARD)}>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-composer ring-[0.5px] ring-inset ring-ink/10">
        <ServiceIcon card={app} className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <div dir="auto" className="truncate text-[14px] font-medium leading-5 text-ink">{app.label}</div>
        <div dir="auto" title={line} aria-live="polite"
          className={cn("flex min-w-0 items-center gap-1 text-[13px] leading-[18px]", trouble ? "text-danger" : "text-ink-secondary")}>
          {phase === "waiting" && <Loader2 size={12} aria-hidden="true" className="shrink-0 motion-safe:animate-spin" />}
          {phase === "connected" && <Check size={13} aria-hidden="true" className="shrink-0 text-success" />}
          <span className="truncate">{line}</span>
        </div>
      </div>
      {phase === "waiting" && <button type="button" onClick={reopen} className={ASK_QUIET_BUTTON}>{t("handoff.suggest.reopen")}</button>}
      {phase === "blocked" && link && (
        <button type="button" onClick={() => void copyText(link)} className={ASK_QUIET_BUTTON}><Copy size={13} aria-hidden="true" />{t("handoff.suggest.copy")}</button>
      )}
      {(phase === "ready" || phase === "checking" || phase === "starting" || trouble) && (
        <button type="button" onClick={() => void connect()} disabled={phase === "checking" || phase === "starting"} aria-busy={phase === "starting" || undefined}
          className={ASK_DARK_PRIMARY}>
          {phase === "starting" || phase === "checking" ? <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
            : trouble ? <RefreshCw size={14} aria-hidden="true" /> : null}
          {t(trouble ? "handoff.suggest.retry" : "handoff.suggest.connect")}
        </button>
      )}
      {phase !== "connected" && (
        <button type="button" onClick={dismiss} aria-label={t("handoff.suggest.dismiss")} title={t("handoff.suggest.dismiss")}
          className="-me-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:size-9">
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
