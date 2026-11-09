// The OpenConnector card: one row, two fields. The runtime address and its admin token
// belong to one backend, so they are configured together — the address keeps its stored
// value when left blank, the token is write-only (blank keeps it; Clear drops both and
// the connector layer falls back to whichever other backend is filled in).
import { useState } from "react";
import { Check, CircleAlert, Eye, EyeOff } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import logo from "@/assets/openconnector/logo.png";
import { KEY_FIELD, KEY_ROW, KeyStatusChip, type KeyStatus } from "./KeyRow";

const WORDS = ["openconnector", "open connector", "admin token", "connected apps", "self-host", "broker"];

/** Same rule as keyMatches: the row shows for an empty query or one that names it. */
export function openConnectorMatches(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t("keys.openconnector.label"), t("keys.purpose.openconnector"), t("keys.section.apps"), "OpenConnector", ...WORDS]
    .some((part) => part.toLowerCase().includes(q));
}

export function OpenConnectorRow() {
  const { state, dispatch } = useStore();
  const openconnector = state.config?.connectors?.openconnector;
  const url = openconnector?.url ?? "";
  const tokenSaved = openconnector?.configured === true;
  const [urlDraft, setUrlDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState<"saving" | "clearing" | null>(null);
  const [status, setStatus] = useState<KeyStatus>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (body: Record<string, string>) => {
    if (busy) return;
    setBusy("saving");
    setStatus({ tone: "busy", text: t("keys.row.saving") });
    setProblem(null);
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify({ connectors: { openconnector: body } }) });
      dispatch({ type: "configStatus", config });
      setUrlDraft("");
      setTokenDraft("");
      setStatus({ tone: "ok", text: t("common.saved") });
    } catch (cause) {
      setStatus(null);
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const onMainSave = () => save({ url: urlDraft.trim() || url, ...(tokenDraft.trim() ? { adminToken: tokenDraft.trim() } : {}) });
  const configured = Boolean(url) || tokenSaved;

  return (
    <div
      data-key-row="openconnector"
      data-key-state={tokenSaved ? "saved" : url ? "saved" : "empty"}
      role="group"
      className={KEY_ROW}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <img src={logo} alt="" width={16} height={16} className="size-4 shrink-0 rounded-[3px] object-contain" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-5 text-ink">{t("keys.openconnector.label")}</div>
          <div className="text-[13px] leading-[18px] text-ink-secondary">{t("keys.purpose.openconnector")}</div>
        </div>
        <KeyStatusChip status={status ?? (configured ? { tone: "ok", text: t("common.saved") } : null)} />
      </div>
      <div className="flex flex-col gap-2 pl-8">
        <div className="flex flex-wrap items-center gap-2">
          <input
            data-openconnector-url
            type="text"
            value={urlDraft}
            onChange={(event) => { setUrlDraft(event.target.value); setProblem(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void onMainSave(); } }}
            disabled={busy !== null}
            placeholder={url || t("keys.openconnector.urlPlaceholder")}
            aria-label={t("keys.openconnector.urlPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className={KEY_FIELD}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[min(100%,12rem)] flex-1">
            <input
              data-openconnector-token
              type={shown ? "text" : "password"}
              value={tokenDraft}
              onChange={(event) => { setTokenDraft(event.target.value); setProblem(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void onMainSave(); } }}
              disabled={busy !== null}
              placeholder={tokenSaved && openconnector?.last4
                ? t("keys.openconnector.tokenKept", { last4: openconnector.last4 })
                : t("keys.openconnector.tokenPlaceholder")}
              aria-label={t("keys.openconnector.tokenPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className={cn(KEY_FIELD, "pr-9")}
            />
            <button
              type="button"
              onClick={() => setShown((current) => !current)}
              aria-label={shown ? t("keys.row.hide") : t("keys.row.show")}
              aria-pressed={shown}
              className="absolute right-0.5 top-1/2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
            >
              {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
            </button>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-openconnector-save
              className="ui-button ui-button-primary"
              disabled={busy !== null || (!urlDraft.trim() && !tokenDraft.trim())}
              onClick={() => void onMainSave()}
            >
              {t("common.save")}
            </button>
            {configured && (
              <button
                type="button"
                data-openconnector-clear
                className="ui-button"
                disabled={busy !== null}
                onClick={() => void save({ url: "", adminToken: "" })}
              >
                {t("keys.openconnector.clear")}
              </button>
            )}
          </span>
        </div>
        {problem && (
          <p role="alert" className="flex gap-1.5 text-[12px] leading-4 text-danger">
            <CircleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
            <span>{problem}</span>
          </p>
        )}
        {tokenSaved && !problem && busy === null && (
          <div className="flex items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
            <Check size={13} aria-hidden="true" className="shrink-0 text-success" />
            {openconnector?.last4 ? t("keys.row.endsIn", { label: "OpenConnector", last4: openconnector.last4 }) : t("keys.row.savedKey", { label: "OpenConnector" })}
          </div>
        )}
      </div>
    </div>
  );
}
