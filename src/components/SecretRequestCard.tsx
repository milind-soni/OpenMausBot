import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import { CUSTOM_SECRET_TARGET, credentialResumeOutcome, credentialSaveRequest, desktopCredentialSlot, isConfigCredentialTarget } from "../../shared/credential-request";
import { credentialProvider } from "@/lib/analytics-allowlist";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { keySaved, keySaveFailure, savedKeyResult } from "@/lib/product-events";
import { api, useStore, type Bot, type ConfigStatus, type Message } from "@/state/store";
import { ASK_FIELD, askPrimary, ASK_QUIET_BUTTON, AskCard, AskSettledLine, returnFocusToComposer } from "./AskCard";
import { productName } from "@/lib/brand";

// Security: the value goes straight to the host's settings, never into the chat.

export function SecretRequestCard({
  botId,
  color,
  threadId,
  message,
}: {
  botId: string;
  color?: Bot["color"];
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
  const custom = secret.target === CUSTOM_SECRET_TARGET;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const superseded = secret.superseded === true;
  const stopped = secret.stopped === true;
  const description = superseded
    ? "This request was replaced by a newer one for the same key. Use the newest card to provide it."
    : provided
    ? stopped
      ? "Saved securely."
      : secret.resumed
      ? "Saved securely. Your bot is continuing the task."
      : "Saved securely. Your bot will continue when its current turn settles."
    : declined
      ? `You chose not to provide this credential. ${productName()} could not resume the bot yet.`
      : custom && secret.reason ? secret.reason : secret.description;
  const footerLabel = stopped
    ? "Stopped"
    : declined
    ? "Continuing without this credential failed"
    : secret.resumed
      ? custom && secret.delivery === "file" ? t("secretCard.resumed") : "Bot resumed without seeing the key"
      : error
        ? "The key is safe; resuming failed"
        : "Waiting to resume safely";

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

  // Kept behind the card on the server, never in Settings; saving it resumes the bot, and no product event names it.
  const saveCustom = async () => {
    if (saving || !value.trim()) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/save`, { method: "POST", body: JSON.stringify({ threadId, value: value.trim() }) });
      setValue("");
      returnFocusToComposer();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (custom) return saveCustom();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    const provider = credentialProvider(secret.target);
    let saved = savedLocally;
    try {
      if (!savedLocally && secret.target !== CUSTOM_SECRET_TARGET) {
        const next = value.trim();
        const target = secret.target;
        // The 1Password token goes to this server's Logins, which checks it with 1Password first, never the settings file.
        const request = credentialSaveRequest(target, next);
        const slot = desktopCredentialSlot(target);
        if (isConfigCredentialTarget(target)) {
          const status: ConfigStatus = slot && window.ogb?.setCredential
            ? await window.ogb.setCredential(slot, next)
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
        <span> · Superseded by a newer request</span>
      </AskSettledLine>
    );
  }

  if (stopped && !provided) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={secret.label}>
        <span className="text-ink-secondary" title={secret.description}>{secret.label}</span>
        <span> · Stopped</span>
      </AskSettledLine>
    );
  }

  if (provided || declined) {
    const retry = !secret.resumed && !stopped && error ? (
      <button type="button" onClick={() => void retryResume()} disabled={saving} className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
        {saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        Try again
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
        <span className="text-ink-secondary" title={description}>{provided ? `${secret.label} saved securely` : secret.label}</span>
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
      dismissLabel="Not now"
    >
      {remoteClient ? (
        <div className="text-[13px] leading-relaxed text-ink-secondary">
          This key must be saved on the host computer. Open this conversation on the host to continue securely.
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
            <button type="submit" disabled={saving || (!value.trim() && !savedLocally)} {...askPrimary(color)}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <LockKeyhole size={14} />}
              {savedLocally ? "Continue task" : "Save securely"}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-tertiary">
            <span className="flex items-center gap-1">
              <LockKeyhole size={11} />{" "}
              {!custom ? `Stored securely by ${productName()} and never added to chat.` : secret.delivery === "file" ? t("secretCard.file") : t("secretCard.ref")}
            </span>
            {secret.helpUrl && (
              <a
                href={secret.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                Where to get this key <ExternalLink size={11} />
              </a>
            )}
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </AskCard>
  );
}
