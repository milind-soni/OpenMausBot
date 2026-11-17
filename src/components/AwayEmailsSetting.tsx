import { useEffect, useId, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { Switch } from "./SettingsPrimitives";

/** Settings → General on a Team Cloud (a row of Account, or in Profile): the person's own "Email me when I'm away"
 * (GET/PUT /api/me/away-emails). Nothing off a team. */
export function AwayEmailsSetting({ row = false }: { row?: boolean }) {
  const team = Boolean(useStore().state.config?.team);
  const [on, setOn] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const label = useId();
  useEffect(() => {
    if (!team) return;
    let active = true;
    void api<{ on: boolean }>("/api/me/away-emails", { timeoutMs: 10_000 }).then((answer) => { if (active) setOn(answer.on); }, () => {});
    return () => { active = false; };
  }, [team]);
  const change = (next: boolean) => {
    const before = on;
    setOn(next);
    setFailed(false);
    void api<{ on: boolean }>("/api/me/away-emails", { method: "PUT", body: JSON.stringify({ on: next }), timeoutMs: 10_000 })
      .then((answer) => setOn(answer.on), () => { setOn(before); setFailed(true); });
  };
  if (!team || on === null) return null;
  return (
    <div className={row ? "flex flex-col gap-1 px-4 py-[13px]" : "flex flex-col gap-1"}>
      <div className="flex items-center justify-between gap-3">
        <span id={label} className="text-[14px] text-ink">{t("settings.profile.awayEmails")}</span>
        <Switch aria-labelledby={label} checked={on} onClick={() => change(!on)} />
      </div>
      <div className="text-[12px] text-ink-secondary">{t("settings.profile.awayEmailsHelp")}</div>
      {failed && <div role="alert" className="text-[12px] text-danger">{t("settings.profile.awayEmailsError")}</div>}
    </div>
  );
}
