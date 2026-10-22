import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import { credentialResumeOutcome, credentialSaveRequest, isConfigCredentialTarget } from "../../shared/credential-request";
import { credentialProvider } from "@/lib/analytics-allowlist";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { keySaved, keySaveFailure, savedKeyResult } from "@/lib/product-events";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";
import { ASK_FIELD, ASK_PRIMARY_BUTTON, ASK_QUIET_BUTTON, AskCard, AskSettledLine, returnFocusToComposer } from "./AskCard";

// Security: the value goes straight to the host's settings, never into the chat.

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
  const stopped = secret.stopped === true;
  const description = superseded
    ? t("chat.secret.superseded")
    : provided
    ? stopped
      ? t("chat.secret.saved")
      : secret.resumed
      ? t("chat.secret.savedContinuing")
      : t("chat.secret.savedWaiting")
    : declined
      ? t("chat.secret.declined")
      : secret.description;
  const footerLabel = stopped
    ? t("chat.secret.stopped")
    : declined
    ? t("chat.secret.declinedFailed")
    : secret.resumed
      ? t("chat.secret.resumedWithout")
      : error
        ? t("chat.secret.resumeFailed")
        : t("chat.secret.waiting");

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
    const provider = credentialProvider(secret.target);
    let saved = savedLocally;
    try {
      if (!savedLocally) {
        const next = value.trim();
        const target = secret.target;
        // The 1Password token goes to this server's Logins, which checks it with 1Password first, never the settings file.
        const request = credentialSaveRequest(target, next);
        if (isConfigCredentialTarget(target)) {
          const status: ConfigStatus = window.ogb?.setCredential
            ? await window.ogb.setCredential(target, next)
            : await api(request.path, { method: request.method, body: JSON.stringify(request.body) });
          dispatch({ type: "configStatus", config: status });
        } else await api(request.path, { method: request.method, body: JSON.stringify(request.body) });
        saved = true;
        keySaved(provider, "chat_request", savedKeyResult(provider));
        setValue("");
        setSavedLocally(true);
      }
      await notifyProvided();
      returnFocusToComposer();
    } catch (error) {
      if (!saved) keySaved(provider, "chat_request", keySaveFailure(error));
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

  if (superseded) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={secret.label}>
        <span className="text-ink-secondary" title={description}>{secret.label}</span>
        <span> · {t("chat.secret.supersededShort")}</span>
      </AskSettledLine>
    );
  }

  if (stopped && !provided) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={secret.label}>
        <span className="text-ink-secondary" title={secret.description}>{secret.label}</span>
        <span> · {t("chat.secret.stopped")}</span>
      </AskSettledLine>
    );
  }

  if (provided || declined) {
    const retry = !secret.resumed && !stopped && error ? (
      <button type="button" onClick={() => void retryResume()} disabled={saving} className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
        {saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {t("common.tryAgain")}
      </button>
    ) : undefined;
    return (
      <AskSettledLine
        ariaLabel={secret.label}
        icon={secret.resumed || stopped
          ? undefined
          : declined
            ? <X size={13} className="text-danger" />
            : error
              ? <KeyRound size={13} />
              : <Loader2 size={13} className="animate-spin" />}
        action={retry}
        detail={error && <p role="alert" className="ms-[19px] mt-1 text-[12px] text-danger">{error}</p>}
      >
        <span className="text-ink-secondary" title={description}>{provided ? t("chat.secret.labelSaved", { label: secret.label }) : secret.label}</span>
        <span className={declined ? "text-danger" : undefined}> · {footerLabel}</span>
      </AskSettledLine>
    );
  }

  return (
    <AskCard
      ariaLabel={secret.label}
      icon={<KeyRound size={15} />}
      title={secret.label}
      explanation={description}
      onDismiss={dismiss}
      dismissLabel={t("notice.notNow")}
    >
      {remoteClient ? (
        <div className="text-[12.5px] leading-relaxed text-ink-secondary">
          {t("chat.secret.remoteClient")}
        </div>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <div className="flex flex-wrap gap-2">
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              dir="ltr"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={secret.placeholder}
              disabled={saving || savedLocally}
              aria-label={secret.label}
              className={cn(ASK_FIELD, "min-w-[10rem] flex-1")}
            />
            <button type="submit" disabled={saving || (!value.trim() && !savedLocally)} className={ASK_PRIMARY_BUTTON}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <LockKeyhole size={14} />}
              {t(savedLocally ? "chat.secret.continue" : "chat.secret.save")}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-tertiary">
            <span className="flex items-center gap-1">
              <LockKeyhole size={11} /> {t("chat.secret.storedHint")}
            </span>
            <a
              href={secret.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent-text hover:underline"
            >
              {t("chat.secret.whereToGet")} <ExternalLink size={11} />
            </a>
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </AskCard>
  );
}
