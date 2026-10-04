import { useState, type FormEvent } from "react";
import { Check, ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import { credentialConfigPatch, credentialResumeOutcome } from "../../shared/credential-request";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";

export function SecretRequestCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const secret = message.secret!;
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? secret.error;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const superseded = secret.superseded === true;
  const pending = !provided && !declined && !superseded;
  const description = superseded
    ? t("secretRequest.superseded")
    : provided
    ? secret.resumed
      ? t("secretRequest.savedContinuing")
      : t("secretRequest.savedWaiting")
    : declined
      ? t("secretRequest.declined")
      : secret.description;
  const footerLabel = declined
    ? t("secretRequest.footerDeclineFailed")
    : secret.resumed
      ? t("secretRequest.footerResumed")
      : error
        ? t("secretRequest.footerResumeFailed")
        : t("secretRequest.footerWaiting");

  // A successful decline has no durable card to show. If its continuation
  // failed, bring the card back with the same retry affordance as a saved key.
  if (declined && (secret.resumed || !error)) return null;

  const notifyProvided = async () => {
    await api(`${endpoint}/provided`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
  };

  const retryResume = async () => {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    try {
      if (!savedLocally) {
        const next = value.trim();
        const status: ConfigStatus = window.ogb?.setCredential
          ? await window.ogb.setCredential(secret.target, next)
          : await api("/api/config", {
              method: "PUT",
              body: JSON.stringify(credentialConfigPatch(secret.target, next)),
            });
        dispatch({ type: "configStatus", config: status });
        setValue("");
        setSavedLocally(true);
      }
      await notifyProvided();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    }).catch(() => {});
  };

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink">
            <KeyRound size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{secret.label}</span>
              {provided && (
                <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <Check size={11} /> {t("secretRequest.savedBadge")}
                </span>
              )}
              {superseded && (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                  {t("secretRequest.supersededBadge")}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {description}
            </p>
            {pending && (
              <p className="mt-1 flex items-center gap-1 text-[11.5px] text-ink-tertiary">
                <LockKeyhole size={11} /> {t("secretRequest.storedSecurely")}
              </p>
            )}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
          {pending && (
            <button
              onClick={dismiss}
              aria-label={t("secretRequest.notNow")}
              title={t("secretRequest.notNow")}
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={15} />
            </button>
          )}
        </div>
        {remoteClient && pending && (
          <div className="border-t border-hairline/40 bg-panel/40 px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
            {t("secretRequest.hostOnly")}
          </div>
        )}
        {!remoteClient && pending && (
          <form onSubmit={(event) => void save(event)} className="border-t border-hairline/40 bg-panel/40 px-4 py-3">
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={secret.placeholder}
                disabled={saving || savedLocally}
                aria-label={secret.label}
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={saving || (!value.trim() && !savedLocally)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <LockKeyhole size={13} />}
                {savedLocally ? t("secretRequest.continueTask") : t("secretRequest.saveSecurely")}
              </button>
            </div>
            <a
              href={secret.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
            >
              {t("secretRequest.whereToGet")} <ExternalLink size={11} />
            </a>
          </form>
        )}
        {(provided || declined) && (
          <div className={cn(
            "flex items-center justify-between border-t border-hairline/40 bg-panel/40 px-4 py-2.5 text-[11.5px]",
            declined ? "text-danger" : "text-success",
          )}>
            <span className="flex items-center gap-1.5">
              {secret.resumed ? <Check size={12} /> : error ? <KeyRound size={12} /> : <Loader2 size={12} className="animate-spin" />}
              {footerLabel}
            </span>
            {!secret.resumed && error && (
              <button
                onClick={() => void retryResume()}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {t("secretRequest.tryAgain")}
              </button>
            )}
          </div>
        )}
        {superseded && (
          <div className="flex items-center border-t border-hairline/40 bg-panel/40 px-4 py-2.5 text-[11.5px] text-ink-secondary">
            <span className="flex items-center gap-1.5">
              <X size={12} /> {t("secretRequest.supersededByNewer")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
