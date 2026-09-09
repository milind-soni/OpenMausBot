import { useEffect, useId, useState } from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import { api, ApiError, useStore, type Bot, type BotAnnouncement, type BrowserProfile, type ConfigStatus } from "@/state/store";
import { browserProfileDeletionBlockReason, browserProfilesMutation, newBrowserProfileId } from "@/lib/browser-profiles";
import { readSessionState } from "@/lib/session";
import { t } from "@/lib/i18n";

/** Browser-panel and workspace settings share one editor. The server owns
 * session routing and erasure; this UI never handles cookies or partitions. */
export function BrowserProfilesManager({ bot, onProfileChanged, disabled = false }: {
  bot?: Bot;
  onProfileChanged?: () => void;
  disabled?: boolean;
}) {
  const { state, dispatch, flushBotPatches } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const bots = state.bots ?? [];
  const currentBot = bot ? bots.find((candidate) => candidate.id === bot.id) ?? bot : undefined;
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const fieldId = useId();
  const locked = busy || disabled || canManage !== true;

  useEffect(() => {
    let alive = true;
    void readSessionState().then((session) => {
      if (alive) setCanManage(session.kind === "loopback" || (session.kind === "session" && session.scopes.includes("admin")));
    });
    return () => { alive = false; };
  }, []);

  const failed = async (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : t("settings.profiles.saveError"));
    if (cause instanceof ApiError && cause.status === 409) {
      // Preserve typed names and the error. Refresh the base list, then let
      // the person review it and explicitly retry rather than merge a wipe.
      try {
        const config: ConfigStatus = await api("/api/config");
        dispatch({ type: "configStatus", config });
      } catch {
        setError(t("settings.profiles.refreshError"));
      }
    }
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setCanManage(false);
  };

  const save = async (next: BrowserProfile[]): Promise<boolean> => {
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(browserProfilesMutation(profiles, next)),
      });
      dispatch({ type: "configStatus", config });
      return true;
    } catch (cause) {
      await failed(cause);
      return false;
    }
  };

  const create = async () => {
    if (locked || !name.trim() || profiles.length >= 20) return;
    setBusy(true);
    setError("");
    try {
      if (await save([...profiles, { id: newBrowserProfileId(), name: name.trim() }])) setName("");
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (locked || !renaming?.name.trim()) return;
    if (!profiles.some((profile) => profile.id === renaming.id)) {
      setError(t("settings.profiles.removed"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (await save(profiles.map((profile) => profile.id === renaming.id ? { ...profile, name: renaming.name.trim() } : profile))) {
        setRenaming(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: BrowserProfile) => {
    if (locked) return;
    const blocked = browserProfileDeletionBlockReason(bots, profile.id);
    if (blocked) return setError(blocked);
    const users = bots.filter((candidate) => candidate.browserProfile === profile.id);
    const summary = users.length ? ` ${t("settings.profiles.deleteUsers", { names: users.map((candidate) => candidate.name).join(", ") })}` : "";
    if (!window.confirm(t("settings.profiles.confirm", { name: profile.name, bots: summary }))) return;
    setBusy(true);
    setError("");
    try {
      if (await save(profiles.filter((candidate) => candidate.id !== profile.id))) {
        if (renaming?.id === profile.id) setRenaming(null);
        if (currentBot?.browserProfile === profile.id) onProfileChanged?.();
      }
    } finally {
      setBusy(false);
    }
  };

  const select = async (profileId: string) => {
    if (locked || !currentBot || currentBot.busy || profileId === (currentBot.browserProfile ?? "")) return;
    setBusy(true);
    setError("");
    try {
      // Drain coalesced settings edits before the explicit profile change so
      // an older queued patch cannot put the bot back on its previous login.
      await flushBotPatches(currentBot.id);
      const result: { bot: BotAnnouncement } = await api(`/api/bots/${encodeURIComponent(currentBot.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ browserProfile: profileId || null }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
      onProfileChanged?.();
    } catch (cause) {
      await failed(cause);
    } finally {
      setBusy(false);
    }
  };

  if (canManage === false) return <p className="text-[12px] text-ink-secondary">{t("settings.profiles.ownerOnly")}</p>;

  const inputClass = "min-w-0 flex-1 rounded-md border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50";
  const buttonClass = "shrink-0 rounded-md bg-control px-2.5 py-2 text-[12px] text-ink hover:bg-control-hover disabled:opacity-50";
  const selected = currentBot?.browserProfile ?? "";
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy={busy}>
      {currentBot && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-profile`} className="text-[12px] font-medium text-ink">{t("settings.profiles.browserSession")}</label>
          <select
            id={`${fieldId}-profile`}
            value={selected}
            disabled={locked || currentBot.busy}
            onChange={(event) => void select(event.target.value)}
            className={inputClass}
          >
            <option value="">{t("settings.profiles.own")}</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            <option value="guest">{t("settings.profiles.temporary")}</option>
            {selected && selected !== "guest" && !profiles.some((profile) => profile.id === selected)
              ? <option value={selected} disabled>{t("settings.profiles.removed")}</option> : null}
          </select>
          <p className="text-[11px] leading-relaxed text-ink-secondary">
            {currentBot.busy ? t("settings.profiles.stopToSwitch") : selected === "guest" ? t("settings.profiles.temporaryHint") : t("settings.profiles.sharedHint")}
          </p>
        </div>
      )}
      <details open={!currentBot} className="min-w-0">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary hover:text-ink">{t("settings.profiles.manage")}</summary>
        <div className="mt-3 flex flex-col gap-3">
          <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <label htmlFor={`${fieldId}-new`} className="sr-only">{t("settings.profiles.newName")}</label>
            <input id={`${fieldId}-new`} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required disabled={locked || profiles.length >= 20} placeholder={t("settings.profiles.newName")} className={inputClass} />
            <button type="submit" disabled={locked || !name.trim() || profiles.length >= 20} className={`${buttonClass} flex items-center gap-1`}><Plus size={13} />{t("settings.profiles.create")}</button>
          </form>
          {profiles.length >= 20 && <p className="text-[11px] text-ink-secondary">{t("settings.profiles.limit")}</p>}
          {!profiles.length && <p className="text-[12px] text-ink-secondary">{t("settings.profiles.sharedEmpty")}</p>}
          <div className="divide-y divide-hairline/30">
            {profiles.map((profile) => {
              const users = bots.filter((candidate) => candidate.browserProfile === profile.id).map((candidate) => candidate.name);
              const blocked = browserProfileDeletionBlockReason(bots, profile.id);
              return (
                <div key={profile.id} className="flex flex-col gap-1 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Globe size={14} className="shrink-0 text-ink-secondary" />
                    {renaming?.id === profile.id ? (
                      <form className="flex min-w-0 flex-1 flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
                        <input autoFocus value={renaming.name} onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })} maxLength={40} required disabled={locked} className={inputClass} aria-label={t("settings.profiles.nameAria")} />
                        <button type="submit" disabled={locked || !renaming.name.trim()} className={buttonClass}>{t("common.save")}</button>
                        <button type="button" disabled={busy} onClick={() => setRenaming(null)} className={buttonClass}>{t("common.cancel")}</button>
                      </form>
                    ) : (
                      <>
                        <button type="button" disabled={locked} onClick={() => { setRenaming({ id: profile.id, name: profile.name }); setError(""); }} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink hover:underline disabled:opacity-50" title={t("settings.profiles.rename")}>{profile.name}</button>
                        <button type="button" onClick={() => void remove(profile)} disabled={locked || Boolean(blocked)} title={blocked ?? t("settings.profiles.deleteTitle")} aria-label={`${t("common.delete")} ${profile.name}`} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"><Trash2 size={13} />{t("common.delete")}</button>
                      </>
                    )}
                  </div>
                  <p className="break-words pl-6 text-[11px] text-ink-secondary">{users.length ? t("settings.profiles.usedBy", { names: users.join(", ") }) : t("settings.profiles.notInUse")}</p>
                </div>
              );
            })}
          </div>
        </div>
      </details>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
