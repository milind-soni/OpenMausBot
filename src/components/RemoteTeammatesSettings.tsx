import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { SETTINGS_INPUT, SettingRow, SettingsEmptyRow, SettingsField, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { SettingsSkeletonRows } from "./settings/SettingsStates";

/** A teammate on another server as the server lists it (server/remote-teammates.ts): never its key. */
interface RemoteTeammate {
  id: string;
  name: string;
  base: string;
  botId: string;
}

type RemoteCheck = { ok: true } | { ok: false; problem: string };

const PROBLEM_TEXT: Record<string, LocaleKey> = {
  unreachable: "settings.remoteTeammates.unreachable",
  wrong_key: "settings.remoteTeammates.wrongKey",
  refused: "settings.remoteTeammates.refused",
  busy: "settings.remoteTeammates.busy",
  rate_limited: "settings.remoteTeammates.busy",
};

/** What Test shows: Connected, or why the other server gave no answer to use. */
function remoteCheckText(result: RemoteCheck): string {
  return result.ok ? t("settings.remoteTeammates.connected") : t(Object.hasOwn(PROBLEM_TEXT, result.problem) ? PROBLEM_TEXT[result.problem] : "settings.remoteTeammates.badAnswer");
}

const failure = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : t("settings.remoteTeammates.failed"));

interface Draft { name: string; address: string; botId: string; key: string }

/** `saving` is the card's: the form can't be closed while an add is on its way, or its answer would close a newer draft. */
function AddTeammateForm({ onAdded, saving, setSaving }: { onAdded: (teammate: RemoteTeammate) => void; saving: boolean; setSaving: (saving: boolean) => void }) {
  const [draft, setDraft] = useState<Draft>({ name: "", address: "", botId: "", key: "" });
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof Draft) => ({
    value: draft[key],
    disabled: saving,
    spellCheck: false,
    autoCapitalize: "none",
    autoCorrect: "off",
    className: SETTINGS_INPUT,
    onChange: (event: { target: { value: string } }) => { setDraft((current) => ({ ...current, [key]: event.target.value })); setError(null); },
  });
  const ready = Boolean(draft.name.trim() && draft.address.trim() && draft.key.trim());

  const save = async () => {
    if (saving || !ready) return;
    setSaving(true);
    setError(null);
    try {
      const { teammate } = await api<{ teammate: RemoteTeammate }>("/api/remote-teammates", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          address: draft.address.trim(),
          ...(draft.botId.trim() ? { botId: draft.botId.trim() } : {}),
          key: draft.key.trim(),
        }),
      });
      onAdded(teammate);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-2 px-4 pb-4 pt-3">
      <SettingsField label={t("settings.remoteTeammates.name")}>
        <input {...field("name")} maxLength={80} autoFocus aria-label={t("settings.remoteTeammates.name")} />
      </SettingsField>
      <SettingsField label={t("settings.remoteTeammates.address")} hint={t("settings.remoteTeammates.addressHint")}>
        <input {...field("address")} maxLength={500} placeholder="https://bots.example.com" aria-label={t("settings.remoteTeammates.address")} />
      </SettingsField>
      <SettingsField label={t("settings.remoteTeammates.botId")}>
        <input {...field("botId")} maxLength={128} aria-label={t("settings.remoteTeammates.botId")} />
      </SettingsField>
      <SettingsField label={t("settings.remoteTeammates.key")}
        hint={error ? <span role="alert" className="text-danger">{error}</span> : t("settings.remoteTeammates.keyHint")}>
        <input {...field("key")} type="password" autoComplete="new-password" maxLength={200} placeholder="bak_…" aria-label={t("settings.remoteTeammates.key")} />
      </SettingsField>
      <div className="flex items-center justify-end gap-2" data-settings-form-foot="">
        <button type="submit" disabled={saving || !ready} className="ui-button ui-button-md ui-button-primary rounded-full">
          {t(saving ? "settings.remoteTeammates.adding" : "settings.remoteTeammates.save")}
        </button>
      </div>
    </form>
  );
}

