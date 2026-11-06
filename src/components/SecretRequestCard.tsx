import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import { CUSTOM_SECRET_TARGET, credentialResumeOutcome, credentialSaveRequest, desktopCredentialSlot, isConfigCredentialTarget } from "../../shared/credential-request";
import { credentialProvider } from "@/lib/analytics-allowlist";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { keySaved, keySaveFailure, savedKeyResult } from "@/lib/product-events";
import { api, useStore, type Bot, type ConfigStatus, type Message } from "@/state/store";
import { ASK_FIELD, askPrimary, ASK_QUIET_BUTTON, AskCard, AskSettledLine, returnFocusToComposer } from "./AskCard";
import { EmailServerInputs } from "./EmailCard";
import type { EmailServerFields } from "../../shared/email";
import { productName } from "@/lib/brand";

// Security: the value goes straight to the host's settings, never into the chat.

export function SecretRequestCard({
  botId,
  botName,
  color,
  threadId,
  message,
}: {
  botId: string;
  botName?: string;
  color?: Bot["color"];
  threadId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const secret = message.secret!;
  const localize = activeLocale() !== "en";
  const greenference = localize && secret.target === "greenferenceApiKey";
  const gemini = localize && secret.target === "geminiTtsKey";
  const label = greenference ? t("keys.greenference.label") : gemini ? t("keys.label.geminiTts") : secret.label;
  const placeholder = greenference ? t("keys.greenference.placeholder") : gemini ? t("voice.gemini.keyPlaceholder") : secret.placeholder;
  const parts = secret.descriptionParts;
  const suppliedDescription = localize && parts
    ? [t(parts.baseCode), parts.reason, t("server.connect.secretNeverRead", { bot: parts.bot })].filter(Boolean).join(" ")
    : secret.description;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const email = secret.delivery === "email";
  const [address, setAddress] = useState(secret.address ?? "");
  const [server, setServer] = useState<EmailServerFields>({});
  const [needsServer, setNeedsServer] = useState(false);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? secret.error;
  const custom = secret.target === CUSTOM_SECRET_TARGET;
  // A page reached through a desktop paired to another computer: a key that computer keeps in its own encrypted store can
  // only be typed there. Anything its server keeps, a custom secret or a provider key, is typed here like on any page.
  const onlyOnHost = window.ogb?.remoteClient?.active === true && secret.target !== CUSTOM_SECRET_TARGET && desktopCredentialSlot(secret.target) !== null;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const superseded = secret.superseded === true;
  const stopped = secret.stopped === true;
  const authorName = message.from?.name ?? botName;
  const deliveryDescription = custom && !email && authorName ? t(secret.delivery === "file" ? "secretCard.delivery.fileNamed" : "secretCard.delivery.refNamed", { botName: authorName }) : null;
  const customDescription = activeLocale() !== "en" && deliveryDescription ? [secret.reason, deliveryDescription].filter(Boolean).join(" ") : suppliedDescription;
  const description = superseded
    ? t("chat.secret.superseded")
    : provided
    ? stopped
      ? t("chat.secret.saved")
      : secret.resumed
      ? t("chat.secret.savedContinuing")
      : t("chat.secret.savedWaiting")
    : declined
      ? t("chat.secret.declined", { app: productName() })
      : custom && secret.reason ? secret.reason : customDescription;
  const footerLabel = stopped
    ? t("chat.secret.stopped")
    : declined
    ? t("chat.secret.declinedFailed")
    : secret.resumed
      ? custom && (secret.delivery === "file" || email) ? t("secretCard.resumed") : t("chat.secret.resumedWithout")
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

  // Kept behind the card on the server, never in Settings; saving it resumes the bot, and no product event names it.
  const saveCustom = async () => {
    if (saving || !value.trim()) return;
    setSaving(true);
    setLocalError(null);
    try {
      // A password goes as typed: a mailbox's can begin or end with a space.
      await api(`${endpoint}/save`, { method: "POST", body: JSON.stringify(email ? { threadId, value, address: address.trim(), ...server } : { threadId, value: value.trim() }) });
      setValue("");
      returnFocusToComposer();
    } catch (error) {
      if ((error as { body?: { needsServer?: unknown } }).body?.needsServer === true) setNeedsServer(true);
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
      <AskSettledLine icon={<X size={13} />} ariaLabel={label}>
        <span className="text-ink-secondary" title={description}>{label}</span>
        <span> · {t("chat.secret.supersededShort")}</span>
      </AskSettledLine>
    );
  }

  if (stopped && !provided) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={label}>
        <span className="text-ink-secondary" title={customDescription}>{label}</span>
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
        ariaLabel={label}
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
        <span className="text-ink-secondary" title={description}>{provided ? t("chat.secret.labelSaved", { label }) : label}</span>
        <span className={declined ? "text-danger" : undefined}> · {footerLabel}</span>
      </AskSettledLine>
    );
  }

  return (
    <AskCard
      ariaLabel={label}
      icon={<KeyRound size={15} />}
      title={label}
      explanation={description}
      onDismiss={dismiss}
      dismissLabel={t("notice.notNow")}
      stays
    >
      {onlyOnHost ? (
        <div className="text-[13px] leading-relaxed text-ink-secondary">
          {t("chat.secret.remoteClient")}
        </div>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          {email && (
            <div className="mb-2 flex flex-col gap-2">
              <input type="email" autoComplete="off" spellCheck={false} dir="ltr" value={address} onChange={(event) => setAddress(event.target.value)} placeholder={t("email.address")} disabled={saving} aria-label={t("email.address")} className={cn(ASK_FIELD, "w-full")} />
              {needsServer && <EmailServerInputs value={server} onChange={setServer} className={cn(ASK_FIELD, "w-full")} />}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              dir="ltr"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              disabled={saving || savedLocally}
              aria-label={label}
              className={cn(ASK_FIELD, "min-w-[10rem] flex-1")}
            />
            <button type="submit" disabled={saving || (!value.trim() && !savedLocally) || (email && !address.trim())} {...askPrimary(color)}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <LockKeyhole size={14} />}
              {t(savedLocally ? "chat.secret.continue" : "chat.secret.save")}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-tertiary">
            <span className="flex items-center gap-1">
              <LockKeyhole size={11} />{" "}
              {!custom ? t("chat.secret.storedHint", { app: productName() }) : email ? t("secretCard.email") : secret.delivery === "file" ? t("secretCard.file") : t("secretCard.ref")}
            </span>
            {secret.helpUrl && (
              <a
                href={secret.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                {t("chat.secret.whereToGet")} <ExternalLink size={11} />
              </a>
            )}
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </AskCard>
  );
}
