import { useEffect, useId, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { SETTINGS_INPUT } from "./SettingsPrimitives";

interface OwnName { displayName: string; shownAs: string }

/** Settings → Bots → About you on a self-hosted server: the name a signed-in person goes by there (GET/PUT /api/me).
 * Nothing on a team, or on the owner's own computer, which goes by the profile's name. */
export function DisplayNameSetting() {
  const team = Boolean(useStore().state.config?.team);
  const [own, setOwn] = useState<OwnName | null>(null);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const label = useId();
  useEffect(() => {
    if (team) return;
    let active = true;
    void api<OwnName>("/api/me", { timeoutMs: 10_000 }).then((answer) => {
      if (!active || typeof answer?.displayName !== "string") return;
      setOwn(answer);
      setDraft(answer.displayName);
    }, () => {});
    return () => { active = false; };
  }, [team]);
  if (team || !own) return null;
  const save = () => {
    if (draft.trim() === own.displayName) return;
    setFailed(false);
    void api<OwnName>("/api/me", { method: "PUT", body: JSON.stringify({ displayName: draft }), timeoutMs: 10_000 })
      .then((answer) => { setOwn(answer); setDraft(answer.displayName); }, () => setFailed(true));
  };
  return (
    <div className="flex flex-col gap-1 px-4 py-[13px]">
      <label id={label} htmlFor={`${label}-input`} className="text-[14px] text-ink">{t("settings.profile.displayName")}</label>
      <input id={`${label}-input`} aria-labelledby={label} value={draft} maxLength={60} placeholder={own.shownAs}
        onChange={(event) => setDraft(event.target.value)} onBlur={save} className={SETTINGS_INPUT} />
      <div className="text-[12px] text-ink-secondary">{t("settings.profile.displayNameHelp")}</div>
      {failed && <div role="alert" className="text-[12px] text-danger">{t("settings.profile.displayNameError")}</div>}
    </div>
  );
}