function TeammateRow({ teammate, onRemoved }: { teammate: RemoteTeammate; onRemoved: (id: string) => void }) {
  const [busy, setBusy] = useState<"testing" | "removing" | null>(null);
  const [said, setSaid] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const path = `/api/remote-teammates/${encodeURIComponent(teammate.id)}`;

  const test = async () => {
    setBusy("testing");
    setSaid(null);
    try {
      const result = await api<RemoteCheck>(`${path}/check`, { method: "POST" });
      setSaid({ text: remoteCheckText(result), ok: result.ok });
    } catch (cause) {
      setSaid({ text: failure(cause), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("removing");
    setSaid(null);
    try {
      await api(path, { method: "DELETE" });
      onRemoved(teammate.id);
    } catch (cause) {
      setConfirming(false);
      setSaid({ text: failure(cause), ok: false });
      setBusy(null);
    }
  };

  return (
    <>
      <SettingRow title={teammate.name}
        subtitle={<span className="break-all">{teammate.botId} · {teammate.base}</span>}
        message={said ? <span role={said.ok ? "status" : "alert"} className={said.ok ? "text-success" : "text-danger"}>{said.text}</span> : undefined}>
        <div className="flex items-center gap-2">
          <button type="button" className="ui-button" disabled={busy !== null} onClick={() => void test()}>
            {t(busy === "testing" ? "settings.remoteTeammates.testing" : "settings.remoteTeammates.test")}
          </button>
          <button type="button" className="settings-quiet cursor-pointer" data-danger="" disabled={busy !== null}
            aria-label={t("settings.remoteTeammates.removeNamed", { name: teammate.name })} onClick={() => setConfirming(true)}>
            {t("settings.remoteTeammates.remove")}
          </button>
        </div>
      </SettingRow>
      <ConfirmDialog open={confirming} title={t("settings.remoteTeammates.removeTitle", { name: teammate.name })}
        body={t("settings.remoteTeammates.removeBody")} confirmLabel={t("settings.remoteTeammates.remove")} pending={busy === "removing"}
        onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />
    </>
  );
}

/** Settings → You and your bots: bots on another server this server's bots may hand work to, each with its Bot API key.
 * Admin only, as the routes are. */
export function RemoteTeammatesSettings() {
  const [teammates, setTeammates] = useState<RemoteTeammate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Each Try again after a failed load reads the list once more. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ teammates: RemoteTeammate[] }>("/api/remote-teammates", { signal: controller.signal })
      .then((loaded) => { if (!controller.signal.aborted) setTeammates(loaded.teammates); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(failure(cause)); });
    return () => controller.abort();
  }, [attempt]);

  return (
    <SettingsGroup label={t("settings.remoteTeammates.title")} block="remote-teammates">
      <SettingsRows>
        {!teammates && !error && <SettingsSkeletonRows />}
        {error && <SettingsEmptyRow>
          <span className="flex items-center justify-between gap-3">
            <span role="alert" className="text-danger">{error}</span>
            <button type="button" className="ui-button" onClick={() => { setError(null); setAttempt((count) => count + 1); }}>{t("common.tryAgain")}</button>
          </span>
        </SettingsEmptyRow>}
        {teammates?.length === 0 && <SettingsEmptyRow>{t("settings.remoteTeammates.empty")}</SettingsEmptyRow>}
        {teammates?.map((teammate) => (
          <TeammateRow key={teammate.id} teammate={teammate}
            onRemoved={(id) => { setTeammates((current) => current?.filter((one) => one.id !== id) ?? null); setNotice(null); }} />
        ))}
        {teammates && <>
          <SettingRow title={t("settings.remoteTeammates.add")} subtitle={t("settings.remoteTeammates.line")}
            message={!open && notice ? <span role="status">{notice}</span> : undefined}>
            <button type="button" className="ui-button" aria-expanded={open} disabled={saving} onClick={() => { setOpen(!open); setNotice(null); }}>
              {t(open ? "common.close" : "settings.remoteTeammates.addButton")}
            </button>
          </SettingRow>
          {open && <AddTeammateForm saving={saving} setSaving={setSaving} onAdded={(teammate) => {
            setTeammates((current) => [...(current ?? []), teammate]);
            setOpen(false);
            setNotice(t("settings.remoteTeammates.added", { name: teammate.name }));
          }} />}
        </>}
      </SettingsRows>
    </SettingsGroup>
  );
}
