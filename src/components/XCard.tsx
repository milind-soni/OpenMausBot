import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { xResearchAction } from "@/lib/cloud-plan";
import { keyRemoved, keySaved, keySaveFailure, keyTestResult } from "@/lib/product-events";
import { isXConnectorStatus, type XConnectorStatus, type XIncludedUsage } from "../../shared/x-connector";
import { looksLikeKey, saveCredential, tregVerdict } from "./ApiKeys";
import { useCloudPlan } from "./ProIntroduction";

const TREG_URL = "https://treg.to";
const pill = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40";
const field = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50";

/** What the card's search box matches. */
export const X_CARD_SEARCH = "x twitter treg tweets posts";

export function XIcon() {
  return (
    <svg viewBox="0 0 40 40" className="size-10 shrink-0 rounded-[10px]" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#000" />
      <path transform="translate(9 9) scale(0.9167)" fill="#fff" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const day = (iso: string) => new Intl.DateTimeFormat(activeLocale(), { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(iso));
const number = (value: number) => value.toLocaleString(activeLocale());

/** The plan's included calls this month in words: "312 of 5,000 X calls this month", or that they are used up and when they come back. */
export function xUsageLines(usage: XIncludedUsage): { line: string; usedUp: boolean } {
  const counts = { used: number(usage.calls), max: number(usage.max) };
  if (usage.trialEndsAt) {
    return usage.usedUp
      ? { line: t("apps.x.usedUpTrial", { date: day(usage.trialEndsAt) }), usedUp: true }
      : { line: t("apps.x.usageTrial", counts), usedUp: false };
  }
  return usage.usedUp
    ? { line: t("apps.x.usedUp", { date: day(usage.resetsAt) }), usedUp: true }
    : { line: `${t("apps.x.usage", counts)} ${t("apps.x.resets", { date: day(usage.resetsAt) })}`, usedUp: false };
}

/** The X (Twitter) card in Apps: included with a Cloud plan, or the person's own treg key, which is used first. */
export function XCard({ refreshKey = 0, onConnection }: {
  refreshKey?: number;
  /** true while bots have the X tools, false otherwise, null until the server has answered */
  onConnection?: (connected: boolean | null) => void;
}) {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<XConnectorStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [addingOwn, setAddingOwn] = useState(false);
  const mounted = useRef(true);
  const saveAfterPaste = useRef(false);
  const connecting = xResearchAction(useCloudPlan()?.view ?? null) === "connecting";
  const ownConfigured = state.config?.treg?.configured === true, includedHeld = state.config?.xResearch?.included === true;

  const load = useCallback(async (refresh = false): Promise<void> => {
    try {
      const response = await api(`/api/x/status${refresh ? "?refresh=1" : ""}`);
      if (!mounted.current) return;
      if (!isXConnectorStatus(response)) throw new Error("unexpected X status");
      setStatus(response);
      setLoadFailed(false);
    } catch {
      if (mounted.current) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(refreshKey > 0);
    return () => { mounted.current = false; };
  }, [load, refreshKey, ownConfigured, includedHeld]);

  useEffect(() => {
    onConnection?.(status ? status.using !== null : null);
  }, [status, onConnection]);

  const applied = (config: ConfigStatus) => {
    dispatch({ type: "configStatus", config });
    return load(true);
  };

  const test = async () => {
    setBusy("test");
    setVerdict(null);
    try {
      const result = await api("/api/keys/test", { method: "POST", body: JSON.stringify({ provider: "treg" }) });
      if (mounted.current) setVerdict(tregVerdict(result));
      return keyTestResult(result);
    } catch (cause) {
      if (mounted.current) setVerdict(cause instanceof Error ? cause.message : String(cause));
      return keyTestResult(null);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const save = async () => {
    const value = key.trim();
    if (busy || !value) return;
    if (!looksLikeKey(value)) return setError(t("keys.notAKey"));
    setBusy("save");
    setError(null);
    setVerdict(null);
    try {
      await applied(await saveCredential("treg", value, !ownConfigured));
      if (!mounted.current) return;
      setKey("");
      setAddingOwn(false);
      keySaved("treg", "apps", await test());
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      keySaved("treg", "apps", keySaveFailure(cause));
    } finally {
      if (mounted.current) setBusy((current) => (current === "save" ? null : current));
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("remove");
    setError(null);
    setVerdict(null);
    try {
      await applied(await saveCredential("treg", "", false));
      keyRemoved("treg", "apps");
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  useEffect(() => {
    if (!saveAfterPaste.current) return;
    saveAfterPaste.current = false;
    void save();
  });

  const using = status?.using ?? null;
  const usage = status?.usage ? xUsageLines(status.usage) : null;
  const showForm = status !== null && using !== "own" && (using === null || addingOwn || usage?.usedUp === true);
  const description = status === null ? t("apps.x.description")
    : using === "own" ? t("apps.x.own")
      : using === "included" ? t("apps.x.included")
        : connecting && !status.unavailable ? t("apps.x.connecting") : t("apps.x.addKey");

  return (
    <div data-app-tile="x" data-x-state={status === null ? "loading" : using ?? "none"} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <XIcon />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{t("apps.x.title")}</span>
            {using !== null && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
          </div>
          <p className="truncate text-[12.5px] leading-[18px] text-ink-secondary" title={description}>{description}</p>
        </div>
        {status === null ? (
          loadFailed
            ? <button type="button" onClick={() => void load(true)} className={pill}>{t("connectors.action.retry")}</button>
            : <button type="button" disabled className={pill} aria-label={t("common.checking")}><Loader2 size={14} className="animate-spin" /></button>
        ) : using === "own" ? (
          <button type="button" disabled={busy !== null} onClick={() => void test()} className={pill}>
            {busy === "test" ? <Loader2 size={14} className="animate-spin" /> : t("keys.test")}
          </button>
        ) : null}
      </div>
      <div className="ps-[52px]">
        {using === "own" && (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            {status?.included ? t("apps.x.ownFirst") : t("apps.x.ownBilled")}
          </p>
        )}
        {using === "included" && usage && (
          <p data-x-usage className={usage.usedUp ? "mt-1 text-[12px] leading-relaxed text-warning" : "mt-1 text-[12px] leading-relaxed text-ink-secondary"}>{usage.line}</p>
        )}
        {using === "own" && (
          <button type="button" disabled={busy !== null} onClick={() => void remove()} className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] text-danger underline underline-offset-2 disabled:opacity-50">
            {busy === "remove" && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {t("apps.x.remove")}
          </button>
        )}
        {using === "included" && !showForm && (
          <button type="button" onClick={() => { setAddingOwn(true); setError(null); }} className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
            {t("apps.x.useOwnKey")}
          </button>
        )}
        {showForm && (
          <form data-x-key-form className="mt-2 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            {using === null && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("apps.x.addKeyHelp")}</p>}
            <div className="flex items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("keys.treg.label")}
                placeholder={t("keys.treg.placeholder")}
                value={key}
                disabled={busy === "save"}
                onChange={(event) => { setError(null); setKey(event.target.value); }}
                onPaste={() => { saveAfterPaste.current = true; }}
                className={field}
              />
              <button type="submit" disabled={busy !== null || !key.trim()} className={pill}>
                {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : t("common.save")}
              </button>
            </div>
            <a href={TREG_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline">
              {t("keys.treg.link")}
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          </form>
        )}
        {verdict && <p role="status" className="mt-1.5 text-[12px] text-ink-secondary">{verdict}</p>}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
      </div>
    </div>
  );
}
